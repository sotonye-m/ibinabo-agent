# CLAUDE.md — Ibinabo Distribution credit & stock desk (TSG Labs take-home)

Read `docs/SPEC.md` before writing code. It is the source of truth for tool names, inputs, outputs, error codes, sheet schema, ledger rules and scorecard formulas. `docs/CHORD_NOTES.md` covers how Chord connects to this server.

## What this repo is
A WhatsApp AI agent built on **Chord** (TSG Labs' agent platform) for a fictional FMCG distributor in Port Harcourt that supplies petty traders on credit. Chord runs the conversation; this repo provides:
1. `skills/` — three Chord skill folders (SKILL.md each), uploaded to the Chord teammate as a ZIP.
2. A **remote MCP server** (Streamable HTTP, public HTTPS) that Chord calls for tools.
3. A **Paystack test-mode webhook** that records payments.
4. A **Google Sheet** used as the database and the owner's live dashboard.
5. A seed script that fills the sheet with 6–8 weeks of synthetic history.

## Deadline and priorities
Due **Wed 4 Nov 2026, ~10:19 Chile time (UTC-3)**. Submit Tuesday night if possible.
Priority order — do not start a later item until the earlier one works end to end:
1. MCP server deployed on Vercel, reachable by Chord, one tool returning data (`get_account`).
2. Paystack: `get_payment_details` → pay in test mode → webhook → ledger updated → `check_payments` sees it.
3. `place_reorder` with credit-limit and stock checks.
4. `record_promise`, `record_stock_check`, `escalate_to_owner`.
5. Owner tools: `get_retailer_scorecard`, `get_portfolio_report`, `get_warehouse_stock`, `update_credit_limit`.
6. Stretch: Paystack dedicated virtual accounts; Chord scheduled reminders.

**Cut line:** if step 4 isn't done by ~21:00 Tuesday, owner tools shrink to `get_portfolio_report` only, and stock check-ins are dropped. Record the cut in README.

## Stack
- Node 20+, TypeScript, Express, deployed to Vercel (one project).
- `@modelcontextprotocol/sdk` — Streamable HTTP transport in **stateless** mode (`sessionIdGenerator: undefined`), new server + transport per request.
- `googleapis` with a service account for Sheets.
- `zod` for tool input schemas.
- Paystack REST API with `fetch` (no SDK needed).

## Non-negotiable rules (they mirror the skills)
- **Code does all arithmetic.** Balances, totals, allocation, scores and suggested limits are computed server-side and returned as numbers. The model never calculates.
- **Every tool returns a structured result with a `status` string** from the list in SPEC.md, never a thrown error the model has to interpret. Unexpected failures return `{status: "system_error", message}`.
- **Idempotency:** Paystack webhook and `check_payments` must not double-credit. Key payments on the Paystack `reference`.
- **Verify the Paystack webhook signature** (`x-paystack-signature` = HMAC-SHA512 of the raw body with `PAYSTACK_SECRET_KEY`). Use the raw body, not re-serialized JSON.
- **Money is stored in kobo (integers)** internally; tools return both `amount_kobo` and a formatted `amount_display` like `₦84,500`.
- **Test keys and made-up data only.** Never commit secrets. `.env.example` lists names only.
- Bearer-token auth on `/mcp` (`MCP_BEARER_TOKEN`). Reject missing/wrong tokens with 401.

## Commands (create these)
- `npm run dev` — local Express server on :3000 (Chord can't reach localhost; use for curl tests and the MCP Inspector).
- `npm run seed` — wipe and seed the Google Sheet.
- `npm run test` — unit tests for `lib/ledger.ts` and `lib/scorecard.ts` (vitest). These two files must have tests.
- `npx @modelcontextprotocol/inspector` — test the MCP endpoint before registering it in Chord.

## Field notes
The take-home's most-weighted deliverable is `FIELD_NOTES.md`. Whenever something breaks (error message, unexpected behaviour, confusing docs), append an entry immediately using the template in that file: what happened, how the cause was found, the fix, what Chord should change. Do this as you go, not at the end.

## Working style
- Small commits with clear messages.
- When a Chord or Paystack behaviour is uncertain, write a tiny probe first (e.g. log the full MCP request Chord sends) and record the finding in FIELD_NOTES.md before building on it.
- Keep `skills/*/SKILL.md` in sync with tool names and status codes. If you rename anything, update the skills in the same commit.
