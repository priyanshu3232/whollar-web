/* The banner above every view.
 *
 * Two things can claim it, and they are ranked, because a partner whose card
 * failed while their application is pending needs to be told about the card:
 * one is a thing they can fix, the other is a thing they are waiting on.
 *
 *   1. Billing failure. §9.1 G11: on every view, with the recovery route.
 *   2. Application under review.
 *
 * In the prototype this host sat BEFORE <!doctype html>. Browsers silently
 * recover from that, which is why it appeared to work; it belongs inside body,
 * and §4.4.1 says so.
 */

import { get } from '../core/state.js';
import { esc } from '../core/format.js';

export function render() {
  var host = document.getElementById('mainbanner');
  if (!host) return;
  var S = get();

  var billing = S.billing;
  if (billing && billing.state === 'failed') {
    host.innerHTML = '<div class="alertbar">'
      + '<b>' + esc(billing.invoice ? 'Statement ' + billing.invoice + ' payment failed.' : 'Your payment method failed.') + '</b> '
      + 'Update your billing method: bidding pauses 14 days after a failed statement. '
      + '<button class="tlink bannerlink" type="button" data-action="nav" data-view="billing">Update method →</button>'
      + '</div>';
    return;
  }

  if (!S.approved) {
    host.innerHTML = '<div class="alertbar review">'
      + '<b>Your application is with our team.</b> You can look around and set up your account, '
      + 'but cohorts and bidding open when you are approved. Nothing is owed at any point. '
      + '<button class="tlink bannerlink" type="button" data-action="nav" data-view="pending">See where it stands</button>'
      + '</div>';
    return;
  }

  host.innerHTML = '';
}
