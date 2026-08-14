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

  /** Endpoint 10. Which documents are on file. The upload path is 8 and 9,
      through a presigned file-store URL: document bytes are PII and never go
      through this function's memory or into any log. */
  router.get('/provider/application/documents', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    let rows = [];
    try {
      rows = await datastore.queryAll(
        req.catalyst, DOCUMENTS, ['document_id', 'org_id', 'kind', 'filename', 'review_state', 'uploaded_at'],
        `org_id = ${datastore.lit(context.orgId)}`
      );
    } catch {
      rows = [];
    }
    const out = {};
    rows.forEach((r) => { out[r.kind] = { filename: r.filename, reviewState: r.review_state }; });
    res.status(200).json({ ok: true, serverTime: Date.now(), documents: out });
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
