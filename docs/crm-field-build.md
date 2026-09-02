# CRM fields to build by hand, per module

Derived from `lib/crm/serialisers/` (what may leave Catalyst) and
`crmSync/index.js` (what is written). `Whollar_ROWID` is excluded throughout:
it exists already, on every module, as the unique external id.

**Lookups are flagged.** They are the fields that make the modules a model
rather than eight lists, and they are the ones to create last, because a lookup
cannot be created before the module it points at.

## Read this before building anything

There is **no `lib/crm/handlers/` directory**. The routing is `syncEntityJob` in
`crmSync/index.js`, as recorded in the Phase 3 report. More importantly:

**As of Phase 3c the field-mapping layer exists** (`crmSync/fieldmap.js`) and all
three defects below are fixed, so these fields are written for real and the note
keeps only the date and a one-line summary. The three are left on the record
because each was invisible in a different way and each has a test named after it:

1. **FIXED. `Zip_Code` and `State` are Lead field names.** On Contacts they are
   `Mailing_Zip` and `Mailing_State`. Written as they are today against a
   Contact, Zoho refuses them, `offendingField` drops them, and the postal code
   is **silently lost**. This is live in the code now.
2. **FIXED. A cohort record was created with nothing on it.** `syncEntityJob` strips the
   Lead-only fields for non-contact modules, correctly, and puts nothing back, so
   a `Cohorts` upsert writes an external id and a note and no region, stage or
   count.
3. **FIXED. Deals has mandatory fields nothing set.** `Deal_Name`, `Stage` and
   `Closing_Date` are required by Zoho. Every `switch_order` upsert will fail
   until they are set, and it will fail as a client error, which means dead after
   two attempts.

So: build the fields, and they fill themselves.

## Contacts

Households and people at partners share this module, told apart by
`Whollar_Contact_Type`.

| Field | API name | Type | Notes |
| --- | --- | --- | --- |
| First name | `First_Name` | standard | |
| Last name | `Last_Name` | standard, mandatory | falls back to the email address |
| Email | `Email` | standard | the adoption key, once, then never again |
| Phone | `Phone` | standard | |
| Mailing city | `Mailing_City` | standard | |
| Mailing state | `Mailing_State` | standard | province code, `ON` |
| Mailing zip | `Mailing_Zip` | standard | full postal code, D2 |
| Contact type | `Whollar_Contact_Type` | Picklist | `Founding Member`, `Partner Contact` |
| FSA | `Whollar_FSA` | Single Line, 3 | the cohort key, kept separately from the postal code |
| Current provider | `Whollar_Provider` | Single Line, 64 | a proper noun, not a picklist: new brands appear |
| Speed tier | `Whollar_Speed_Tier` | Picklist | `50`, `100`, `200`, `500`, `1000`, `2500` |
| Cohort status | `Whollar_Cohort_Status` | Picklist | `joined`, `waitlist`, `alert`, `passed`, `left`, `moved` |
| Has referral | `Whollar_Has_Referral` | Checkbox | **presence only**, D2. Never the token |
| Partner role | `Whollar_Partner_Role` | Picklist | `owner`, `admin`, `member`. Partner contacts only |
| **Account** | `Account_Name` | **LOOKUP to Accounts** | standard on Contacts. Partner contacts only |

## Accounts

One per founding partner company.

| Field | API name | Type | Notes |
| --- | --- | --- | --- |
| Account name | `Account_Name` | standard, mandatory | the legal name |
| Email domain | `Whollar_Email_Domain` | Single Line, 255 | |
| Approval status | `Whollar_Approval_Status` | Picklist | `pending`, `approved`, `rejected`. **Three, not sixteen** |
| Decision reason | `Whollar_Decision_Reason` | Multi Line, 2000 | shown verbatim on a declined application |
| Application state | `Whollar_Application_State` | Picklist | `draft`, `submitted`, `under_review`, `info_needed`, `approved`, `rejected` |
| Terms version | `Whollar_Terms_Version` | Single Line, 32 | latest accepted; the proof of earlier ones stays in `provider_terms` |
| Billing state | `Whollar_Billing_State` | Picklist | `invoice`, `active`, `retired` |
| Billing email | `Whollar_Billing_Email` | Email | |
| Billing contact | `Whollar_Billing_Contact` | Single Line, 120 | |

| Coverage | `Whollar_Coverage` | **Multi-Select Picklist** | region slugs, `toronto-west` etc. Decided 2026-09-02 |

**One caveat on coverage.** A multi-select is replaced on write, not appended,
and a `coverage_changed` event carries one region, so the field holds the region
most recently changed rather than the full set. Making it carry everything means
reading `provider_coverage` at enqueue time, which is a serialiser change and is
not in this phase. `provider_coverage` stays authoritative either way.

## Cohorts, custom module

| Field | API name | Type | Notes |
| --- | --- | --- | --- |
| Name | `Name` | standard, mandatory | the module's own name field. Use the region |
| Campaign id | `Whollar_Campaign_Id` | Single Line, 64 | the slug, `toronto-west` |
| Region | `Whollar_Region` | Single Line, 100 | the PARTNER key: who may bid |
| Sub | `Whollar_Sub` | Single Line, 100 | |
| Stage | `Whollar_Stage` | Picklist | `planned`, `waitlist`, `forming`, `auction`, `closed`, `archived` |
| FSA list | `Whollar_FSAs` | Multi Line, 4000 | the MEMBER key: who may join. Neither derives the other |
| Target | `Whollar_Target` | Number | seats |
| Households | `Whollar_Households` | Number | count at last sync, not authoritative |
| Promo cliff | `Whollar_Promo_Cliff_At` | Date/Time | |
| **Winning partner** | `Whollar_Winning_Partner` | **LOOKUP to Accounts** | set on award. Award is not wired yet |

