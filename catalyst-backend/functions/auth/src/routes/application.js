'use strict';

/**
 * The founding partner application: five tracks, one clock.
 *
 * WHY FIVE ROWS AND NOT FIVE COLUMNS. The application screen says "each piece
 * starts its own check the moment it lands". With five booleans on the
 * application row that sentence is decoration: a submitted document and a
 * cleared one look identical, and a partner whose registration was flagged
 * sees "under review" forever with no idea which number did not match. With
 * one `application_tasks` row per piece it is literally true, partial
 * completion is queryable, and a reviewer can clear coverage while
 * registration is still with the register.
 *
 * THE CLOCK STARTS AT COMPLETION. decision_due_at is stamped when the fifth
 * task leaves 'empty', not when a reviewer picks the application up. That is
 * what makes "the clock starts when your application completes, not when we
 * get around to it" a true sentence rather than a promise, and it is why
 * submit() is idempotent: it writes submitted_at and decision_due_at only if
 * unset, so two calls from a double click or a re-render cannot start two
 * clocks with two different deadlines.
 *
 * THE APPROVAL INVARIANT IS UNTOUCHED. Nothing here writes provider_orgs
 * .approval_status. Submitting an application does not approve it; only
 * /admin/providers/:orgId/approve does, on behalf of a named human. A partner
 * who could complete their own application into 'approved' could bid.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const datastore = require('../lib/datastore');
const audit = require('../lib/audit');
/* requirePartner, not requireProvider: every handler here destructures
   `{ context }` and reads context.orgId. requireProvider returns the bare user,
   so importing it made all seven routes throw on context.orgId and answer 500.
   The two guards look interchangeable and are not; lib/guards.js explains. */
const { requirePartner: guardPartner } = require('../lib/guards');
const { wrap, badRequest, AppError } = require('../lib/errors');

const APPLICATIONS = 'provider_applications';
const TASKS = 'application_tasks';
const DOCUMENTS = 'provider_documents';
const REFERENCES = 'provider_references';

/** The five tracks. Order is the order they appear on the checklist. */
const TASK_KEYS = ['coverage', 'registration', 'documents', 'agreement', 'reference'];

/** Per-task check state. 'flagged' is not a failed application, it is one
    piece needing another look, which is why info_needed exists below. */
const TASK_STATES = new Set(['empty', 'submitted', 'verifying', 'cleared', 'flagged']);

const requirePartner = (req) => guardPartner(req, 'a /provider/application route');

const str = (v, max) => {
  const s = String(v == null ? '' : v).trim().slice(0, max);
  return s || null;
};

const DAY_MS = 86400000;

/* ------------------------------------------------------------------ *
 * documents
 *
 * WHY THE BYTES COME THROUGH THIS FUNCTION AFTER ALL. create-tables.md said
 * uploads would go to the file store "through a presigned URL", which is the
 * right shape and is not available: zcatalyst-sdk-node 2.5 exposes
 * createFolder / uploadFile / downloadFile and nothing that mints a signed
 * URL, so there is nothing to presign. What presign was buying, the file never
 * touching this function, cannot be bought here; what it was protecting
 * against, a 10 MB body landing in the same parser as every 200-byte JSON
 * call, is bought instead by express.raw scoped to this one route. The other
 * sixty-six calls keep the 64kb limit in app.js.
 *
 * NOTHING ABOUT THE FILE IS LOGGED. Not the filename, not the size, not the
 * mime. app.js logs method, path and status only, and the query string that
 * carries the filename is not part of req.path. Keep it that way.
 */

const DOC_KINDS = new Set(['crtc_registration', 'business_registration', 'insurance', 'other']);

/** The two the application actually requires. `insurance` and `other` are
    accepted by the column and are not part of the five-task checklist. */
const REQUIRED_DOC_KINDS = ['crtc_registration', 'business_registration'];

const MAX_DOC_BYTES = 10 * 1024 * 1024;

