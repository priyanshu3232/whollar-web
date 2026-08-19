# Mail authentication, end to end

> SPF, DKIM, DMARC for both sending domains, in the order that cannot lock
> members out of their own accounts. Written 2026-08-19 against the live
> production state, verified by `dig` and by `/api/auth/health`.
>
> DNS is edited in the **IONOS** console (Domains & SSL -> domain -> DNS).
> DKIM values come from the **ZeptoMail** console (Mail Agents -> Domains).
> Nothing here touches repo code. Companion: `catalyst-backend/scripts/auth-env-setup.md`.

> **The one rule.** Sign-in codes travel this path. A DMARC policy published
> before DKIM aligns tells Gmail to reject them, and a member with no code
> cannot sign in at all. Phases run in order, and phase 5 is gated on evidence
> from phase 4, not on a calendar.

## Where things actually stand

`GET /api/auth/health` on production reports:

```
features.mail: true    mail_transport: zeptomail
mail_endpoint: https://api.zeptomail.ca      (Canadian DC, correct)
mail_from:     info@whollar.com
features.smtp: true    (fallback transport, IONOS)
```

So the live sender is **info@whollar.com**, over ZeptoMail's Canadian endpoint.
Current DNS, both domains:

| Record | whollar.ca | whollar.com | Wanted |
|---|---|---|---|
| SPF | `v=spf1 include:_spf-us.ionos.com ~all` | same | ZeptoMail added |
| DKIM | none at any probed selector | none | signed, `d=` aligned |
| DMARC | none | none | `p=reject` eventually |
| BIMI | none | none | optional, phase 6 |

Two things to notice before touching a record.

**ZeptoMail is not authorized by SPF, yet mail arrives.** `mailer.js` chains
ZeptoMail then SMTP and falls back on failure, logging the fallback and
returning success. So a ZeptoMail rejection looks like a delivered email from
the outside. Phase 0 settles which transport actually carried the last message,
because if it was the SMTP fallback then ZeptoMail has never worked in
production and phase 2 is where that surfaces.

**SPF alignment is unreachable for ZeptoMail sends, by design.** ZeptoMail sets
its own bounce domain as the envelope sender, so SPF authenticates a
`zeptomail.ca` domain, not `whollar.com`. Relaxed alignment does not bridge two different
organizational domains. **DKIM is therefore the only path to a DMARC pass on
this traffic**, which is why phase 2 is not optional and phase 5 cannot precede
it.

---

## Phase 0: find out what is signing today

Open the sign-in code email that arrived in Gmail. **Show original**
(three-dot menu), then read four fields:

| Field | What it tells you |
|---|---|
| `Return-Path` / `Received: from` | a `zeptomail.ca` or other Zoho host means ZeptoMail carried it. An IONOS host means the SMTP fallback did. |
| `DKIM-Signature: d=` | `whollar.com` is aligned. `zeptomail.ca` or similar is ZeptoMail's shared key, which does **not** align. Absent means unsigned. |
| `Authentication-Results` | current `spf=`, `dkim=`, `dmarc=` verdicts as Gmail sees them |
| `From:` | confirms `info@whollar.com` |

Record all four somewhere. They are the before picture, and phase 4 compares
against them. If the header shows the SMTP fallback, also read the function log
for `mail transport failed` with `transport: zeptomail`: the `detail` field
names the reason, usually an unverified sending domain.

---

## Phase 1: SPF

One TXT record per domain, and **exactly one**. Two SPF records on the same
name is a permanent error that fails every check at once, and it is the most
common way this phase goes wrong.

**Edit the existing root TXT record, do not add a second.** In IONOS the host
field for a root record is `@`, and IONOS appends the domain itself, so never
type the full name.

`whollar.com`, replace with:

```
v=spf1 include:_spf-us.ionos.com include:zeptomail.ca ~all
```

`whollar.ca`, replace with the same value. Both domains get it: the code
documents `no-reply@whollar.ca` as the sender while production runs
`info@whollar.com`, and either may send. Authorizing both costs one DNS lookup
and removes a whole class of future breakage.

