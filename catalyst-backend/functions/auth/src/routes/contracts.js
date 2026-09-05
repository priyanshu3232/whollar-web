'use strict';

/**
 * Contracts: everything binding, versioned, in one place.
 *
 *   GET  /provider/contracts                the registry, as the console draws it
 *   POST /provider/contracts/terms/accept   accept the standard cohort terms
 *
 * WHAT THIS ROUTE IS AND IS NOT. It is a READ over records other routes own:
 * the approval decision (provider_orgs), the registration on the application,
 * the declared coverage, the sealed bid heads, and the terms acceptance. It
 * owns none of them, and it writes exactly one thing, through lib/terms.js.
 * That matters because the alternative shape, a `contracts` table holding
 * copies, would be a second source of truth for whether an org is approved,
 * and the two would disagree the first time an admin reversed a decision.
 *
 * EVERY SECTION DEGRADES ON ITS OWN. A partner whose bid table is unreadable
 * still gets their agreements, because a registry that answers nothing when
 * one query fails is a registry nobody can use to check the one row they came
 * for. Each read below returns null on failure and the payload says so, rather
 * than reporting a zero that reads as "you have never bid".
 *
 * NO OTHER ORG APPEARS HERE, in any field, including the failure paths.
 */

const datastore = require('../lib/datastore');
const orgs = require('../lib/orgs');
const terms = require('../lib/terms');
const audit = require('../lib/audit');
const crm = require('../lib/crm/outbox');
const bids = require('../lib/bids');
const { ok, ms } = require('../lib/envelope');
const { requirePartner: guardPartner } = require('../lib/guards');
const { wrap, badRequest, forbidden } = require('../lib/errors');
const application = require('./application');

const COVERAGE = 'provider_coverage';

const requirePartner = (req) => guardPartner(req, 'a /provider/contracts route');

/* ------------------------------------------------------------------ *
 * the reads, each failing on its own
 * ------------------------------------------------------------------ */

/** The approval decision, which is what the master services agreement is
    signed at. Never inferred from anything else: lib/guards.js is emphatic
    about this and the registry is not the place to start guessing. */
async function msaRow(catalystApp, context) {
  let org = null;
  try {
    org = await orgs.findById(catalystApp, context.orgId);
  } catch {
    return null;
  }
  const approved = !!(org && org.approval_status === 'approved');
  return {
    state: approved ? 'signed' : 'pending',
    signedAt: approved ? ms(org.approved_at) : null,
  };
}

/** The CRTC registration as the application recorded it, with the reviewer's
    verdict on it. 'cleared' is a person's decision, so it is read rather than
    derived from the number being present. */
async function registrationRow(catalystApp, orgId) {
  let app = null;
  try {
    app = await datastore.findBy(catalystApp, application.APPLICATIONS, 'org_id', orgId,
      ['ROWID', 'org_id', 'crtc_registration', 'business_number']);
  } catch {
    return null;
  }
  let state = 'empty';
  try {
    const rows = await datastore.queryAll(catalystApp, application.TASKS,
      ['task_key', 'state'], `org_id = ${datastore.lit(orgId)}`);
    state = application.tasksFrom(rows).registration || 'empty';
  } catch {
    /* The number without the verdict is still worth showing, and 'empty' is
       the honest label for a verdict we could not read. */
  }
  return { crtc: (app && app.crtc_registration) || null, state };
}

/** The regional schedule is an appendix to the MSA, and its content is the
    coverage table. Names and statuses only: the console links to Coverage for
    the rest rather than restating it here and drifting from it. */
async function scheduleRow(catalystApp, orgId) {
  try {
    const rows = await datastore.queryAll(catalystApp, COVERAGE,
      ['region', 'status'], `org_id = ${datastore.lit(orgId)}`);
    const list = rows || [];
    return {
      declared: list.length,
      active: list.filter((r) => r.status === 'active').length,
      regions: list.map((r) => r.region).filter(Boolean).slice(0, 12),
    };
  } catch {
    return null;
  }
}

/**
 * The sealed bid receipts line.
 *
 * Two numbers, because they answer different questions: `cohorts` is how many
 * auctions this org holds a live bid on, and `sealed` is how many sealed
 * revisions are on record across them. An improvement is a new sealed record,
 * not an edit, so the second number is the one the sentence "every bid you
 * place is binding until its deadline" is actually about.
 */
