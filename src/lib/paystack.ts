/**
 * Paystack REST client (test mode). A secret starting with `sk_test_mock` short-circuits all calls
 * so the server can run locally without network access.
 */
import crypto from "node:crypto";

const BASE = "https://api.paystack.co";
const secret = () => process.env.PAYSTACK_SECRET_KEY ?? "";
export const isMock = () => secret().startsWith("sk_test_mock");

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!secret()) throw new Error("PAYSTACK_SECRET_KEY not set");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || json.status === false) {
    const err = new Error(`Paystack ${method} ${path} → ${res.status}: ${json.message ?? "unknown error"}`);
    (err as any).httpStatus = res.status;
    throw err;
  }
  return json.data as T;
}

export interface InitResult {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export async function initializeTransaction(args: {
  email: string;
  amount_kobo: number;
  reference: string;
  retailer_id: string;
}): Promise<InitResult> {
  if (isMock()) {
    return { authorization_url: `https://checkout.paystack.com/mock-${args.reference}`, access_code: "mock", reference: args.reference };
  }
  return call<InitResult>("POST", "/transaction/initialize", {
    email: args.email,
    amount: args.amount_kobo,
    reference: args.reference,
    currency: "NGN",
    channels: ["bank_transfer", "card", "ussd"],
    callback_url: process.env.PAYSTACK_CALLBACK_URL || undefined,
    metadata: { retailer_id: args.retailer_id },
  });
}

export interface VerifyResult {
  status: string; // success | abandoned | failed | ongoing | pending | reversed
  amount: number;
  reference: string;
  paid_at: string | null;
  channel: string;
  metadata?: { retailer_id?: string } | null;
  customer?: { customer_code?: string; email?: string };
}

/** Verify a reference. Returns null when Paystack has no such transaction yet (404). */
export async function verifyTransaction(reference: string): Promise<VerifyResult | null> {
  if (isMock()) return { status: "abandoned", amount: 0, reference, paid_at: null, channel: "" };
  try {
    return await call<VerifyResult>("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
  } catch (e: any) {
    if (e.httpStatus === 404 || e.httpStatus === 400) return null;
    throw e;
  }
}

/** Dedicated virtual account (stretch, behind USE_DEDICATED_ACCOUNTS). */
export async function ensureDedicatedAccount(args: {
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  customer_code?: string;
}): Promise<{ customer_code: string; bank_name: string; account_number: string; account_name: string }> {
  let code = args.customer_code;
  if (!code) {
    const c = await call<{ customer_code: string }>("POST", "/customer", {
      email: args.email,
      first_name: args.first_name,
      last_name: args.last_name,
      phone: args.phone,
    });
    code = c.customer_code;
  }
  const dva = await call<any>("POST", "/dedicated_account", { customer: code, preferred_bank: "test-bank" });
  return {
    customer_code: code,
    bank_name: dva.bank?.name ?? "",
    account_number: dva.account_number ?? "",
    account_name: dva.account_name ?? "",
  };
}

/** x-paystack-signature = HMAC-SHA512(raw body, secret key), hex. Timing-safe compare. */
export function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !secret()) return false;
  const expected = crypto.createHmac("sha512", secret()).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function sign(rawBody: Buffer | string): string {
  return crypto.createHmac("sha512", secret()).update(rawBody).digest("hex");
}
