# Live columns, Development store

Read 2026-09-06 from the header row of one `catalyst ds:export --page 1` report
per table. Catalyst adds ROWID, CREATORID, CREATEDTIME and MODIFIEDTIME to every
table; they are stripped below.

Eight tables do not exist in the store and so do not appear here:
`campaign_notices`, `brand_registry`, `provider_brands`, `distributor_providers`,
`member_provider_exclusions` and `brand_requests` in the auth family,
`WaitlistShareCodes` and `ReferralClicks` in the formSubmit family.

## auth function, lower_snake_case
`application_tasks` (8)

> task_key_org, org_id, task_key, state, completed_at, checked_at, note, updated_at

`auth_challenges` (8)

> challenge_id, email_normalized, code_hash, purpose, attempts, consumed_at, ip_hash, expires_at

`auth_events` (7)

> event_type, user_id, email_normalized, ip_hash, user_agent, outcome, detail

`auth_identities` (6)

> user_id, provider, provider_uid, provider_key, email_at_provider, linked_at

`bid_revisions` (10)

> revision_key, bid_key, campaign_id, org_id, revision_no, payload, payload_hash, receipt_no, submitted_by, server_received_at

`campaign_awards` (15)

> award_key, org_id, price, method, awarded_at, gate_by, consent_ack, campaign_id, bid_key, bid_count, awarded_by, gate_at, install_capacity_weekly, settled_at, tiers_won

`campaign_members` (6)

> membership_key, campaign_id, user_id, status, fsa, joined_at

`campaign_price_books` (6)

> book_key, campaign_id, bid_count, book_json, method, sealed_at

`campaigns` (19)

> campaign_id, region, sub, kind, target, seed_members, seed_households, bidding_open, sort_order, updated_by, announce_at, bidding_opens_at, bidding_closes_at, offers_at, decision_at, switch_window_at, reconcile_at, brief_json, updated_at

`claim_event` (11)

> event_key, claim_key, address_id, member_id, from_cohort_id, to_cohort_id, action, reason, actor, request_id, occurred_at

`cohort_counter` (7)

> cohort_id, roster_count, min_threshold, public_threshold, published, partner_announced, updated_at

`consents` (5)

> user_id, doc_type, doc_version, ip_hash, accepted_at

`coverage_verifications` (7)

> coverage_key, org_id, region, reason, checked_by, checked_at, outcome

`credentials` (6)

> user_id, hash, algo, updated_at, failed_count, locked_until

`email_suppressions` (5)

> email, reason, source, first_seen_at, last_seen_at

`household_offers` (8)

> offer_key, campaign_id, user_id, speed_mbps, centre_tier, window_rule, cards_json, offered_at

`invite_click` (6)

> token, token_valid, landed_at, first_touch, ip_hash, ua_hash

`member_bills` (13)

> user_id, provider, monthly_cost, download_speed, access_tech, promo_end_date, promo_expired, switch_threshold, updated_at, source, contract_start_date, contract_length, discount_amount

`notification_deliveries` (8)

> outbox_key, client_reference, provider_message_id, transport, status, status_at, detail, created_at

`notification_outbox` (23)

> notify_key, event_key, template_key, recipient_type, recipient_email, recipient_id, locale, timezone, campaign_id, context, send_priority, casl_class, category, collapse_group, earliest_send_at, status, attempts, last_error, subject, body_sha, created_at, updated_at, sent_at

`oauth_state` (6)

> state, pkce_verifier, nonce, redirect_to, provider, expires_at

`product_interest` (9)

> interest_key, user_id, product, answers, keep_posted, email, fsa, source_page, submitted_at

`provider_applications` (16)

> application_id, org_id, state, legal_name, operating_name, crtc_registration, business_number, submitted_at, decision_due_at, decided_at, decision_note, review_note, reapply_after, source, role_route, updated_at

`provider_bids` (23)

> bid_key, campaign_id, org_id, user_id, price, status, updated_at, tiers, guarantee_months, after_mode, after_line, equipment, rental_monthly, extra_pod_monthly, reduction_presentation, mechanism_label, commitment_cap, revision_count, receipt_no, payload_hash, submitted_at, last_revised_at, discount_mix

`provider_billing` (8)

> org_id, method, billing_email, billing_contact, state, added_by, added_at, updated_at

`provider_coverage` (10)

> coverage_key, org_id, techs, region, speed, lead, status, updated_at, rejection_reason, verified_at

`provider_documents` (13)

> document_id, org_id, kind, file_store_ref, filename, bytes, mime, uploaded_by, uploaded_at, review_state, retention_delete_after, document_key, updated_at

`provider_orders` (20)

> order_key, campaign_id, member_user_id, fsa, slot_at, release_reason, dispute_state, disputed_at, updated_at, order_no, org_id, state, address_line, note, activated_at, dispute_note, created_at, tier, price, phone

`provider_orgs` (6)

> org_id, legal_name, email_domain, approved_at, approved_by, approval_status

`provider_ratings` (7)

> user_id, provider, price, reliability, support, speed, created_at

`provider_references` (7)

> reference_key, org_id, name_role, email, contacted_at, response_state, updated_at

`provider_statements` (12)

