import { z } from "zod";
import { withCtx } from "../../lib/desk.js";
import { moneyFields } from "../../lib/money.js";
import { amountFields, defineTool, isResult, ownerCheck, phone, pin, resolveAmount } from "./common.js";
import { findOne } from "./owner_shared.js";

export default defineTool({
  name: "update_credit_limit",
  description:
    "Owner only. Changes a trader's credit limit. Only call after the owner has explicitly confirmed (replied YES) and pass approved_by: \"owner\"; without it returns confirmation_required. Give the new limit in naira (new_limit_naira) as the owner said it.",
  inputSchema: {
    phone,
    pin,
    retailer: z.string().describe("Trader name, shop name or id"),
    new_limit_naira: amountFields.amount_naira.describe("New limit in naira, e.g. 100000 for ₦100,000"),
    new_limit_kobo: amountFields.amount_kobo.describe("New limit in kobo (alternative to new_limit_naira)"),
    approved_by: z.string().optional().describe('Must be "owner", and only after the owner replied YES to the confirmation.'),
  },
  handler: async (args) => {
    const denied = ownerCheck(args.phone, args.pin);
    if (denied) return denied;
    return withCtx((ctx) => {
      const r = findOne(ctx, args.retailer);
      if (isResult(r)) return r;
      const newLimit = resolveAmount({ amount_naira: args.new_limit_naira, amount_kobo: args.new_limit_kobo });
      if (newLimit === null || newLimit < 0) return { status: "invalid_amount", message: "Give the new limit in naira." };
      if (args.approved_by !== "owner") {
        return { status: "confirmation_required", retailer_id: r.retailer_id, name: r.name, ...moneyFields("old_limit", r.credit_limit_kobo), ...moneyFields("new_limit", newLimit), message: "Ask the owner to reply YES, then call again with approved_by: \"owner\"." };
      }
      const old = r.credit_limit_kobo;
      r.credit_limit_kobo = newLimit;
      ctx.touch("Retailers");
      return { status: "updated", retailer_id: r.retailer_id, name: r.name, ...moneyFields("old_limit", old), ...moneyFields("new_limit", newLimit) };
    });
  },
});
