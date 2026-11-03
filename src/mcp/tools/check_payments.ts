import { balanceOf, describePayment, recordPayment, withCtx } from "../../lib/desk.js";
import { verifyTransaction } from "../../lib/paystack.js";
import { formatKobo, moneyFields } from "../../lib/money.js";
import { defineTool, isResult, phone, retailerOr } from "./common.js";

const DAY = 86_400_000;

export default defineTool({
  name: "check_payments",
  description:
    "Call when a trader says they have paid. Checks Paystack for payments not yet confirmed to the trader and returns status paid (with amounts, invoices cleared and new balance), overpaid (extra saved as credit) or not_found. Screenshots are never proof; only this tool is.",
  inputSchema: { phone },
  handler: async (args) =>
    withCtx(async (ctx) => {
      const r = retailerOr(ctx, args.phone);
      if (isResult(r)) return r;

      // 1. Verify pending checkout requests (covers missed webhooks).
      const verifyErrors: string[] = [];
      for (const req of ctx.db.PaymentRequests) {
        if (req.retailer_id !== r.retailer_id || req.status !== "pending") continue;
        if (ctx.now.getTime() - Date.parse(req.created_at) > 7 * DAY) {
          req.status = "abandoned";
          ctx.dirty.add("PaymentRequests");
          continue;
        }
        try {
          const v = await verifyTransaction(req.reference);
          if (v && v.status === "success") {
            recordPayment(ctx, {
              reference: req.reference,
              retailer_id: r.retailer_id,
              amount_kobo: v.amount,
              paid_at: v.paid_at ? new Date(v.paid_at).toISOString() : ctx.now.toISOString(),
              channel: v.channel || "paystack",
              source: "verify",
            });
          }
        } catch (e: any) {
          verifyErrors.push(`${req.reference}: ${e.message}`);
        }
      }

      // 2. Anything recorded (webhook or verify) that the trader hasn't been told about yet.
      const fresh = ctx.db.Payments.filter((p) => p.retailer_id === r.retailer_id && !p.reported_at);
      const bal = balanceOf(ctx, r);
      if (!fresh.length) {
        const pending = ctx.db.PaymentRequests.filter((x) => x.retailer_id === r.retailer_id && x.status === "pending");
        return {
          status: "not_found",
          message: "No new payment has reached Ibinabo's Paystack account yet.",
          pending_requests: pending.map((x) => ({ reference: x.reference, amount_display: formatKobo(x.amount_kobo), created_at: x.created_at, checkout_url: x.authorization_url })),
          ...moneyFields("current_balance", bal.balance_due_kobo),
          ...(verifyErrors.length ? { verify_errors: verifyErrors } : {}),
        };
      }
      for (const p of fresh) p.reported_at = ctx.now.toISOString();
      ctx.dirty.add("Payments");
      const received = fresh.map(describePayment);
      const total = fresh.reduce((s, p) => s + p.amount_kobo, 0);
      return {
        status: bal.credit_kobo > 0 ? "overpaid" : "paid",
        received,
        ...moneyFields("total_received", total),
        allocations: received.flatMap((x) => x.allocations),
        ...moneyFields("new_balance", bal.balance_due_kobo),
        ...moneyFields("credit", bal.credit_kobo),
        ...moneyFields("disputed", bal.disputed_kobo),
      };
    }),
});
