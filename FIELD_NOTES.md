# Deployment field notes

Keep 2–3 strong entries for the submission. Log everything while building; trim at the end.

## Template

### N. <Short title>
- **What happened:** what I was doing, what I expected, what I saw. Exact error message / status code / request id.
- **How I found the cause:** logs, "Why this reply", curl, MCP Inspector, docs page, etc.
- **Fix or workaround:** what I changed.
- **What Chord should change:** one concrete product/doc/API change the team could ship next week.

---

### 1. A teammate created via API has skills switched off until you "migrate" (3 Nov, ~17:50)
- **What happened:** I created the teammate with `POST /v1/teammates` and then wanted to upload skills. On the new teammate, `GET /v1/teammates/{id}/skills` returned `enabled: false`. The docs describe skills as the way to configure a teammate, but nothing on the create endpoint says the runtime starts off.
- **How I found the cause:** I read the SkillSet response before uploading. The only endpoint that changes it is `POST /v1/teammates/{id}/skills/migrate`, whose summary is "Preserve existing instructions as skills and enable the skills runtime". The name suggests an upgrade for old teammates, not a setup step for new ones.
- **Fix or workaround:** `scripts/chord.ts` calls `migrate` when `enabled === false`, then uploads, publishes and includes each skill. One idempotent `npm run chord:setup` now does the whole teammate setup.
- **What Chord should change:** let `POST /v1/teammates` accept `skills_enabled: true` (or default it on), and document "upload → publish → include" as the required order on the create endpoint. A skill can be published but still not included, and from the API alone it isn't obvious that this means it does nothing.

### 2. Google Sheets 404 "Requested entity was not found": the ID was a Google Doc (3 Nov, ~17:55)
- **What happened:** `npm run seed` failed with `404 NOT_FOUND, Requested entity was not found`. The service account was authenticated and had been shared on the file as editor.
- **How I found the cause:** I checked the ID's format (44 characters, no URL fragments), then looked at the file's metadata in Drive. Its `mimeType` was `application/vnd.google-apps.document`: a Doc had been created instead of a Sheet. The Sheets API reports a wrong type as "not found", not as a type error.
- **Fix or workaround:** I created a native Google Sheet, shared it with the service account and reseeded. The seed creates the tabs, so a blank sheet is all it needs.
- **What Chord should change:** (setup docs) when a guide asks for an external resource ID, add one line on how to check it's the right kind (here: "the URL must contain `/spreadsheets/d/`"). A first-run check like this saves a non-engineer half an hour.

### 3. Paystack rejects synthetic `.test` emails at checkout (3 Nov, ~18:00)
- **What happened:** `get_payment_details` returned `system_error`: `Paystack POST /transaction/initialize → 400: "email" must be a valid email`. The seeded traders had `r001@ibinabo.test`.
- **How I found the cause:** The smoke test against the real test-mode API showed the exact message, because the tool passes Paystack's error through. I then probed `initialize` directly: `@example.com` gets 200, a reserved TLD like `.test` gets 400.
- **Fix or workaround:** Seeded emails are now `r001.ibinabo@example.com`. Petty traders often have no email, so a real deployment would generate one per trader in the same way.
- **What Chord should change:** when a tool returns `status: system_error` with a message, Chord could show the failing tool and message in the operator's thread view. That way a broken payment link shows up before a trader complains, without anyone opening Vercel logs.

---

## Probes to record
- [ ] Does Chord pass the WhatsApp sender's number to MCP tools / the model?
- [ ] Are all skills applied per reply, or one picked by description?
- [ ] Credits per simulator turn
- [ ] `handover_to_human` available in the simulator?
- [ ] Paystack dedicated virtual account: can a transfer be simulated in test mode?