async function receiptsRow(catalystApp, orgId) {
  try {
    const rows = await datastore.queryAll(catalystApp, bids.BIDS,
      ['bid_key', 'revision_count'], `org_id = ${datastore.lit(orgId)}`);
    const list = rows || [];
    const sealed = list.reduce((t, r) => {
      const n = parseInt(r.revision_count, 10);
      return t + (Number.isFinite(n) && n > 0 ? n : 1);
    }, 0);
    return { cohorts: list.length, sealed };
  } catch {
    /* revision_count arrived with the auction core; a table predating it reads
       without the column rather than not at all. */
    try {
      const rows = await datastore.queryAll(catalystApp, bids.BIDS,
        ['bid_key'], `org_id = ${datastore.lit(orgId)}`);
      return { cohorts: (rows || []).length, sealed: (rows || []).length };
    } catch {
      return null;
    }
  }
}

function mount(router) {
  /**
   * Endpoint 38. The registry.
   *
   * requirePartner, NOT requireApproved: an org under review has a signed
   * application agreement, a declared schedule and a registration on file, and
   * hiding its own records until a human decides is the console telling it
   * nothing exists when it does.
   */
  router.get('/provider/contracts', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const [msa, registration, schedule, receipts, standardTerms] = await Promise.all([
      msaRow(req.catalyst, context),
      registrationRow(req.catalyst, context.orgId),
      scheduleRow(req.catalyst, context.orgId),
      receiptsRow(req.catalyst, context.orgId),
      terms.status(req.catalyst, context.orgId),
    ]);

    return ok(res, {
      terms: standardTerms,
      msa,
      registration,
      schedule,
      receipts,
      /* One flag for the whole payload, so a view can say "some of this could
         not be read" without inspecting five nulls to work out whether the
         partner has no bids or we could not tell. */
      live: !!(msa && registration && schedule && receipts && standardTerms.live),
    });
  }));

  /**
   * Endpoint 39. Accept the standard cohort terms.
   *
   * The org accepts, not the person, and the person is recorded on the row.
   * Viewers are refused for the same reason they are refused a bid: this binds
   * the organisation, and a read-only seat may not.
   */
  router.post('/provider/contracts/terms/accept', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    if (context.role === 'viewer') {
      throw forbidden('Your seat can read the agreements but not accept them. Ask your organisation’s admin.', {
        logDetail: 'viewer tried to accept the cohort terms',
      });
    }

    const body = req.body || {};
    if (body.accepted !== true) throw badRequest('Tick the box to accept.');

    /* The version the partner was LOOKING AT, when the console sends it. If it
       is not the version in force, the page is stale and accepting it would
       record agreement to text nobody displayed. Refusing here rather than
       accepting the current version silently is the difference between a
       provable record and a plausible one. */
    const seen = String(body.version || '').trim();
    const inForce = await terms.currentVersion(req.catalyst);
    if (seen && seen !== inForce) {
      throw badRequest(`The standard cohort terms are now ${inForce}. Reload and read the current version before accepting.`);
    }

    const result = await terms.accept(req.catalyst, req, {
      orgId: context.orgId,
      userId: user.user_id,
      email: user.email_normalized,
      consentHash: String(body.consentHash || '').trim().slice(0, 64) || null,
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.contracts.terms.accept',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: {
        org_id: context.orgId,
        doc_type: terms.DOC_TYPE,
        doc_version: result.version,
        repeat: result.alreadyAccepted,
      },
    });
    /* Only a first acceptance is news. Re-accepting the version already on
       file is the console re-posting on a reload, and a CRM note per reload
       is noise on the one record a person actually reads. */
    if (!result.alreadyAccepted) {
      crm.enqueueAsync(req.catalyst, req, {
        eventType: 'partner.updated',
        entityRowid: `${context.orgId}:${terms.DOC_TYPE}:${result.version}`,
        email: user.email_display || user.email_normalized,
        leadType: 'partner',
        payload: { org_id: context.orgId, org_name: context.orgName || null,
          doc_type: terms.DOC_TYPE, doc_version: result.version },
      });
    }

    return ok(res, { terms: await terms.status(req.catalyst, context.orgId) });
  }));
}

module.exports = { mount };
