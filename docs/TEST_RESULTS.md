# Test results: T1 happy path (blocked reorder → pay → approved)

**Run:** Tue 3 Nov 2026, ~21:15–21:22 Lagos time (20:15–20:22 UTC), on the live system.
**Surface:** TSG WhatsApp Simulator (chat.tsglabs.dev) → Chord teammate *Ibinabo Desk* (skills: business-context v3, retailer-desk v1, owner-desk v1) → MCP server `https://ibinabo-agent.vercel.app/mcp` → Google Sheet + Paystack **test mode**.
**Persona:** Mama Tobi Provisions (R001), registered number 08030000001. Starting state: balance ₦305,500, limit ₦380,000, available ₦74,500.
**Result: passed.** Every step behaved as specified, and every figure the agent quoted came from a tool result.

## User flow

```
Trader                         Agent (Chord)                     Server / Paystack / Sheet
──────                         ─────────────                     ──────────────────────────
"Send me 5 Indomie, 2 Peak" ─▶ asks for registered number
"08030000001"               ─▶ get_account ───────────────────▶ role=retailer, bal ₦305,500
                            ◀─ reads order back, "Reply YES"
"Yes o"                     ─▶ place_reorder ─────────────────▶ over_limit: unlock ₦49,000,
                            ◀─ two options: pay ₦49k / ≤ ₦74.5k   max order ₦74,500
"I go pay the 49k"          ─▶ get_payment_details ───────────▶ Paystack /transaction/initialize
                            ◀─ checkout link, "no screenshot"     PaymentRequests: pending
pays on Paystack checkout (test card)  ─────────────────────────▶ charge.success webhook
                                                                    signature ✓ → payment recorded,
                                                                    ₦49,000 applied to INV-0007
"I don pay"                 ─▶ check_payments ────────────────▶ paid: ₦49,000 → INV-0007
                               place_reorder ─────────────────▶ approved: INV-0056 ₦123,500,
                            ◀─ confirms payment + order            stock −5 Indomie, −2 Peak
```

## Transcript (simulator thread `6aea40c552ba4d326646bd51`)

| # | Trader | Agent reply (abridged) | Tools called (from Chord turn metadata) |
|---|---|---|---|
| 1 | Good morning. Abeg send me 5 cartons Indomie and 2 cartons Peak milk. | "Before I can check your account, please send the phone number registered with Ibinabo Distribution." | none |
| 2 | 08030000001 | "5 cartons of Indomie and 2 cartons of Peak milk. Shall I place the order? Reply YES to confirm." | `get_account` ✓ |
| 3 | Yes o | "I couldn't place the order yet… ₦123,500… past your ₦380,000 credit limit… balance is ₦305,500. 1. Pay ₦49,000 now… 2. Reduce the order to ₦74,500 or less. Also, INV-0007 (₦146,000) was due today." | `get_account` ✓, `place_reorder` ✓ (over_limit) |
| 4 | I go pay the 49k | "Here is your link to pay ₦49,000: https://checkout.paystack.com/b0ypyayya96fgbk … You don't need to send a screenshot, because the payment confirms itself." | `get_account` ✓, `place_reorder` ✓, `get_payment_details` ✓ |
| — | *(pays on Paystack checkout with the test card)* | | webhook `charge.success` |
| 5 | I don pay | "Your ₦49,000 payment came in… order is approved. Total ₦123,500 (invoice INV-0056). Due: Fri 13 Nov. Your new balance is ₦380,000, which is your full credit limit. The warehouse will arrange delivery." | `check_payments` ✓ (paid), `place_reorder` ✓ (approved) |

## System evidence (read back after the run)

| Check | Expected | Observed |
|---|---|---|
| Paystack webhook | signed `charge.success`, recorded once | Vercel log 20:21:42 UTC: `charge.success IBN-R001-1793737269481 4900000 card` → `recorded` |
| Payments row | ₦49,000, source `webhook`, applied oldest-first | `IBN-R001-1793737269481`, ₦49,000, `webhook`, `card`, allocated to INV-0007; `reported_at` set by `check_payments` |
| PaymentRequests row | pending → paid | `paid` |
| INV-0007 (oldest open) | part-paid by ₦49,000 | ₦146,000 invoice, ₦49,000 paid, `part_paid`, ₦97,000 left |
| New invoice | ₦123,500, tier-B terms (10 days) | INV-0056, ₦123,500, `open`, due 13 Nov |
| Warehouse stock | Indomie −5, Peak −2 | Indomie 180 → 175, Peak milk 90 → 88 |
| Scorecard / Dashboard | balance updated | R001 tier B, balance ₦380,000 / limit ₦380,000, updated 20:22:04 UTC |

The arithmetic checks out: 305,500 − 49,000 + 123,500 = 380,000, which equals the limit, so the order is approved on the inclusive limit.

## What this demonstrates
- **The credit limit is enforced in code.** The agent couldn't approve the order and offered exactly the two options the tool returned (unlock ₦49,000 or order at most ₦74,500).
- **Payments are confirmed by Paystack, not by the trader's word.** "I don pay" triggered `check_payments`, which found the payment that the signed webhook had already recorded. The agent never asked for a screenshot.
- **Identity:** the simulator sends an opaque sender id (`partner_…`), so the agent asked for the registered number before calling any tool (see FIELD_NOTES #5).
- **Tone:** short WhatsApp-style messages, "Ma", and the overdue invoice mentioned once at the end.

## Observations / follow-ups
1. **Redundant calls.** The agent re-called `get_account` on most turns, and called `place_reorder` again on turn 4 just to re-check (no side effect, because it returned `over_limit` again). Cost: about 0.5–1 s per turn. Skill v3 says to call `get_account` once and again only after a balance change. To confirm on the next run.
2. **Order placed straight after payment without a second YES.** This is acceptable, because the agent had said "I'll place your order once you pay", but the skill could make the re-confirmation explicit.
3. **Paystack callback URL.** The dashboard was first set to `/webhooks/paid` (should be `/paid`), so the post-payment page returned `not_found`. Fixed by serving the thank-you page on both paths.
4. Earlier API-channel test (thread `6aea28c2…`, sender `+2348030000001`): the same flow passed, and there the model used the sender id as the phone number without asking.

## Remaining scripts (docs/TEST_SCRIPTS.md)
T2 screenshot / payment not found · T3 part-payment + promise · T4 dispute · T5 discount pressure · T6 owner report, scorecard, limit cut · T7 unknown number. **Not yet run.**

Reproduce: `npm run seed` (resets the demo data), then follow T1 in the simulator. `npm run state -- R001` prints the trader's live state.
