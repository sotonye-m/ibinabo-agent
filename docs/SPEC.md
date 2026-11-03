# Build spec — Ibinabo Distribution credit & stock desk

## 1. Problem (for the submission's problem statement)
Ibinabo Distribution (fictional) supplies FMCG goods on credit to ~40 petty traders around Mile 1 Market, Port Harcourt. The owner tracks who owes what, who is actually selling, and who to stop giving credit to in notebooks and WhatsApp threads, and loses money to fake transfer alerts. The Chord agent gives each trader a payment account, handles balances, part-payments and reorders against a credit limit on WhatsApp, and gives the owner a live scorecard of each trader's cash-return speed and sell-through. Left out: forecasting, automatic credit decisions, multi-warehouse, real dispatch.

Pattern borrowed from India's Khatabook/OkCredit (credit ledger + WhatsApp reminders with a pay link) and Brazil's Pix payment requests over WhatsApp.

Role preference to state: Technical Product Management, then Forward-deployed Engineering.

## 2. Architecture

```
WhatsApp simulator (chat.tsglabs.dev)
        │
   Chord teammate  ── skills/ (3 SKILL.md) ── built-in handover_to_human
        │  MCP (Streamable HTTP, bearer auth)
        ▼
Vercel project (Express, TypeScript)
   POST /mcp                  ← all agent tools
   POST /webhooks/paystack    ← Paystack charge.success
   GET  /health
        │                     │
   Google Sheets           Paystack API (test mode)
```

## 3. Repo layout

```
CLAUDE.md
README.md
FIELD_NOTES.md
GO_LIVE.md
.env.example
package.json  tsconfig.json  vercel.json
skills/
  ibinabo-business-context/SKILL.md
  retailer-desk/SKILL.md
  owner-desk/SKILL.md
src/
  app.ts                 Express app (exported for Vercel; listens locally)
  mcp/server.ts          builds McpServer, registers tools
  mcp/tools/*.ts         one file per tool
  webhooks/paystack.ts
  lib/sheets.ts          typed read/write per tab, simple in-memory cache per request
  lib/paystack.ts        initialize, verify, list, dedicated_account
  lib/ledger.ts          allocation, balances (pure functions)
  lib/scorecard.ts       metrics, tiers, recommendations (pure functions)
  lib/identity.ts        phone normalisation, role lookup
  lib/money.ts           kobo <-> display
scripts/seed.ts
tests/ledger.test.ts  tests/scorecard.test.ts
docs/SPEC.md  docs/CHORD_NOTES.md  docs/TEST_SCRIPTS.md
```

## 4. Environment variables (`.env.example`)

```
MCP_BEARER_TOKEN=            # random 32+ chars; also entered in Chord when registering the server
PAYSTACK_SECRET_KEY=         # sk_test_...
PAYSTACK_PUBLIC_KEY=         # pk_test_... (only if needed)
PAYSTACK_CALLBACK_URL=       # e.g. https://<vercel-app>/paid (simple thank-you page)
GOOGLE_SHEET_ID=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=          # with \n escaped; unescape in code
OWNER_PHONES=+2348030000000  # comma-separated, E.164
OWNER_PIN=                   # fallback if Chord doesn't expose the sender's number
USE_DEDICATED_ACCOUNTS=false # true only once DVA works in test mode
TIMEZONE=Africa/Lagos
```

## 5. Google Sheet schema (one sheet, tabs below; row 1 = headers)

**Retailers**: `retailer_id` (R001…) · `name` · `shop_name` · `phone` (E.164) · `market` · `credit_limit_kobo` · `tier` · `dva_bank` · `dva_account_number` · `paystack_customer_code` · `email` (synthetic: `r001.ibinabo@example.com`; Paystack rejects `.test`) · `last_stock_check_at`

**Products**: `sku` · `name` · `unit` (carton/bag/keg/pack) · `price_kobo` · `units_on_hand` · `reorder_point`

**Invoices**: `invoice_id` (INV-0001…) · `retailer_id` · `issued_at` (ISO) · `due_at` · `items_json` (`[{sku, qty, unit_price_kobo}]`) · `amount_kobo` · `paid_kobo` · `status` (open|part_paid|paid|disputed) · `disputed_reason`

