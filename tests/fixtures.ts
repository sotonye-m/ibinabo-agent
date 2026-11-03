import { emptyDb } from "../src/lib/sheets.js";
import type { Db, Invoice, Payment, Retailer } from "../src/lib/types.js";

export const NOW = new Date("2026-11-03T12:00:00.000Z");
export const d = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString();

export function inv(id: string, issuedDay: number, amount: number, extra: Partial<Invoice> = {}): Invoice {
  return {
    invoice_id: id, retailer_id: "R1", issued_at: d(issuedDay), due_at: d(issuedDay + 10),
    items_json: JSON.stringify([{ sku: "IND-CTN", qty: 1, unit_price_kobo: amount }]),
    amount_kobo: amount, paid_kobo: 0, status: "open", disputed_reason: "", ...extra,
  };
}

export function pay(ref: string, day: number, amount: number, extra: Partial<Payment> = {}): Payment {
  return { reference: ref, retailer_id: "R1", amount_kobo: amount, paid_at: d(day), channel: "bank_transfer", source: "seed", allocations_json: "[]", unapplied_kobo: 0, reported_at: d(day), ...extra };
}

export function retailer(id = "R1", limit = 100_000_00): Retailer {
  return { retailer_id: id, name: `Trader ${id}`, shop_name: `Shop ${id}`, phone: "+2348030000001", market: "Mile 1", credit_limit_kobo: limit, tier: "B", dva_bank: "", dva_account_number: "", paystack_customer_code: "", email: "", last_stock_check_at: "" };
}

export function db(partial: Partial<Db>): Db {
  return { ...emptyDb(), ...partial };
}
