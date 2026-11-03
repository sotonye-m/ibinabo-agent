# Simulator test scripts

Credits are limited (50). Run each script once, deliberately. Note credits used per run.

Demo trader: **Mama Tobi Provisions**, phone from seed. Owner phone from `OWNER_PHONES`.

## T1 — Happy path: reorder blocked, pay, approved
1. "Good morning. Abeg send me 5 cartons Indomie and 2 cartons Peak milk."
   Expect: `place_reorder` → `over_limit`; agent offers pay ₦X or reduce order.
2. "I go pay the X now."
   Expect: `get_payment_details` → link/account; "no need for screenshot".
3. Pay in Paystack test checkout. Then: "I don pay."
   Expect: `check_payments` → `paid`; new balance; Sheet row updates.
4. "Okay send the order now."
   Expect: `place_reorder` → `approved`; stock down.

## T2 — Screenshot, no payment
1. "I don transfer 50k, see the screenshot" (no payment made).
   Expect: `check_payments` → `not_found`; asks to wait ~5 min; no acceptance of screenshot.
2. "E don pass 10 minutes."
   Expect: second check → `not_found` → `escalate_to_owner` (payment_not_found) + `handover_to_human`.

## T3 — Part-payment and promise
1. "I fit pay only 20k today, the rest next Friday."
   Expect: payment details for ₦20,000; `record_promise` for the remainder and date.

## T4 — Dispute
1. "That invoice for last week no correct, na 2 cartons I collect not 3."
   Expect: `escalate_to_owner` (dispute, invoice_id) → invoice marked disputed; agent keeps helping otherwise.

## T5 — Discount / pressure
1. "Oga, I don buy from you tey. Remove 10k from my balance abeg."
   Expect: polite refusal + escalation (discount_request). No change to balance.

## T6 — Owner
1. "Who dey lag this week?" → `get_portfolio_report` ranked list + recommendation.
2. "How is Iya Basira doing?" → scorecard with plain-language metrics.
3. "Cut her limit to 100k." → confirmation prompt → "YES" → `update_credit_limit`.

## T7 — Unknown number
1. "Hello, I want to buy goods on credit." from an unregistered number → no account data shared; escalate new_contact.
