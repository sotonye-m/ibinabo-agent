import type { Request, Response } from "express";
import { recordPayment, withCtx } from "../lib/desk.js";
import { verifySignature } from "../lib/paystack.js";

/** POST /webhooks/paystack — mounted with express.raw so the signature is checked on the exact bytes. */
export async function paystackWebhook(req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!verifySignature(raw, req.header("x-paystack-signature"))) {
    console.warn("[paystack] bad signature");
    return res.status(401).json({ status: "invalid_signature" });
  }
  let event: any;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ status: "bad_json" });
  }
  console.log(`[paystack] ${event.event} ${event.data?.reference} ${event.data?.amount} ${event.data?.channel}`);
  if (event.event !== "charge.success") return res.status(200).json({ status: "ignored" });

  try {
    const d = event.data ?? {};
    const result = await withCtx((ctx) => {
      const byMeta = d.metadata?.retailer_id;
      const byCustomer = d.customer?.customer_code;
      const byRequest = ctx.db.PaymentRequests.find((r) => r.reference === d.reference)?.retailer_id;
      const retailer =
        ctx.db.Retailers.find((r) => r.retailer_id === byMeta) ??
        ctx.db.Retailers.find((r) => r.retailer_id === byRequest) ??
        ctx.db.Retailers.find((r) => byCustomer && r.paystack_customer_code === byCustomer) ??
        ctx.db.Retailers.find((r) => d.customer?.email && r.email.toLowerCase() === String(d.customer.email).toLowerCase());
      if (!retailer) return { status: "unmatched" as const };
      const out = recordPayment(ctx, {
        reference: String(d.reference),
        retailer_id: retailer.retailer_id,
        amount_kobo: Number(d.amount),
        paid_at: d.paid_at ? new Date(d.paid_at).toISOString() : ctx.now.toISOString(),
        channel: String(d.channel ?? "paystack"),
        source: "webhook",
      });
      return { status: out.duplicate ? ("duplicate" as const) : ("recorded" as const), retailer_id: retailer.retailer_id };
    });
    console.log(`[paystack] ${d.reference} → ${result.status}`);
    return res.status(200).json(result);
  } catch (e: any) {
    console.error("[paystack] failed to record", e);
    // 500 so Paystack retries; recording is idempotent on reference.
    return res.status(500).json({ status: "system_error" });
  }
}
