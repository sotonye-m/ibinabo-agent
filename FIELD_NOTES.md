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

### 4. Chord's step redaction labels a Nigerian phone number as a card number (3 Nov, ~18:32)
- **What happened:** The first live turn through `POST /v1/external-chat/messages` (sender `+2348030000001`, "Good morning. Wetin be my balance?") worked: the agent called `get_account` and answered correctly in Pidgin. But the tool step in the response showed its input as `{"phone": "+[REDACTED:card]"}`.
- **How I found the cause:** I compared Chord's `steps[].instruction` with our own server log for the same call. The server received the full phone number, so the tool call itself was fine; only Chord's displayed copy was masked. A 13-digit `+234…` number looks enough like a card number (PAN) to trip the masking.
- **Fix or workaround:** None needed for the agent to work. For debugging I rely on our own `[tool]` log lines in Vercel.
- **What Chord should change:** classify E.164 numbers (a leading `+` and country code) as `phone` rather than `card`, or show the redaction type next to the field name. An operator debugging an agent in Nigeria will see "card" and assume a payment card was leaked into a prompt, which is a false alarm in a payments product.

### 5. MCP tool calls carry no caller identity, so "who is this trader" rests on the model (3 Nov, ~18:36)
- **What happened:** I needed to know whether Chord tells the MCP server who the end user is. Every tool takes `phone`, and owner tools must not be callable by a trader.
- **How I found the cause:** I logged the full incoming request (`[mcp-probe]`, with Vercel's proxy headers filtered out) for a live turn. The body is only `{"method":"tools/call","params":{"name":"get_account","arguments":{"phone":"+2348030000001"}}}`, and the headers are only `accept`, `content-type`, `user-agent: Java-http-client/23.0.2` and an invocation id. There is no sender id, thread id or channel. The model filled in `phone` from the conversation's `sender_id` without being asked, which is convenient but means identity is whatever the model passes.
- **Fix or workaround:** (1) The skills now say: use the number the chat comes from, and never switch to a number the person types. (2) Owner tools also check `OWNER_PHONES` server-side, with a PIN fallback. (3) Limitation stated in GO_LIVE: a prompt-injection or a confused model could still pass another trader's number. In a payments product that's the main residual risk.
- **What Chord should change:** forward a signed, model-independent caller context on every MCP call, e.g. `X-Chord-Sender-Id`, `X-Chord-Channel` and `X-Chord-Thread-Id`, plus an HMAC signature header using the MCP server's auth secret. Then the tool server can authorise against the real sender rather than a model-supplied argument. This is the single change that would make Chord safe for account-level tools such as balances and payments.

---

## Probes to record
- [x] Does Chord pass the sender's number to MCP tools / the model? **Model: yes (sender_id is visible; it used it unprompted via the external-chat API). MCP request: no — only tool args (note 5). Simulator: no. The thread's `channel_participant_id` is an opaque `partner_…` id and only the typed name is in `remote_participant_metadata`. With skill v3 the agent asks for the registered number before calling any tool (thread 6aea40c5…).**
- [ ] Are all skills applied per reply, or one picked by description?
- [ ] Credits per simulator turn
- [ ] `handover_to_human` available in the simulator?
- [ ] Paystack dedicated virtual account: can a transfer be simulated in test mode?
