import { z } from "zod";
import { balanceOf, displayDate, endOfLagosDay, lagosDate, nextId, withCtx } from "../../lib/desk.js";
import { formatKobo, moneyFields } from "../../lib/money.js";
import { amountFields, defineTool, isResult, phone, resolveAmount, retailerOr } from "./common.js";

const DAY = 86_400_000;

export default defineTool({
  name: "record_promise",
  description:
    "Call when a trader promises to pay an amount by a date. Records it (status recorded) if the date is within 14 days; returns too_far for later dates (escalate as extension_request instead), invalid_amount or invalid_date.",
  inputSchema: {
    phone,
    ...amountFields,
    due_date: z.string().describe("Date the trader will pay by, YYYY-MM-DD (Lagos time)."),
  },
  handler: async (args) =>
    withCtx((ctx) => {
      const r = retailerOr(ctx, args.phone);
      if (isResult(r)) return r;
      const amount = resolveAmount(args);
      const bal = balanceOf(ctx, r);
      if (amount === null || amount <= 0 || amount > bal.balance_due_kobo + bal.disputed_kobo) {
        return { status: "invalid_amount", message: "Promise amount must be more than zero and not more than the balance due.", ...moneyFields("balance_due", bal.balance_due_kobo) };
      }
      const ymd = String(args.due_date).trim().slice(0, 10);
      const today = lagosDate(ctx.now);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || Number.isNaN(Date.parse(ymd)) || ymd < today) {
        return { status: "invalid_date", message: `due_date must be YYYY-MM-DD, today (${today}) or later.`, today };
      }
      const due = endOfLagosDay(ymd);
      const daysOut = Math.round((Date.parse(`${ymd}T00:00:00+01:00`) - Date.parse(`${today}T00:00:00+01:00`)) / DAY);
      if (daysOut > 14) {
        return { status: "too_far", days_out: daysOut, max_days: 14, message: "More than 14 days away. Only the owner can agree to this; escalate with reason extension_request." };
      }
      const promise_id = nextId(ctx.db.Promises.map((x) => x.promise_id), "P-");
      ctx.db.Promises.push({ promise_id, retailer_id: r.retailer_id, amount_kobo: amount, due_at: due, created_at: ctx.now.toISOString(), status: "open" });
      ctx.touch("Promises");
      return { status: "recorded", promise_id, ...moneyFields("amount", amount), due_at: due, due_display: displayDate(due), days_out: daysOut, ...moneyFields("balance_due", bal.balance_due_kobo), amount_text: formatKobo(amount) };
    }),
});
