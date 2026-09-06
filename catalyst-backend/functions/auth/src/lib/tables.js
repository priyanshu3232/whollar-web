'use strict';

/**
 * Every Data Store table this function names, in one place.
 *
 * WHY. Catalyst has no DDL API and no rename tool, so a table name is a string
 * that has to be right in the console and right in the code, and the two only
 * meet at runtime. Before this file the names lived as literals across thirty
 * modules, which meant "who reads this table" was a grep, "which surface does
 * this belong to" was a guess, and a rename was thirty edits with no list to
 * check yourself against.
 *
 * THE CASE IS DECIDED BY THE FUNCTION THAT WRITES, NOT BY THE SURFACE. Tables
 * the `auth` function owns are lower_snake_case. Tables the `formSubmit`
 * function owns are PascalCase, and eleven of them are read from here, which is
 * why they are listed below rather than pretended away. Reading across the line
 * is fine; writing a table is what makes its case yours. The full rule is in
 * docs/TABLE_NAMING_GUIDE.md.
 *
 * `surface` is a TAG, NOT A PREFIX. A table serving two hosts keeps one name
 * and says so here. That is the whole reason prefixing the auth family was
 * considered and dropped: the prefix would repeat what this column already
 * says, at the price of 48 console renames.
 *
 * `spec` is the section of catalyst-backend/scripts/create-tables.md that owns
 * the table, so the click-through instructions are one lookup away from the
 * name.
 *
 * KEEPING THIS HONEST. scripts/check-table-registry.mjs asserts that this file,
 * schema.js and the formSubmit registry all name the same set, and fails when
 * they drift. It is a gate rather than a runtime assertion on purpose: a
 * throwing require would take the whole function down over a documentation
 * mistake, which is a worse failure than the one it prevents.
 */

/** Tables the auth function owns and writes. lower_snake_case, always. */
const T = Object.freeze({
  /* ---- identity and access ---- */
  users:            { name: 'users',            surface: 'shared',   spec: '1' },
  authIdentities:   { name: 'auth_identities',  surface: 'shared',   spec: '2' },
  credentials:      { name: 'credentials',      surface: 'shared',   spec: '3' },
  sessions:         { name: 'sessions',         surface: 'shared',   spec: '4' },
  authChallenges:   { name: 'auth_challenges',  surface: 'shared',   spec: '5' },
  oauthState:       { name: 'oauth_state',      surface: 'shared',   spec: '6' },
  consents:         { name: 'consents',         surface: 'shared',   spec: '7' },

  /* ---- audit and preferences ---- */
  authEvents:       { name: 'auth_events',      surface: 'shared',   spec: '10' },
  userPrefs:        { name: 'user_prefs',       surface: 'internet', spec: '15' },
  userEvents:       { name: 'user_events',      surface: 'internet', spec: '15' },

  /* ---- households ---- */
  memberBills:      { name: 'member_bills',     surface: 'internet', spec: '11' },
  providerRatings:  { name: 'provider_ratings', surface: 'internet', spec: '13' },
  productInterest:  { name: 'product_interest', surface: 'internet', spec: '23' },

  /* ---- partners ---- */
  providerOrgs:     { name: 'provider_orgs',     surface: 'internet', spec: '8' },
  providerUsers:    { name: 'provider_users',    surface: 'internet', spec: '9' },
  providerCoverage: { name: 'provider_coverage', surface: 'internet', spec: '16' },
  providerTerms:    { name: 'provider_terms',    surface: 'internet', spec: '20' },

  /* ---- the founding partner application, section 17 ---- */
  providerApplications:  { name: 'provider_applications',  surface: 'internet', spec: '17' },
  applicationTasks:      { name: 'application_tasks',      surface: 'internet', spec: '17' },
  providerDocuments:     { name: 'provider_documents',     surface: 'internet', spec: '17, 22a' },
  providerReferences:    { name: 'provider_references',    surface: 'internet', spec: '17' },
  coverageVerifications: { name: 'coverage_verifications', surface: 'internet', spec: '17' },

  /* ---- cohorts ---- */
  campaigns:        { name: 'campaigns',        surface: 'internet', spec: '16, 29' },
  campaignMembers:  { name: 'campaign_members', surface: 'internet', spec: '12' },
  campaignNotices:  { name: 'campaign_notices', surface: 'internet', spec: '27' },
  seatClaim:        { name: 'seat_claim',       surface: 'internet', spec: '26a' },
  claimEvent:       { name: 'claim_event',      surface: 'internet', spec: '26b' },
  cohortCounter:    { name: 'cohort_counter',   surface: 'internet', spec: '26c' },

  /* ---- the auction ---- */
  providerBids:       { name: 'provider_bids',         surface: 'internet', spec: '16, 18, 28, 34e' },
  bidRevisions:       { name: 'bid_revisions',         surface: 'internet', spec: '18' },
  campaignAwards:     { name: 'campaign_awards',       surface: 'internet', spec: '21, 30b' },
  campaignPriceBooks: { name: 'campaign_price_books',  surface: 'internet', spec: '30a' },
  householdOffers:    { name: 'household_offers',      surface: 'internet', spec: '32, 34f' },

  /* ---- delivery and billing ---- */
  providerOrders:     { name: 'provider_orders',     surface: 'internet', spec: '21, 30c, 31' },
  providerBilling:    { name: 'provider_billing',    surface: 'internet', spec: '21' },
  providerStatements: { name: 'provider_statements', surface: 'internet', spec: '21' },

  /* ---- brands and exclusions ---- */
  brandRegistry:            { name: 'brand_registry',              surface: 'internet', spec: '34a' },
  providerBrands:           { name: 'provider_brands',             surface: 'internet', spec: '34b' },
  distributorProviders:     { name: 'distributor_providers',       surface: 'internet', spec: '34c' },
  memberProviderExclusions: { name: 'member_provider_exclusions',  surface: 'internet', spec: '34d' },
  brandRequests:            { name: 'brand_requests',              surface: 'internet', spec: '34g' },

  /* ---- growth and sharing ---- */
  referralToken:    { name: 'referral_token', surface: 'shared',   spec: '24a' },
  inviteClick:      { name: 'invite_click',   surface: 'shared',   spec: '25a' },
  shareEvent:       { name: 'share_event',    surface: 'internet', spec: '25b' },

  /* ---- notifications ---- */
  notificationOutbox:     { name: 'notification_outbox',     surface: 'shared', spec: '33a' },
  notificationDeliveries: { name: 'notification_deliveries', surface: 'shared', spec: '33b' },
  emailSuppressions:      { name: 'email_suppressions',      surface: 'shared', spec: '33c' },
  unsubscribeTokens:      { name: 'unsubscribe_tokens',      surface: 'shared', spec: '33d' },

  /* ---- configuration ---- */
  siteConfig:       { name: 'site_config', surface: 'internet', spec: '16, 18, 20, 21' },
});