**Payments**: `reference` (unique) · `retailer_id` · `amount_kobo` · `paid_at` · `channel` · `source` (webhook|verify|seed) · `allocations_json` (`[{invoice_id, amount_kobo}]`) · `unapplied_kobo`

**PaymentRequests**: `reference` · `retailer_id` · `amount_kobo` · `created_at` · `status` (pending|paid|abandoned) · `authorization_url`

**Promises**: `promise_id` · `retailer_id` · `amount_kobo` · `due_at` · `created_at` · `status` (open|kept|broken)

**StockChecks**: `retailer_id` · `sku` · `units_left` · `checked_at`

**Escalations**: `ticket_id` · `retailer_id` · `reason` · `summary` · `created_at` · `status` (open|resolved)

**Scorecard** (written by code after every ledger change and by seed): `retailer_id` · `name` · `tier` · `balance_kobo` · `credit_limit_kobo` · `cash_return_rate_30d` · `avg_days_to_pay` · `sell_through_units_per_day` · `sell_through_source` · `promise_reliability` · `flags` · `suggested_limit_kobo` · `updated_at`

Use conditional formatting in the sheet (manually, once): tier A green, C red; `balance_kobo` = 0 green. That's the "wow" moment in the recording.

## 6. Ledger rules (`lib/ledger.ts`, pure, unit-tested)
- **Balance** = Σ(open/part_paid invoice `amount_kobo − paid_kobo`) − Σ(`unapplied_kobo` credit). Disputed invoices are excluded from `balance_due` but listed separately as `disputed_kobo`.
- **Allocation** of a new payment: oldest `issued_at` first, skip `disputed`. Part-pay sets `part_paid`; full sets `paid`. Leftover → `unapplied_kobo` (credit), auto-applied to the next invoice created.
- **Idempotent**: if `reference` already exists in Payments, return the existing result unchanged.
- **Promise status**: when payments since `created_at` ≥ `amount_kobo` by `due_at` → kept; past `due_at` and not met → broken. Recompute on read.
- **Credit check for reorder**: `exposure_after = balance_due + disputed_kobo + order_total`. Approved if `exposure_after ≤ credit_limit_kobo`. Else `unlock_amount = exposure_after − credit_limit_kobo`, `max_order_value = max(0, credit_limit_kobo − balance_due − disputed_kobo)`.
- Due date for new invoices: issued_at + 14 days (tier A), 10 (B), 7 (C).

## 7. Scorecard (`lib/scorecard.ts`, pure, unit-tested)
Window = last 30 days unless stated.
- `cash_return_rate_30d` = cash received in window ÷ value of goods issued in window (cap display at 100%; if no goods issued, null).
- `avg_days_to_pay` = mean of (date invoice reached `paid` − `issued_at`) for invoices paid in last 60 days; open invoices older than their due date count as (today − issued_at).
- `sell_through_units_per_day` per retailer (sum across SKUs): from consecutive stock checks: (units_left_prev + units_received_between − units_left_now) ÷ days between. `sell_through_source = "reported"`. If < 2 checks: infer from reorder interval (units in last order ÷ days until next order) → `"inferred"`; if neither, null and `"none"`.
- `promise_reliability` = kept ÷ (kept + broken), last 60 days; null if none.
- **Flags**: `over_limit`, `overdue_>7d`, `broke_promise` (any broken in 30d), `no_reorder_21d`, `slow_seller` (sell-through in bottom quartile), `disputed_invoice`.
- **Tier**:
  - A: cash_return ≥ 0.85 AND avg_days_to_pay ≤ 10 AND no `broke_promise`/`over_limit`.
  - C: cash_return < 0.6 OR avg_days_to_pay > 21 OR `over_limit` OR promise_reliability < 0.5.
  - else B.
- **Suggested limit**: A → `round_to_5k(min(limit × 1.25, 2 × largest balance cleared on time))`, never below current; B → current; C → `round_to_5k(limit × 0.5)` plus recommendation "pause new credit until balance < ₦X".
- `recommendation` string generated in code from the top flag, e.g. "Pause credit for Iya Basira until she clears ₦60,000 — broke 2 promises, 24 days to pay."

## 8. MCP tools (exact names; all inputs include `phone` unless noted)

Common output fields: every response is JSON text content `{status, ...}`. Money fields come in pairs: `x_kobo` and `x_display`.