/** Extension by mime, so the stored name never carries the partner's own
    string. A filename is user input and it is about to become a path. */
const DOC_MIME = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
};

/** Kept for display only, and stripped to a leaf with no path separators. */
function safeName(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\\/]+/g, ' ').trim().slice(0, 255);
  return s || 'document';
}

function docsFolder(req) {
  const cfg = req.app.get('cfg');
  if (!cfg.FEATURES.docstore) {
    /* Fails closed and says which name is missing, rather than accepting 10 MB
       and dropping it. A partner told "attached" about a file nobody has is
       the worst outcome available here. */
    throw new AppError('NOT_IMPLEMENTED',
      'Document upload is not switched on in this environment yet. Email partners@whollar.ca and we will take them by reply.', {
        logDetail: 'FILESTORE_DOCS_FOLDER_ID is unset, so the docstore feature is off',
      });
  }
  return req.catalyst.filestore().folder(cfg.FILESTORE_DOCS_FOLDER_ID);
}

/**
 * Buffer -> file store, via a temp file.
 *
 * uploadFile() takes a ReadStream and nothing else, so the buffer goes to
 * os.tmpdir() first. The unlink is in a finally: a function container is
 * reused between invocations, and a leaked 10 MB temp file is a leaked 10 MB
 * temp file on every one of them.
 */
async function putFile(req, storedName, buffer) {
  const folder = docsFolder(req);
  const tmp = path.join(os.tmpdir(), `${crypto.randomUUID()}-${storedName}`);
  await fs.promises.writeFile(tmp, buffer);
  try {
    const uploaded = await folder.uploadFile({ code: fs.createReadStream(tmp), name: storedName });
    return String(uploaded.id);
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

/** Best effort. A file store object we failed to delete is a retention problem
    for the sweeper, not a reason to refuse the partner's replacement. */
async function dropFile(req, ref) {
  if (!ref) return;
  try {
    await docsFolder(req).deleteFile(ref);
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn', message: 'file store delete failed', ref,
      detail: String((err && err.message) || err).slice(0, 200),
    }));
  }
}

async function documentRows(catalystApp, orgId) {
  try {
    return await datastore.queryAll(
      catalystApp, DOCUMENTS,
      ['ROWID', 'document_key', 'document_id', 'org_id', 'kind', 'file_store_ref',
        'filename', 'bytes', 'mime', 'review_state', 'uploaded_at'],
      `org_id = ${datastore.lit(orgId)}`
    );
  } catch {
    return [];
  }
}

/** The wire shape. `file_store_ref` never crosses it: it is the one field that
    would let a partner ask the file store for someone else's object. */
function publicDocuments(rows) {
  const out = {};
  (rows || []).forEach((r) => {
    out[r.kind] = {
      filename: r.filename || null,
      bytes: r.bytes == null ? null : Number(r.bytes),
      mime: r.mime || null,
      reviewState: r.review_state || 'pending',
      uploadedAt: epoch(r.uploaded_at),
    };
  });
  return out;
}

/** The documents task is done when BOTH required documents are on file, and
    not before: one of two attached is not a piece a reviewer can read. */
async function syncDocumentsTask(req, orgId, rows) {
  const have = new Set((rows || []).map((r) => r.kind));
  const complete = REQUIRED_DOC_KINDS.every((k) => have.has(k));
  await setTask(req.catalyst, orgId, 'documents', complete ? 'submitted' : 'empty');
}

/**
 * A stored timestamp as epoch milliseconds, for the wire.
 *
 * NEVER the raw column. Catalyst returns `YYYY-MM-DD HH:MM:SS` in UTC with no
 * zone marker, so new Date() on it in a browser shifts by the reader's offset:
 * lib/datastore.js documents that at length, and handing the string to a client
 * reproduces there the exact bug the server already fixed. An integer cannot be
 * misread, which matters most for decision_due_at, the one date on the
 * application screen a partner is entitled to trust.
 */