Keep `~all` (softfail) through this runbook. `-all` belongs after phase 5, not
before, because a missed sending path softfails now and bounces then.

**Which include.** `zeptomail.ca` is the Canadian DC and matches the
`api.zeptomail.ca` endpoint the function uses, resolving to
`include:ca.zeptomail.net` and then `ip4:199.67.87.0/24 ip4:199.67.69.0/24`.
Some Zoho accounts are shown `zcsend.ca` instead, a different and also live
block. **Use whatever the ZeptoMail console displays on the domain's SPF
screen.** If it is ambiguous, both can be included: the budget below has room.

**Lookup budget**, which SPF caps at 10: `_spf-us.ionos.com` is 1 and resolves
to plain ip4, `zeptomail.ca` is 2 and chains `ca.zeptomail.net` for a third.
Three of ten used. Adding `zcsend.ca` as well would make five. No risk either way.

Verify, after 10 to 60 minutes:

```bash
dig @8.8.8.8 +short TXT whollar.com | grep spf
dig @8.8.8.8 +short TXT whollar.ca  | grep spf
```

**Always pin the resolver.** This machine's default resolver returns bogus
answers for some domains, which has previously produced a confidently wrong
DNS conclusion here. `@8.8.8.8` or `@1.1.1.1`, every time.

One line each, containing the ZeptoMail include. Two lines means the old record was added
to rather than replaced. Fix that before continuing.

---

## Phase 2: DKIM, the phase that matters

In the ZeptoMail console, **Mail Agents -> Domains**, for each of
`whollar.com` and `whollar.ca`:

1. If the domain is not listed, add it. Verification is a TXT or CNAME record
   ZeptoMail generates: add it at IONOS, then click verify. This is also where
   a never-verified domain from phase 0 becomes visible.
2. On the verified domain, open **DKIM** and let ZeptoMail generate a key. It
   returns a **selector** and a long **public key value**. Both are unique per
   domain and neither can be guessed or copied from anywhere else.
3. At IONOS, add a TXT record with host `<selector>._domainkey` (again, no
   domain suffix in the host field) and the value ZeptoMail gave, verbatim. If
   IONOS rejects the length, the value may need to be entered without wrapping
   quotes.
4. Back in ZeptoMail, click verify on the DKIM row. It must read verified, not
   pending.

Verify from a terminal, substituting the real selector:

```bash
dig @8.8.8.8 +short TXT <selector>._domainkey.whollar.com
dig @8.8.8.8 +short TXT <selector>._domainkey.whollar.ca
```

A `v=DKIM1; k=rsa; p=...` value on each. Empty output means the record is not
live yet, and no amount of clicking verify in the console will change that.

---

## Phase 3: prove alignment before publishing any policy

Trigger a real sign-in code to a Gmail address, then re-read the headers from
phase 0. All three must now hold:

```
spf=pass            (on the ZeptoMail bounce domain, unaligned, expected)
dkim=pass  header.d=whollar.com        <- this is the one that matters
dmarc=pass                              (passes on the DKIM leg alone)
```

`header.d` reading anything other than the From domain means the send is still
using ZeptoMail's shared key and phase 2 did not take effect. **Stop here.**
Publishing a policy in that state rejects the codes.

