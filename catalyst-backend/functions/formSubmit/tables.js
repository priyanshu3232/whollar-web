'use strict';

/**
 * Every Data Store table this function writes, in one place.
 *
 * PASCALCASE, TABLE AND COLUMN, WITHOUT EXCEPTION. Rule 2 at the top of
 * catalyst-backend/scripts/create-tables.md says lower_snake_case, and that rule
 * governs the auth function's tables, not these. These belong to formSubmit,
 * where `FirstName` is right and `first_name` is a runtime failure the household
 * sees as "the servers could not be reached". Sections 35, 37, 38 and 39 each
 * repeat the warning; docs/TABLE_NAMING_GUIDE.md states it once.
 *
 * `surface` is a tag, not a prefix: several of these are posted from more than
 * one host and keep one name. CityRequests takes submissions from whollar.ca
 * and tires.whollar.ca; WaitlistEmails from all three.
 *
 * `spec` is the section of create-tables.md that owns the table.
 *
 * A NAME HERE IS NOT A PROMISE THE TABLE EXISTS. As of 2026-09-06,
 * WaitlistShareCodes and ReferralClicks are declared here, written by the code,
 * and absent from the store: section 40 shipped without them. That is exactly
 * what this file is for, and scripts/check-table-registry.mjs is what keeps the
 * list honest against create-tables.md.
 */

const T = Object.freeze({
  /* ---- the internet waitlist and checkup ---- */
  waitlistSignups:        { name: 'WaitlistSignups',        surface: 'shared',   spec: '14' },
  waitlistDetails:        { name: 'WaitlistDetails',        surface: 'internet', spec: '14' },
  billCheckupSubmissions: { name: 'BillCheckupSubmissions', surface: 'internet', spec: '14, 19' },
  deepReadRequests:       { name: 'DeepReadRequests',       surface: 'internet', spec: '14' },
  calculatorEstimates:    { name: 'CalculatorEstimates',    surface: 'internet', spec: '14' },
  partnerApplications:    { name: 'PartnerApplications',    surface: 'internet', spec: '14' },
  contactSubmissions:     { name: 'ContactSubmissions',     surface: 'shared',   spec: '14' },

  /* ---- the umbrella at whollar.ca ---- */
  cityRequests:      { name: 'CityRequests',      surface: 'shared', spec: '37a' },
  productVotes:      { name: 'ProductVotes',      surface: 'home',   spec: '38a' },
  waitlistEmails:    { name: 'WaitlistEmails',    surface: 'shared', spec: '39a' },
  waitlistShareCodes:{ name: 'WaitlistShareCodes', surface: 'shared', spec: '40a' },
  referralClicks:    { name: 'ReferralClicks',    surface: 'shared', spec: '40b' },

  /* ---- the winter tire vertical at tires.whollar.ca ---- */
  tireWaitlistSignups:  { name: 'TireWaitlistSignups',  surface: 'tires', spec: '35a, 36a' },
  tireWaitlistVehicles: { name: 'TireWaitlistVehicles', surface: 'tires', spec: '35b, 36b' },
  tireWaitlistDetails:  { name: 'TireWaitlistDetails',  surface: 'tires', spec: '35c, 36c' },
  tireInstallWindows:   { name: 'TireInstallWindows',   surface: 'tires', spec: '36d' },
  tireToolRuns:         { name: 'TireToolRuns',         surface: 'tires', spec: '35d, 36e' },
  tireCohortCounter:    { name: 'TireCohortCounter',    surface: 'tires', spec: '35e' },

  /* ---- the CRM mirror ---- *
   * Created here, drained by the crmSync function, which holds the same name in
   * its own QUEUE_TABLE constant because Catalyst packages each function
   * separately and there is nothing for the two to share. The gate asserts they
   * stay equal. */
  crmSyncQueue: { name: 'CrmSyncQueue', surface: 'shared', spec: '14' },
});

/** Every table name this function writes. Used by the gate. */
const ALL_NAMES = Object.freeze(Object.values(T).map((t) => t.name));

module.exports = { T, ALL_NAMES };