| Tool | Input | Success statuses & key outputs | Other statuses |
|---|---|---|---|
| `get_account` | `phone` | `ok`: `role` (retailer/owner/unknown), retailer: `customer_id, name, shop_name, balance_due, disputed, credit, credit_limit, open_invoices[≤5]{invoice_id, issued_at, due_at, items_summary, left}`, `open_promises`, `broke_recent_promise`, `stock_check_due` (no check in 7d), `tier` | `unknown` role for unregistered numbers |
| `get_payment_details` | `phone, amount_kobo` | `ok`: `method` (dedicated_account|checkout), `bank_name, account_number, account_name` OR `checkout_url`, `reference`, `amount_display`, `note` ("No need to send a screenshot") | `invalid_amount` (≤ 0, or more than balance_due + 10%), `not_retailer` |
| `check_payments` | `phone` | `paid` (new payments found since last check: `received[]{amount, reference, paid_at}`, `allocations[]`, `new_balance`), `overpaid` (same + `credit`), `not_found` (no new payment; `pending_requests[]`) | `not_retailer` |
| `place_reorder` | `phone, items[{sku or name, qty}]` | `approved`: `invoice_id, lines[], total, due_at, new_balance`; decrements `units_on_hand` | `over_limit`: `unlock_amount, max_order_value, current_balance, limit`; `insufficient_stock`: `sku, requested, available_units`; `unknown_product`: `query, suggestions[]` |
| `record_promise` | `phone, amount_kobo, due_date (YYYY-MM-DD)` | `recorded`: `promise_id, amount, due_at` | `too_far` (> 14 days → must escalate), `invalid_amount` |
| `record_stock_check` | `phone, sku or name, units_left` | `recorded`: `sell_through_units_per_day` | `unknown_product` |
| `escalate_to_owner` | `phone, reason (dispute|payment_not_found|extension_request|discount_request|new_contact|system_error|other), summary, invoice_id?` | `escalated`: `ticket_id`. For `dispute` with invoice_id, sets invoice `status=disputed` | — |
| `get_retailer_scorecard` | `phone` (owner), `retailer` (name or id, fuzzy match) | `ok`: all scorecard fields + `recommendation` | `not_owner`, `not_found`, `ambiguous` (`matches[]`) |
| `get_portfolio_report` | `phone` (owner), `period` (7d|30d) | `ok`: `cash_collected, cash_outstanding, lagging[≤5]{name, balance, avg_days_to_pay, top_flag}`, `top_recommendation`, `low_stock[]`, `open_escalations[]` | `not_owner` |
| `get_warehouse_stock` | `phone` (owner), `sku?` | `ok`: `items[]{sku, name, units_on_hand, reorder_point, low}` | `not_owner` |
| `update_credit_limit` | `phone` (owner), `retailer`, `new_limit_kobo`, `approved_by: "owner"` | `updated`: `old_limit, new_limit` | `not_owner`, `not_found`, `confirmation_required` if `approved_by` missing |

Identity: normalise phone to E.164 (`080…` → `+23480…`). Owner = phone in `OWNER_PHONES`. If Chord does not pass the sender's number (to be probed), the agent asks the user; owner tools additionally accept `pin` and check `OWNER_PIN`. Record the probe result in FIELD_NOTES.md.

Tool descriptions matter: write each MCP tool `description` as one or two sentences saying when to call it and what it returns. Chord passes them to the model.

## 9. Paystack (test mode)
- Base `https://api.paystack.co`, header `Authorization: Bearer ${PAYSTACK_SECRET_KEY}`. Amounts in kobo.
- **Checkout path (default):** `POST /transaction/initialize` `{email, amount, reference: "IBN-<retailer>-<ts>", channels: ["bank_transfer","card","ussd"], callback_url, metadata: {retailer_id}}` → `authorization_url`. Store in PaymentRequests.
- **Verify:** `GET /transaction/verify/:reference` → `data.status === "success"` and `data.amount`. `check_payments` verifies every pending PaymentRequest for the retailer (covers missed webhooks).
- **Dedicated accounts (stretch, behind `USE_DEDICATED_ACCOUNTS`):** `POST /customer` → `POST /dedicated_account {customer, preferred_bank: "test-bank"}`. Payments arrive as `charge.success` with `data.channel = "dedicated_nuban"`; map via customer code. **First confirm test mode lets you simulate a transfer into the account; spend ≤ 15 min, then fall back and write a field note.**
- **Webhook** `POST /webhooks/paystack`: use `express.raw({type: "application/json"})`; verify signature; on `charge.success` → find retailer (metadata.retailer_id or customer code) → `applyPayment` (idempotent) → mark PaymentRequest paid → recompute Scorecard row. Always return 200 quickly after verification.
- Set the webhook URL in Paystack dashboard → Settings → API Keys & Webhooks (test).