## Cohort_Memberships, custom module

The join table, and the module with the most lookups because that is its job.

| Field | API name | Type | Notes |
| --- | --- | --- | --- |
| Name | `Name` | standard, mandatory | `${campaign_id}:${user_id}` |
| **Cohort** | `Whollar_Cohort` | **LOOKUP to Cohorts** | |
| **Household** | `Whollar_Household` | **LOOKUP to Contacts** | |
| Status | `Whollar_Status` | Picklist | `joined`, `rejoined`, `waitlist`, `alert`, `left`, `moved`, `passed` |
| FSA at join | `Whollar_FSA` | Single Line, 3 | the snapshot, not where they live now |
| Joined at | `Whollar_Joined_At` | Date/Time | |
| Exit at | `Whollar_Exit_At` | Date/Time | |
| Exit reason | `Whollar_Exit_Reason` | Picklist | `moving`, `changed_mind`, `price`, `other` |
| **Moved from** | `Whollar_From_Cohort` | **LOOKUP to Cohorts** | on a move |

## Sealed_Bids, custom module

**D3: the fact of a bid, never its content.** No price field appears below and
none may be added. Restrict this module to the founder's profile.

| Field | API name | Type | Notes |
| --- | --- | --- | --- |
| Name | `Name` | standard, mandatory | `${campaign_id}:${org_id}` |
| **Partner** | `Whollar_Partner` | **LOOKUP to Accounts** | |
| **Cohort** | `Whollar_Cohort` | **LOOKUP to Cohorts** | |
| Event | `Whollar_Bid_Event` | Picklist | `submitted`, `revised` |
| Revision | `Whollar_Revision` | Number | |
| Receipt | `Whollar_Receipt` | Single Line, 32 | |
| Tier count | `Whollar_Tier_Count` | Number | how many tiers, never which or at what |
| Sealed at | `Whollar_Submitted_At` | Date/Time | first sealing |

## Deals, switch orders

| Field | API name | Type | Notes |
| --- | --- | --- | --- |
| Deal name | `Deal_Name` | standard, **mandatory** | **nothing sets this yet.** Use the order number |
| Stage | `Stage` | standard picklist, **mandatory** | see the mapping below |
| Closing date | `Closing_Date` | standard, **mandatory** | the slot date, or the activation date |
| Amount | `Amount` | standard | **leave empty.** D1 as amended: no money in CRM |
| **Partner** | `Account_Name` | **LOOKUP to Accounts** | standard on Deals |
| **Household** | `Contact_Name` | **LOOKUP to Contacts** | standard on Deals |
| **Cohort** | `Whollar_Cohort` | **LOOKUP to Cohorts** | |
| Order number | `Whollar_Order_No` | Single Line, 24 | random, never sequential |
| Speed accepted | `Whollar_Tier` | Picklist | same ladder as the Contact tier |
| Changed from | `Whollar_From_Tier` | Picklist | on a re-pick |
| FSA | `Whollar_FSA` | Single Line, 3 | |
| Slot | `Whollar_Slot_At` | Date/Time | |
| Activated at | `Whollar_Activated_At` | Date/Time | |
| Release reason | `Whollar_Release_Reason` | Picklist | `household_passed`, `capacity`, `operator`, `other` |

Stage picklist, mapped from `provider_orders.state`:

| Data Store | Deal stage |
| --- | --- |
| `acc` | Accepted |
| `bkd` | Booked |
| `act` | **Closed Won** |
| `rel` | Closed Lost |
| `noshow` | No Show |
| `access` | Access Failed |
| `linefail` | Line Failed |

**No install address and no mobile**, on any of these. They were released to one
partner for one visit and the allowlist drops them.

## Settlements, custom module

Reserved. No writer exists, so build this last or not at all until the billing
build. No amount fields, deliberately.

| Field | API name | Type | Notes |
| --- | --- | --- | --- |
| Name | `Name` | standard, mandatory | the statement key |
| **Partner** | `Whollar_Partner` | **LOOKUP to Accounts** | |
| State | `Whollar_State` | Picklist | `issued`, `paid`, `failed` |
| Period | `Whollar_Period` | Single Line, 32 | |
| Issued at | `Whollar_Issued_At` | Date/Time | |
| Paid at | `Whollar_Paid_At` | Date/Time | |
| Failure reason | `Whollar_Failure_Reason` | Single Line, 255 | |

## Build order

Lookups cannot point at a module that does not exist, so:

1. **Accounts** and **Contacts** custom fields, no lookups yet
2. **Cohorts**, then its `Whollar_Winning_Partner` lookup to Accounts
3. **Cohort_Memberships**, with both lookups
4. **Sealed_Bids**, with both lookups, then restrict the module to one profile
5. **Deals** custom fields and the `Whollar_Cohort` lookup
6. **Contacts** `Account_Name` lookup, last, once Accounts is populated
7. **Settlements**, or leave it

## Counting the work

Eight lookups in total, four modules to create, roughly fifty custom fields.
Check your edition's per-module custom field cap before starting, and be aware
that a trial dropping to a lower edition can take custom modules with it.
