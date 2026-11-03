# Ibinabo Distribution — WhatsApp credit & stock desk (Chord)

**Role preference:** Technical Product Management, then Forward-deployed Engineering.

**Problem.** Ibinabo Distribution (fictional) supplies FMCG goods on credit to ~40 petty traders around Mile 1 Market, Port Harcourt. The owner tracks who owes what, who is actually selling, and who to stop giving credit to in notebooks and WhatsApp threads, and he loses money to fake transfer alerts. This Chord agent gives each trader a Paystack payment link, handles balances, part-payments, promises and reorders against a credit limit on WhatsApp, and gives the owner a live scorecard of each trader's cash-return speed and sell-through, with suggested limit changes he approves. Left out: forecasting, automatic credit decisions, multi-warehouse, real dispatch.

Pattern borrowed from Khatabook/OkCredit (credit ledger + WhatsApp reminders with a pay link) and Pix payment requests over WhatsApp.

## How it fits together

```
WhatsApp simulator ─▶ Chord teammate (3 skills + handover_to_human)
                         │ MCP, Streamable HTTP, bearer auth
                         ▼
                 Vercel: Express  POST /mcp (11 tools) · POST /webhooks/paystack · GET /health
                         │                    │
                 Google Sheet (DB + owner dashboard)   Paystack (test mode)
```

- **The model never does arithmetic.** Balances, allocation, credit checks, scores and suggested limits are computed in [src/lib/ledger.ts](src/lib/ledger.ts) and [src/lib/scorecard.ts](src/lib/scorecard.ts), and every tool returns `*_kobo` plus a ready-to-say `*_display` string.
- **Payments are real only when Paystack says so.** Webhook signatures are verified (HMAC-SHA512 over the raw body). `check_payments` also verifies pending references, which covers missed webhooks. Recording is idempotent on the Paystack `reference`.
- **Every tool returns `{status, …}`.** Unexpected failures come back as `system_error`, never as a thrown error. Status codes are listed in [docs/SPEC.md](docs/SPEC.md) §8 and §14.

## Run it

```bash
npm install
cp .env.example .env            # fill in values
npm test                         # vitest: ledger + scorecard
npm run seed                     # wipe + seed the Google Sheet (8 traders, 8 weeks)
npm run dev                      # http://localhost:3000
npm run smoke                    # every tool over real MCP against localhost
```

Offline mode: `DB_BACKEND=file` stores data in `data/db.json`, and `PAYSTACK_SECRET_KEY=sk_test_mock_x` stubs Paystack. In that mode `npm run smoke` also signs and replays a webhook, including a duplicate and a bad signature.

Deploy: `npx vercel deploy --prod`, set the env vars in Vercel, then point Paystack's test webhook at `https://<app>/webhooks/paystack`.

Chord: `npm run chord -- register` (registers the MCP server, attaches it to the teammate, runs discovery and health), `npm run chord -- skills` (uploads and publishes the skills), `npm run chord -- chat +2348030000001 t1 "Abeg send me 5 cartons Indomie"` (one turn, printing the reply and tool steps).

## Demo accounts (seeded, synthetic)
| Who | Phone | Notes |
|---|---|---|
| Mama Tobi Provisions | +2348030000001 | ₦74,500 under her limit, so "5 Indomie + 2 Peak" is blocked and needs ₦49,000 to unlock |
| Iya Basira Stores | +2348030000002 | Tier C: over limit, broke a promise, 23 days to pay |
| Ngozi Supermarket | +2348030000006 | Open disputed invoice |
| Owner | `OWNER_PHONES` | Portfolio, scorecards, limit changes |

## How AI tools were used
Claude Code (Opus) wrote the server, tests, seed and scripts from a spec I wrote first ([docs/SPEC.md](docs/SPEC.md)), working against the Chord OpenAPI document. I set the rules (code does the maths, idempotent payments, owner approval for limits), reviewed the tool contracts, and ran the scenarios in [docs/TEST_SCRIPTS.md](docs/TEST_SCRIPTS.md).

## Docs
[FIELD_NOTES.md](FIELD_NOTES.md) (deployment field notes) · [GO_LIVE.md](GO_LIVE.md) (note for the owner) · [docs/CHORD_NOTES.md](docs/CHORD_NOTES.md)
