'use strict';

/**
 * What a route calls. One function, and the reason it is one function is that
 * a route must not be able to choose between "send this email" and "record
 * that this email was sent": those are the same act and the ledger is not
 * optional.
 *
 * The nine call sites this replaces each did the same four things by hand:
 * build a message, call the transport, catch, and write an audit line with a
 * `delivered` boolean in it. What none of them could do was refuse a send to
 * a suppressed address, hold one until morning, or answer "was it delivered"
 * an hour later. Those live in the outbox; this is the door to it.
 *
 * IT NEVER THROWS FOR A BUSINESS REASON. A suppressed recipient, a declined
 * category and a missing context key are all recorded outcomes. The caller is
 * a route serving a person doing something else, and that person's request
 * must not fail because a letter could not go.
 */

const outbox = require('./outbox');
const registry = require('./registry');
const suppress = require('./suppress');
const unsub = require('./unsub');
const layout = require('./layout');
const scrub = require('./scrub');

/**
 * The recipient shape, from whatever the route has.
 *
 * `type` is 'member' or 'partner' when there is an account, and 'address'
 * when there is not: a sign-in code goes to an address that may belong to
 * nobody yet, and that send still has to be recorded, deduplicated and
 * suppressible. 'address' carries no preferences, which is correct, because
 * an address with no account has expressed none.
 */
function recipientFrom(user, email) {
  if (user && user.user_id) {
    return {
      type: user.user_type === 'provider' ? 'partner' : 'member',
      id: user.user_id,
      email: user.email_normalized || email,
      locale: user.locale || 'en',
      timezone: user.timezone || 'America/Toronto',
      firstName: user.first_name || null,
    };
  }
  const addr = suppress.norm(email);
  return {
    type: 'address',
    id: addr,
    email: addr,
    locale: 'en',
    timezone: 'America/Toronto',
    firstName: null,
  };
}

/**
 * Send, or queue, one message.
 *
 *   dispatch(req, { templateKey, eventKey, to, user, context, campaignId })
 *   -> { status, delivered, notifyKey }
 *
 * `eventKey` is what deduplication keys on. Pass the request id for a message
 * a person just asked for (two clicks on "send me a code" a second apart are
 * one code), and a stable domain key for a message the system decided to send
 * (a campaign stage, a reminder offset), so a second sweep is a no-op.
 */
async function dispatch(req, spec) {
  const cfg = req.app.get('cfg');
  const recipient = spec.recipient || recipientFrom(spec.user, spec.to);

  /* first_name is the one context value every template may use and no caller
     should have to remember to pass. */
  const context = Object.assign(
    { first_name: recipient.firstName || null },
    spec.context || {}
  );

  try {
    return await outbox.dispatch(req.catalyst, cfg, {
      templateKey: spec.templateKey,
      eventKey: spec.eventKey || `${spec.templateKey}:${req.id}`,
      slot: spec.slot || '',
      recipient,
      context,
      campaignId: spec.campaignId || null,
      now: spec.now || Date.now(),
    });
  } catch (err) {
    /* An unknown template or an unwritable outbox is a real failure and the
       caller decides what to do about it, but it is reported here so the one
       log line naming the template exists whatever the caller does next. */
    console.error(JSON.stringify({
      req_id: req.id,
      level: 'error',
      message: 'notify dispatch failed',
      template: spec.templateKey,
      detail: String((err && err.message) || err).slice(0, 200),
    }));
    return {
      status: 'failed',
      delivered: false,
      notifyKey: null,
      transport: null,
      sendError: String((err && err.message) || err).slice(0, 190),
      error: err,
    };
  }
}

/** Drain what is due, without making the caller wait. */
const drainAsync = (req, opts) =>
  outbox.drainAsync(req.catalyst, req.app.get('cfg'), opts);

module.exports = {
  dispatch, recipientFrom, drainAsync,
  outbox, registry, suppress, unsub, layout, scrub,
};
