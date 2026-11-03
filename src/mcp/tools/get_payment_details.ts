import { balanceOf, withCtx } from "../../lib/desk.js";
import { ensureDedicatedAccount, initializeTransaction } from "../../lib/paystack.js";
import { formatKobo, moneyFields } from "../../lib/money.js";
import { amountFields, defineTool, isResult, phone, resolveAmount, retailerOr } from "./common.js";

export default defineTool({
  name: "get_payment_details",
  description:
    "Call when a trader wants to pay. Creates a Paystack payment for the amount and returns where to pay (a checkout link, or a bank account) plus a reference. Payments confirm automatically; the trader does not need to send a screenshot.",
  inputSchema: { phone, ...amountFields },
  handler: async (args) =>
    withCtx(async (ctx) => {
      const r = retailerOr(ctx, args.phone);
      if (isResult(r)) return r;
      const amount = resolveAmount(args);
      const bal = balanceOf(ctx, r);
      const max = Math.round(bal.balance_due_kobo * 1.1);
      if (amount === null || amount <= 0 || amount > max) {
        return {
          status: "invalid_amount",
          message: amount === null || amount <= 0 ? "Amount must be more than zero." : `Amount is more than the balance due (${formatKobo(bal.balance_due_kobo)}).`,
          ...moneyFields("balance_due", bal.balance_due_kobo),
          ...moneyFields("max_payable", max),
        };
      }

      if (process.env.USE_DEDICATED_ACCOUNTS === "true") {
        if (!r.dva_account_number) {
          const [first, ...rest] = r.name.split(" ");
          const dva = await ensureDedicatedAccount({ email: r.email, first_name: first, last_name: rest.join(" ") || r.shop_name, phone: r.phone, customer_code: r.paystack_customer_code || undefined });
          Object.assign(r, { paystack_customer_code: dva.customer_code, dva_bank: dva.bank_name, dva_account_number: dva.account_number });
          ctx.dirty.add("Retailers");
        }
        return {
          status: "ok",
          method: "dedicated_account",
          bank_name: r.dva_bank,
          account_number: r.dva_account_number,
          account_name: `Ibinabo Distribution / ${r.shop_name}`,
          ...moneyFields("amount", amount),
          reference: null,
          note: "This account is only for you. Transfer any amount; no need to send a screenshot, the payment confirms itself.",
        };
      }

      const reference = `IBN-${r.retailer_id}-${ctx.now.getTime()}`;
      const init = await initializeTransaction({ email: r.email, amount_kobo: amount, reference, retailer_id: r.retailer_id });
      ctx.db.PaymentRequests.push({
        reference,
        retailer_id: r.retailer_id,
        amount_kobo: amount,
        created_at: ctx.now.toISOString(),
        status: "pending",
        authorization_url: init.authorization_url,
      });
      ctx.dirty.add("PaymentRequests");
      return {
        status: "ok",
        method: "checkout",
        checkout_url: init.authorization_url,
        reference,
        ...moneyFields("amount", amount),
        note: "Pay with bank transfer, card or USSD on this Paystack page. No need to send a screenshot; the payment confirms itself.",
      };
    }),
});
