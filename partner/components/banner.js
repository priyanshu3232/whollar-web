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

/* The bar is sticky, so the nav pane and the view header both start below it
   and the pane is exactly one viewport minus the bar. Nothing else can know
   that height: the copy wraps to a second line on a narrow window, and a
   hardcoded number would push the pane's profile button off screen again.
   Measured here, where the only code that changes the bar lives. */
function measure(host) {
  var h = host.firstElementChild ? Math.ceil(host.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--bannerh', h + 'px');
}

export function render() {
  var host = document.getElementById('mainbanner');
  if (!host) return;
  var S = get();
  var html = '';

  var billing = S.billing;
  if (billing && billing.state === 'failed') {
    html = '<div class="alertbar">'
      + '<b>' + esc(billing.invoice ? 'Statement ' + billing.invoice + ' payment failed.' : 'Your payment method failed.') + '</b> '
      + 'Update your billing method: bidding pauses 14 days after a failed statement. '
      + '<button class="tlink bannerlink" type="button" data-action="nav" data-view="billing">Update method →</button>'
      + '</div>';
  } else if (!S.approved) {
    html = '<div class="alertbar review">'
      + '<b>Your application is with our team.</b> You can look around and set up your account, '
      + 'but cohorts and bidding open when you are approved. Nothing is owed at any point. '
      + '<button class="tlink bannerlink" type="button" data-action="nav" data-view="pending">See where it stands</button>'
      + '</div>';
  }

  host.innerHTML = html;
  measure(host);
}

/* A render is not the only thing that changes the bar's height: a resize
   rewraps the copy, and a late webfont reflows it. Watch the element rather
   than the window, which covers both. */
export function mount() {
  var host = document.getElementById('mainbanner');
  if (!host) return;
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () { measure(host); }).observe(host);
    return;
  }
  window.addEventListener('resize', function () { measure(host); });
}