Second opinion, independent of Gmail: send the same code to a fresh address
from [mail-tester.com](https://www.mail-tester.com) and read its SPF, DKIM and
DMARC rows. It also catches the reverse DNS and content issues that Gmail hides.

---

## Phase 4: DMARC at p=none, and read the reports

`p=none` changes no delivery decision anywhere. It only asks the receiving
world to report what it sees, which is the only way to discover a sending path
nobody remembered. Create a mailbox for the reports first, at IONOS, then add
one TXT record per domain, host `_dmarc`:

```
v=DMARC1; p=none; rua=mailto:dmarc@whollar.com; ruf=mailto:dmarc@whollar.com; fo=1; adkim=r; aspf=r; pct=100
```

Same value on `whollar.ca`, with the same `rua` address. Reporting to an
address on the same domain needs no authorization record. Pointing it at a
third-party domain later does, and that record is the step people forget.

The reports are gzipped XML and unreadable by eye. Point them at a free
aggregator (Postmark's DMARC digests, or dmarcian's free tier) rather than
opening them by hand.

**Then wait for real data.** Two full weeks, minimum, because reports arrive
daily and cover a rolling window. Read them for one thing: a sending source
that is legitimate and failing. Known candidates here, all of which must appear
as passing before phase 5:

- ZeptoMail via the auth function (sign-in codes, the 7 templates in `mailer.js`)
- the `formSubmit` function, if the ZeptoMail env mirror has been set on it
- anything sent by hand from the IONOS mailboxes, including `partners@whollar.ca`
- the admin console function, if it sends

---

## Phase 5: escalate, in three steps, never one

Only with two clean weeks of reports. Change one value, wait, read reports,
continue. Each step is the same record from phase 4 with one field edited.

```
1.  p=quarantine; pct=25       wait 1 week, read reports
2.  p=quarantine; pct=100      wait 1 week, read reports
3.  p=reject; pct=100          the destination
```

`pct=25` is the whole point of the ladder: a mistake affects a quarter of one
domain's mail and shows up in reports while three quarters still deliver.

At step 3, and only then, tighten SPF from `~all` to `-all` on both domains.

**Rollback is one edit back to `p=none`**, and it takes effect as fast as the
TTL allows. Set the `_dmarc` TTL to 1 hour, not a day, for exactly this reason.
If sign-in codes stop arriving, that edit is the first move, before diagnosis.

---

## Phase 6: BIMI, optional, and the reason the avatar is a W

Gmail draws a sender avatar from a Google profile photo on the sending address,
which a Zoho-hosted domain can never have, or from BIMI. With neither, it
generates a letter avatar and colors it deterministically. That is the purple W,
and no image uploaded anywhere else affects it. The green mark inside the
message body is a separate thing and already renders correctly, from
`https://www.whollar.ca/images/email/whollar-mark.png`.

BIMI is the only route, and it is gated on everything above:

1. **DMARC at `p=quarantine` or `p=reject`** on the sending domain, with `sp`
   not weaker. Phase 5, complete. BIMI is ignored at `p=none`.
2. **A VMC** (Verified Mark Certificate) from Entrust or DigiCert. Roughly
   **$1,000 to $1,500 per year**, and issuance normally requires the mark to be
   a *registered* trademark, CIPO for a Canadian filing. A CMC covers prior use
   instead, for less money and with thinner support across mailbox providers.
3. **The mark as SVG Tiny Portable/Secure 1.2**: square viewBox, a `title`
   element, no scripts, no external references, no raster embeds.
4. Host the SVG and the PEM, then one TXT record per domain, host
   `default._bimi`:

```
v=BIMI1; l=https://www.whollar.ca/images/email/whollar-mark-bimi.svg; a=https://www.whollar.ca/.well-known/vmc.pem
```

**The recommendation is to skip this.** A trademark registration plus a
recurring certificate, for a 40 pixel circle, is the wrong spend before launch.
Phases 1 through 5 are worth doing entirely on their own merits: they are what
keeps a sign-in code out of a spam folder.

---

## Owed elsewhere, adjacent to this

Not DNS, and not blocking any phase above, but the same subsystem:

- `MAIL_REPLY_TO` is unset in production and falls back to `info@whollar.com`
  in `config.js`. Set it explicitly.
- The `formSubmit` function needs `ZEPTOMAIL_TOKEN`, `ZEPTOMAIL_FROM` and
  `ZEPTOMAIL_API_BASE` mirrored from the auth function, per the note at
  `catalyst-backend/functions/formSubmit/index.js`. Until then contact
  submissions do not email, and phase 4 will not see that source at all.
- Production `ZEPTOMAIL_FROM` is `info@whollar.com` while
  `auth-env-setup.md` documents `no-reply@whollar.ca`. The mixed
  `.com` / `.ca` split is deliberate, so the doc is what is stale here, not the
  environment.