function epoch(value) {
  const d = datastore.fromDb(value);
  return d ? d.getTime() : null;
}

/* ------------------------------------------------------------------ *
 * reads
 * ------------------------------------------------------------------ */

async function findApplication(catalystApp, orgId) {
  try {
    return await datastore.findBy(
      catalystApp, APPLICATIONS, 'org_id', orgId,
      ['ROWID', 'application_id', 'org_id', 'state', 'legal_name', 'operating_name',
        'crtc_registration', 'business_number', 'submitted_at', 'decision_due_at',
        'decided_at', 'decision_note', 'review_note', 'reapply_after', 'source', 'role_route']
    );
  } catch {
    return null;
  }
}

async function taskRows(catalystApp, orgId) {
  try {
    return await datastore.queryAll(
      catalystApp, TASKS,
      ['ROWID', 'task_key', 'org_id', 'state', 'completed_at', 'checked_at', 'note'],
      `org_id = ${datastore.lit(orgId)}`
    );
  } catch {
    return null;
  }
}

/** Every task, including the ones with no row yet, so the client never has to
    guess whether a missing key means 'empty' or means 'the table is down'. */
function tasksFrom(rows) {
  const out = {};
  TASK_KEYS.forEach((k) => { out[k] = 'empty'; });
  (rows || []).forEach((r) => {
    if (TASK_KEYS.indexOf(r.task_key) >= 0 && TASK_STATES.has(r.state)) out[r.task_key] = r.state;
  });
  return out;
}

/**
 * The application's state is DERIVED, never stored as a mutable label that a
 * client could set. Same reasoning as the campaign stage: a state written by
 * whoever spoke last is a state nobody can reason about.
 */
function stateOf(app, tasks) {
  if (app && app.decided_at && app.state === 'rejected') return 'rejected';
  if (app && app.decided_at && app.state === 'approved') return 'approved';
  if (TASK_KEYS.some((k) => tasks[k] === 'flagged')) return 'info_needed';
  if (!TASK_KEYS.every((k) => tasks[k] !== 'empty')) {
    return TASK_KEYS.some((k) => tasks[k] !== 'empty') ? 'draft' : 'draft';
  }
  return app && app.submitted_at ? 'under_review' : 'submitted';
}

function publicApplication(app, tasks) {
  return {
    ok: true,
    serverTime: Date.now(),
    state: stateOf(app, tasks),
    tasks,
    legalName: (app && app.legal_name) || null,
    operatingName: (app && app.operating_name) || null,
    crtcRegistration: (app && app.crtc_registration) || null,
    businessNumber: (app && app.business_number) || null,
    submittedAt: epoch(app && app.submitted_at),
    decisionDueAt: epoch(app && app.decision_due_at),
    decidedAt: epoch(app && app.decided_at),
    reapplyAfter: epoch(app && app.reapply_after),
    decisionNote: (app && app.decision_note) || null,
    reviewNote: (app && app.review_note) || null,
  };
}

/* ------------------------------------------------------------------ *
 * writes
 * ------------------------------------------------------------------ */

/** Create the application row on first write, so a partner who never starts
    one never gets a row. */
async function ensureApplication(catalystApp, orgId) {
  const existing = await findApplication(catalystApp, orgId);
  if (existing) return existing;
  try {
    await datastore.insertRow(catalystApp, APPLICATIONS, {
      application_id: `app-${orgId}`.slice(0, 64),
      org_id: orgId,
      state: 'draft',
      source: 'self_serve',
      updated_at: datastore.nowDb(),
    });
  } catch (err) {
    throw new AppError('SERVER_ERROR',
      'Your application could not be saved just now. Please try again shortly.', {
        logDetail: `provider_applications insert failed: ${String((err && err.message) || err).slice(0, 200)}`,
      });
  }
  return findApplication(catalystApp, orgId);
}

