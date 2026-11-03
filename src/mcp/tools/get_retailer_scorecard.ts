import { z } from "zod";
import { withCtx } from "../../lib/desk.js";
import { defineTool, isResult, ownerCheck, phone, pin } from "./common.js";
import { findOne, scoreView } from "./owner_shared.js";

export default defineTool({
  name: "get_retailer_scorecard",
  description:
    "Owner only. Returns one trader's scorecard: tier, balance vs limit, cash return rate, average days to pay, sell-through and its source, promise reliability, flags, suggested limit and a recommendation. Fuzzy-matches the trader's name or id; returns ambiguous with matches if more than one fits.",
  inputSchema: { phone, pin, retailer: z.string().describe("Trader name, shop name or id, e.g. 'Iya Basira' or R002") },
  handler: async (args) => {
    const denied = ownerCheck(args.phone, args.pin);
    if (denied) return denied;
    return withCtx((ctx) => {
      const r = findOne(ctx, args.retailer);
      if (isResult(r)) return r;
      return { status: "ok", ...scoreView(ctx.score(r.retailer_id)!) };
    });
  },
});