/**
 * Tables owned by the formSubmit function that this one READS.
 *
 * Kept apart from T so the boundary stays visible: nothing here may be written
 * from this function, and nothing here may be renamed from this function
 * either. routes/admin.js reads all of them for the staff intake views;
 * routes/member.js reads two of them to seed a member's bill from whatever they
 * had already filled in before they had an account.
 */
const F = Object.freeze({
  waitlistSignups:        { name: 'WaitlistSignups',        surface: 'shared',   spec: '14' },
  waitlistDetails:        { name: 'WaitlistDetails',        surface: 'internet', spec: '14' },
  waitlistEmails:         { name: 'WaitlistEmails',         surface: 'shared',   spec: '39a' },
  waitlistShareCodes:     { name: 'WaitlistShareCodes',     surface: 'shared',   spec: '40a' },
  referralClicks:         { name: 'ReferralClicks',         surface: 'shared',   spec: '40b' },
  billCheckupSubmissions: { name: 'BillCheckupSubmissions', surface: 'internet', spec: '14, 19' },
  partnerApplications:    { name: 'PartnerApplications',    surface: 'internet', spec: '14' },
  calculatorEstimates:    { name: 'CalculatorEstimates',    surface: 'internet', spec: '14' },
  contactSubmissions:     { name: 'ContactSubmissions',     surface: 'shared',   spec: '14' },
  deepReadRequests:       { name: 'DeepReadRequests',       surface: 'internet', spec: '14' },
  crmSyncQueue:           { name: 'CrmSyncQueue',           surface: 'shared',   spec: '14' },
});

/**
 * File Store folders. Not tables, same problem: a name that has to match a
 * thing created by hand in the console, with an environment variable holding
 * its id (FILESTORE_DOCS_FOLDER_ID, section 22c).
 */
const FOLDERS = Object.freeze({
  partnerDocuments: 'partner_documents',
});

/** Every table name this function names, either family. Used by the gate. */
const ALL_NAMES = Object.freeze(
  [...Object.values(T), ...Object.values(F)].map((t) => t.name)
);

module.exports = { T, F, FOLDERS, ALL_NAMES };