/**
 * Move one task, and only forward within a submission.
 *
 * Upsert on `task_key_org`, which is the flattened composite: Catalyst's
 * unique constraint is per column, so a (org, task) pair has to be one column.
 * The same pattern provider_bids and provider_coverage already use.
 */
async function setTask(catalystApp, orgId, key, state, note) {
  if (TASK_KEYS.indexOf(key) < 0) throw badRequest('Unknown application task.');
  if (!TASK_STATES.has(state)) throw badRequest('Unknown task state.');

  const composite = `${orgId}:${key}`.slice(0, 200);
  const fields = {
    state,
    note: note || null,
    completed_at: state === 'empty' ? null : datastore.nowDb(),
    updated_at: datastore.nowDb(),
  };
  try {
    const existing = await datastore.findBy(catalystApp, TASKS, 'task_key_org', composite, ['ROWID']);
    if (existing) {
      await datastore.updateRow(catalystApp, TASKS, { ROWID: existing.ROWID, ...fields });
    } else {
      await datastore.insertRow(catalystApp, TASKS, {
        task_key_org: composite, org_id: orgId, task_key: key, ...fields,
      });
    }
  } catch (err) {
    throw new AppError('SERVER_ERROR',
      'That did not save. Please try again shortly.', {
        logDetail: `application_tasks write failed for ${key}: ${String((err && err.message) || err).slice(0, 200)}`,
      });
  }
}

/**
 * Stamp the clock, once.
 *
 * IDEMPOTENT BY CONTRACT, and the console relies on it: the moment the fifth
 * task lands the client calls this, and a re-render or a double click calls it
 * again. Writing submitted_at unconditionally would move the deadline every
 * time, which is the one number on that screen a partner is entitled to trust.
 */
async function stampSubmission(catalystApp, app) {
  if (!app || app.submitted_at) return false;
  await datastore.updateRow(catalystApp, APPLICATIONS, {
    ROWID: app.ROWID,
    state: 'submitted',
    submitted_at: datastore.nowDb(),
    /* 48 hours. Business-hours awareness is deliberate later work: it needs a
       holiday calendar, and shipping a naive one that promises Tuesday over a
       long weekend is worse than promising 48 hours and meaning it. */
    decision_due_at: datastore.inMsDb(2 * DAY_MS),
    updated_at: datastore.nowDb(),
  });
  return true;
}

/* ------------------------------------------------------------------ *
 * routes
 * ------------------------------------------------------------------ */