> statement_key, org_id, campaign_id, state, activated_count, subtotal, total, due_at, fee_each, tax, issued_at, paid_at

`provider_terms` (9)

> acceptance_key, doc_type, accepted_at, accepted_email, ip_hash, org_id, doc_version, accepted_by, consent_hash

`provider_users` (3)

> user_id, org_id, role

`referral_token` (6)

> token, owner_type, owner_id, status, clicks, issued_at

`seat_claim` (9)

> claim_key, address_id, vertical, member_id, cohort_id, status, version, claimed_at, released_at

`sessions` (7)

> token_hash, revoked_at, ip_hash, user_agent, session_id, user_id, expires_at

`share_event` (12)

> event, member_id, cohort_id, stage_at_share, channel, placement, tier, target, reason, created_at, ip_hash, ua_hash

`site_config` (7)

> config_key, value_type, value, published, description, updated_by, updated_at

`unsubscribe_tokens` (7)

> token_key, token, recipient_type, recipient_id, scope, created_at, used_at

`user_events` (5)

> user_id, user_type, kind, payload, created_at

`user_prefs` (3)

> pref_key, prefs, updated_at

`users` (18)

> user_id, email_normalized, email_display, user_type, status, last_login_at, crm_contact_id, first_name, last_name, postal_code, fsa, province_code, phone, referral_code, referral_carrier, referral_same_region, locale, timezone


## formSubmit function, PascalCase

`BillCheckupSubmissions` (30)

> Email, Via, PostalFSA, Provider, MonthlyCost, DownloadSpeed, AccessTech, PromoEndDate, MonthsToRenewal, PromoExpired, SwitchThreshold, BillFileId, BillFileName, SubmittedAt, ContractStartDate, ContractLength, PriceDuringPromo, PriceAfterPromo, PromoPeriods, PromoFallbackPrice, IsMultiPromo, StartDateUnknown, PromoEndUnknown, ComputedWindowMonths, ComputedCurrentCost, ComputedBenchmarkMonthly, ComputedSavings, ComputedOverpaidToDate, ComputedBasis, ComputedTone

`CalculatorEstimates` (5)

> PostalCode, FSA, MonthlyBill, EstimatedAnnualSavings, SubmittedAt

`CityRequests` (7)

> City, province, Email, SubmittedAt, FSA, PoolingFor, Marketing

`ContactSubmissions` (8)

> FirstName, LastName, Email, Phone, Company, Topic, Message, SubmittedAt

`CrmSyncQueue` (10)

> Source, SourceRowId, Email, LeadType, Payload, Status, Attempts, LastError, CrmLeadId, SyncedAt

`DeepReadRequests` (6)

> Email, Note, FileIds, FileNames, ContextSnapshot, SubmittedAt

`PartnerApplications` (18)

> Role, FirstName, LastName, Company, Email, Phone, Provinces, AccessTech, LegalName, ProviderType, BusinessNumber, Brands, Signatory, RepresentsBrands, LOA, OtherType, Note, SubmittedAt

`ProductVotes` (6)

> VoteKey, Product, VoteId, OtherText, SourcePage, SubmittedAt

`TireCohortCounter` (5)

> CounterKey, Vertical, City, Joined, UpdatedAt

`TireInstallWindows` (7)

> WindowKey, ReferenceCode, Email, WindowDate, Slot, Rank, SubmittedAt

`TireToolRuns` (6)

> RunKey, ReferenceCode, Tool, InputJson, RanAt, OutputJson

`TireWaitlistDetails` (27)

> ReferenceCode, Email, Needs, Tier, Brand, Budget, Financing, InstallerType, Anchor, SplitPreference, InstallWindows, NotBefore, MustBeOnBy, Memberships, Priorities, Readiness, Notes, Payload, SubmittedAt, BrandLine, TravelRadius, InstallerName, InstallerAddress, InstallerPostal, InsuranceHelp, InsurerProvince, PremiumAnnual

`TireWaitlistSignups` (20)

> ReferenceCode, Email, FirstName, LastName, Phone, FSA, PostalFull, City, Path, Source, Language, ReferralCode, ConsentEmail, ConsentSms, AlsoInternet, ConsentText, ConsentAt, SubmittedAt, Wave, ConsentShare

`TireWaitlistVehicles` (23)

> VehicleKey, ReferenceCode, Email, InputMode, VehicleYear, VehicleMake, VehicleModel, Vin, TireSize, SizeNormalized, Strategy, RunsWinterNow, OwnsRims, SubmittedAt, StartingPoint, TireLifeLeft, VehicleTrim, WinterSizeChosen, SizeDownsized, SizeAck, Staggered, TpmsPresent, RimsRecommendation

`WaitlistDetails` (18)

> Email, FSA, Provider, MonthlyCost, DownloadSpeed, PromoEndDate, SwitchThreshold, Services, BillFileName, SubmittedAt, BillFileId, FirstName, LastName, PostalCode, ProvinceCode, DiscountAmount, ContractStartDate, ContractLength

`WaitlistEmails` (10)

> EmailKey, Email, Product, CtaStep, Referral, SourcePage, Host, ConsentText, ConsentAt, SubmittedAt

`WaitlistSignups` (7)

> FirstName, LastName, Email, Phone, FSA, SubmittedAt, ReferralCode