## 10. Seed data (`scripts/seed.ts`)
Deterministic (fixed random seed). 8 retailers, 8 products, ~8 weeks history:
- 2 strong (A): pay in 5–8 days, reorder weekly, stock checks regular.
- 3 average (B): 10–16 days, occasional part-payments.
- 2 lagging (C): 22–30 days, one broken promise each, one near/over limit.
- 1 with an open disputed invoice.
Use realistic names (Mama Tobi Provisions, Iya Basira Stores, Emeka & Sons, Blessing Mini-Mart, Alhaji Musa Ventures, Ngozi Supermarket, Tamuno Enterprises, Chief Dokubo Stores) and phones `+23480300000NN`. Prices realistic in naira (e.g. Indomie carton ₦13,500, Peak milk carton ₦28,000, rice 50kg ₦78,000 — adjust if you like). Seed writes the Scorecard tab at the end. Reserve one retailer (Mama Tobi) whose phone you use in the demo, positioned just under her limit so a reorder gets blocked.

## 11. Chord setup (see CHORD_NOTES.md)
1. Create teammate from `skills/` ZIP; publish all three skills.
2. Register the MCP server (UI: Teammate settings → Tools → Add tool, or API `POST /v1/workspaces/{ws}/mcp-servers` with `auth_type: "bearer"`, `transport: "streamable_http"`).
3. Discover tools; confirm all names appear; check health.
4. Activate teammate; enable Connected Apps → Allow Approved Apps; create a chat link at chat.tsglabs.dev.

## 12. Demo / recording (3 min)
1. Mama Tobi: "Abeg send me 5 cartons Indomie and 2 Peak milk" → `over_limit` → agent offers pay ₦X to unlock.
2. She pays via the checkout link with a Paystack test bank transfer/card → says "I don pay" → `check_payments` → confirmed; Sheet row goes green.
3. Reorder retried → `approved`, stock decremented.
4. Edge: "see screenshot" with no payment → polite refusal, second check, handover.
5. Owner number: "Who dey lag this week?" → ranked list + recommendation → "cut Iya Basira to 100k" → YES → `update_credit_limit`.

## 13. Submission checklist (reply to Emmanuel's email with a Google Drive link)
- [ ] Role + 3–4 sentence problem statement at the top
- [ ] Agent left live on Chord, chat link tested
- [ ] Repo (skills + server code) + README (how to run, how AI tools were used)
- [ ] 3-min screen recording
- [ ] FIELD_NOTES.md — 2–3 strong entries
- [ ] GO_LIVE.md — ≤ half page for a non-technical owner

## 14. Implementation deviations (kept deliberately; skills match these)
- **Amount inputs take naira.** `get_payment_details`, `record_promise` accept `amount_naira` (as the trader said it) or `amount_kobo`; `update_credit_limit` takes `new_limit_naira` or `new_limit_kobo`. Code converts, so the model never multiplies by 100. Outputs still give `*_kobo` + `*_display`.
- **Payments.reported_at** (extra column): set when `check_payments` tells the trader about a payment. "New payments since last check" = Payments rows with empty `reported_at`, whether they arrived by webhook or verify.
- **Escalations** has extra `phone` and `invoice_id` columns (unknown numbers have no retailer_id). **Scorecard** has an extra `recommendation` column.
- **Extra statuses:** `record_promise` → `invalid_date` (bad or past date); `get_warehouse_stock` → `unknown_product`; `update_credit_limit` → `invalid_amount`; `get_payment_details`/`check_payments`/etc. → `not_retailer` for unregistered phones.
- **Dashboard tab** (written by seed): formulas over Scorecard showing naira and % for the owner; conditional formatting is applied by the seed, not by hand.
- `npm run smoke [-- <url>]` exercises every tool over real MCP; locally with `DB_BACKEND=file` and `PAYSTACK_SECRET_KEY=sk_test_mock…` it also signs and replays a webhook.