function mount(router) {
  /** Read the whole application. Endpoint 6. */
  router.get('/provider/application', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const app = await findApplication(req.catalyst, context.orgId);
    const rows = await taskRows(req.catalyst, context.orgId);
    if (app === null && rows === null) {
      throw new AppError('SERVER_ERROR', 'Your application is not available right now. Please try again shortly.');
    }
    res.status(200).json(publicApplication(app, tasksFrom(rows)));
  }));

  /** Endpoint 7. Legal entity, CRTC registration, business number. */
  router.patch('/provider/application/registration', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    const body = req.body || {};

    const legalName = str(body.legalName, 160);
    const crtc = str(body.crtcRegistration, 64);
    if (!legalName || !crtc) {
      throw badRequest('Legal entity and CRTC registration are the two we need.');
    }

    const app = await ensureApplication(req.catalyst, context.orgId);
    await datastore.updateRow(req.catalyst, APPLICATIONS, {
      ROWID: app.ROWID,
      legal_name: legalName,
      operating_name: str(body.operatingName, 160),
      crtc_registration: crtc,
      business_number: str(body.businessNumber, 32),
      updated_at: datastore.nowDb(),
    });
    /* 'submitted', not 'cleared'. The console shows "In the queue" until a
       reviewer checks it against the public register: a partner clearing their
       own registration check would make the whole vetting story decorative. */
    await setTask(req.catalyst, context.orgId, 'registration', 'submitted');

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.application.registration', outcome: 'success',
      userId: user.user_id, email: user.email_normalized,
      detail: { org_id: context.orgId },
    });

    res.status(200).json(await reread(req, context.orgId));
  }));

  /** Endpoint 10. Which documents are on file. Metadata only: the file store
      reference is deliberately not on the wire, because it is the one field
      that would let a partner ask the store for an object that is not theirs. */
  router.get('/provider/application/documents', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const rows = await documentRows(req.catalyst, context.orgId);
    res.status(200).json({
      ok: true,
      serverTime: Date.now(),
      documents: publicDocuments(rows),
      maxBytes: MAX_DOC_BYTES,
      accept: Object.keys(DOC_MIME),
    });
  }));

  /**
   * Endpoint 9. The document itself.
   *
   * Raw bytes with kind and filename in the query string, rather than
   * multipart: parsing multipart needs a dependency in a function whose entire
   * body-parsing surface is express.json, and the browser has the File object
   * already. The Content-Type is the file's own, which is what makes the mime
   * allowlist below a check on what was actually sent rather than on what a
   * form field claimed.
   *
   * Replacing is the same call: the old file store object is deleted after the
   * new one lands, so a failed upload never leaves the partner with nothing.
   */
  const rawBody = express.raw({ type: () => true, limit: MAX_DOC_BYTES });
  const rawDoc = (req, res, next) => rawBody(req, res, (err) => {
    if (!err) return next();
    /* The parser's own 413 would reach the client as a bare SERVER_ERROR with
       a request id, which tells a partner nothing they can act on. */
    if (err.type === 'entity.too.large') {
      return next(badRequest('That file is over the 10 MB limit. Please send a smaller scan.'));
    }
    return next(badRequest('That upload did not arrive in one piece. Please try again.'));
  });

  router.post('/provider/application/documents', rawDoc, wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);

    const kind = str(req.query.kind, 32);
    if (!kind || !DOC_KINDS.has(kind)) throw badRequest('That is not a document we ask for.');

    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = DOC_MIME[mime];
    if (!ext) throw badRequest('PDF or image only. That file type is not one we can read.');

    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer || !buffer.length) throw badRequest('That file arrived empty.');
    if (buffer.length > MAX_DOC_BYTES) throw badRequest('That file is over the 10 MB limit.');

    const filename = safeName(req.query.filename);
    await ensureApplication(req.catalyst, context.orgId);

    /* Named from the org and the kind, never from the partner's filename: the
       name becomes a path in the file store, and two partners who both upload
       "registration.pdf" must not collide. */
    const storedName = `${context.orgId}-${kind}-${crypto.randomUUID()}.${ext}`;
    const ref = await putFile(req, storedName, buffer);

    const key = `${context.orgId}:${kind}`.slice(0, 200);
    const cfg = req.app.get('cfg');
    const fields = {
      kind,
      file_store_ref: ref,
      filename,
      bytes: buffer.length,
      mime,
      uploaded_by: user.user_id,
      uploaded_at: datastore.nowDb(),
      /* 'pending', always. A partner cannot accept their own document any more
         than they can clear their own registration check. */
      review_state: 'pending',
      retention_delete_after: datastore.inMsDb(cfg.DOC_RETENTION_DAYS * DAY_MS),
      updated_at: datastore.nowDb(),
    };

    let previousRef = null;
    try {
      const existing = await datastore.findBy(req.catalyst, DOCUMENTS, 'document_key', key,
        ['ROWID', 'file_store_ref']);
      if (existing) {
        previousRef = existing.file_store_ref || null;
        await datastore.updateRow(req.catalyst, DOCUMENTS, { ROWID: existing.ROWID, ...fields });
      } else {
        await datastore.insertRow(req.catalyst, DOCUMENTS, {
          document_key: key,
          document_id: `doc-${crypto.randomUUID()}`.slice(0, 64),
          org_id: context.orgId,
          ...fields,
        });
      }
    } catch (err) {
      /* The row is the record. A file in the store that no row points at is
         unreachable and would sit there until retention, so drop it now. */
      await dropFile(req, ref);
      throw new AppError('SERVER_ERROR', 'That did not save. Please try again shortly.', {
        logDetail: `provider_documents write failed: ${String((err && err.message) || err).slice(0, 200)}`,
      });
    }

    /* After the row, never before: a replacement whose row write fails must
       still have the old file to fall back on. */
    if (previousRef && previousRef !== ref) await dropFile(req, previousRef);

    const rows = await documentRows(req.catalyst, context.orgId);
    await syncDocumentsTask(req, context.orgId, rows);

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.application.document.upload', outcome: 'success',
      userId: user.user_id, email: user.email_normalized,
      /* kind and size only. The filename is the partner's own text and has no
         business in an audit row. */
      detail: { org_id: context.orgId, kind, bytes: buffer.length, replaced: !!previousRef },
    });

    res.status(200).json({
      ok: true,
      serverTime: Date.now(),
      documents: publicDocuments(rows),
      application: await reread(req, context.orgId),
    });
  }));

  /**
   * Endpoint 11. Remove one document.
   *
   * Refused once the application is submitted: removing a document a reviewer
   * is reading would drop the task back to empty and un-complete an
   * application whose 48 hour clock is already running. Replacing is always
   * allowed, and is what a partner who attached the wrong file actually wants.
   */
  router.delete('/provider/application/documents/:kind', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    const kind = str(req.params.kind, 32);
    if (!kind || !DOC_KINDS.has(kind)) throw badRequest('That is not a document we ask for.');

    const app = await findApplication(req.catalyst, context.orgId);
    if (app && app.submitted_at && !app.decided_at) {
      throw new AppError('CONFLICT',
        'Your application is with a reviewer. You can replace this document, but not remove it.');
    }

    const key = `${context.orgId}:${kind}`.slice(0, 200);
    const existing = await datastore.findBy(req.catalyst, DOCUMENTS, 'document_key', key,
      ['ROWID', 'file_store_ref']);
    if (!existing) throw new AppError('NOT_FOUND', 'There is no such document on your file.');

    try {
      await datastore.deleteRow(req.catalyst, DOCUMENTS, existing.ROWID);
    } catch (err) {
      throw new AppError('SERVER_ERROR', 'That did not remove. Please try again shortly.', {
        logDetail: `provider_documents delete failed: ${String((err && err.message) || err).slice(0, 200)}`,
      });
    }
    await dropFile(req, existing.file_store_ref);

    const rows = await documentRows(req.catalyst, context.orgId);
    await syncDocumentsTask(req, context.orgId, rows);

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.application.document.delete', outcome: 'success',
      userId: user.user_id, email: user.email_normalized,
      detail: { org_id: context.orgId, kind },
    });

    res.status(200).json({
      ok: true,
      serverTime: Date.now(),
      documents: publicDocuments(rows),
      application: await reread(req, context.orgId),
    });
  }));

  /** Endpoint 12. The application-stage agreement, with the consent text hash
      so what was agreed to is provable later rather than inferred from a
      version number that may since have been edited. */
  router.post('/provider/application/agreement', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    if ((req.body || {}).accepted !== true) throw badRequest('Tick the box to sign.');

    await ensureApplication(req.catalyst, context.orgId);
    await setTask(req.catalyst, context.orgId, 'agreement', 'cleared', str((req.body || {}).consentHash, 64));

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.application.agreement', outcome: 'success',
      userId: user.user_id, email: user.email_normalized,
      detail: { org_id: context.orgId, agreement: 'application_terms' },
    });

    res.status(200).json(await reread(req, context.orgId));
  }));

  /** Endpoint 13. One reference, contacted once, never added to any list. */
  router.post('/provider/application/reference', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    const body = req.body || {};
    const nameRole = str(body.nameRole, 160);
    const email = str(body.email, 255);
    if (!nameRole || !email) throw badRequest('Name and email, then we are set.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('That email does not look right.');

    await ensureApplication(req.catalyst, context.orgId);
    const key = `${context.orgId}:ref`.slice(0, 200);
    try {
      const existing = await datastore.findBy(req.catalyst, REFERENCES, 'reference_key', key, ['ROWID']);
      const fields = {
        name_role: nameRole,
        email,
        response_state: 'pending',
        updated_at: datastore.nowDb(),
      };
      if (existing) await datastore.updateRow(req.catalyst, REFERENCES, { ROWID: existing.ROWID, ...fields });
      else await datastore.insertRow(req.catalyst, REFERENCES, { reference_key: key, org_id: context.orgId, ...fields });
    } catch (err) {
      throw new AppError('SERVER_ERROR', 'That did not save. Please try again shortly.', {
        logDetail: `provider_references write failed: ${String((err && err.message) || err).slice(0, 200)}`,
      });
    }
    await setTask(req.catalyst, context.orgId, 'reference', 'submitted');

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.application.reference', outcome: 'success',
      userId: user.user_id, email: user.email_normalized,
      detail: { org_id: context.orgId },
    });

    res.status(200).json(await reread(req, context.orgId));
  }));

  /**
   * Endpoint 14. Idempotent: stamps the clock only if unset.
   *
   * Refuses while any task is still empty, because the 48 hours is a promise
   * about a complete application and a partial one would start a clock nobody
   * can meet.
   */
  router.post('/provider/application/submit', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    const rows = await taskRows(req.catalyst, context.orgId);
    const tasks = tasksFrom(rows);
    const missing = TASK_KEYS.filter((k) => tasks[k] === 'empty');
    if (missing.length) {
      throw new AppError('CONFLICT',
        `Still to come: ${missing.join(', ')}. The 48 hour clock starts when all five are in.`);
    }

    const app = await ensureApplication(req.catalyst, context.orgId);
    const already = !!(app && app.submitted_at);
    await stampSubmission(req.catalyst, app);

    if (!already) {
      audit.recordAsync(req.catalyst, req, {
        type: 'provider.application.submit', outcome: 'success',
        userId: user.user_id, email: user.email_normalized,
        detail: { org_id: context.orgId },
      });
    }

    res.status(200).json(await reread(req, context.orgId));
  }));

  /** Endpoint 15. The review frame's rows, from the task records. */
  router.get('/provider/application/timeline', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const app = await findApplication(req.catalyst, context.orgId);
    const rows = await taskRows(req.catalyst, context.orgId);
    const tasks = tasksFrom(rows);
    res.status(200).json({
      ok: true,
      serverTime: Date.now(),
      state: stateOf(app, tasks),
      tasks,
      steps: (rows || []).map((r) => ({
        key: r.task_key, state: r.state, checkedAt: r.checked_at || null, note: r.note || null,
      })),
    });
  }));

  /** Every write answers with the whole application, so the console never has
      to merge a patch response into what it already had and then disagree with
      the server about the result. */
  async function reread(req, orgId) {
    const app = await findApplication(req.catalyst, orgId);
    const rows = await taskRows(req.catalyst, orgId);
    const tasks = tasksFrom(rows);
    /* Completing the fifth task IS the submission. Doing it here rather than
       waiting for the client's own call means the clock starts even if the tab
       closes on the last keystroke. */
    if (TASK_KEYS.every((k) => tasks[k] !== 'empty') && app && !app.submitted_at) {
      await stampSubmission(req.catalyst, app);
      return publicApplication(await findApplication(req.catalyst, orgId), tasks);
    }
    return publicApplication(app, tasks);
  }
}

module.exports = { mount, APPLICATIONS, TASKS, DOCUMENTS, REFERENCES, TASK_KEYS, TASK_STATES, stateOf, tasksFrom, setTask };
