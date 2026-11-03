export type Tier = "A" | "B" | "C";

export interface Retailer {
  retailer_id: string;
  name: string;
  shop_name: string;
  phone: string;
  market: string;
  credit_limit_kobo: number;
  tier: Tier;
  dva_bank: string;
  dva_account_number: string;
  paystack_customer_code: string;
  email: string;
  last_stock_check_at: string;
}

export interface Product {
  sku: string;
  name: string;
  unit: string;
  price_kobo: number;
  units_on_hand: number;
  reorder_point: number;
}

export interface InvoiceItem {
  sku: string;
  qty: number;
  unit_price_kobo: number;
}

export type InvoiceStatus = "open" | "part_paid" | "paid" | "disputed";

export interface Invoice {
  invoice_id: string;
  retailer_id: string;
  issued_at: string;
  due_at: string;
  items_json: string;
  amount_kobo: number;
  paid_kobo: number;
  status: InvoiceStatus;
  disputed_reason: string;
}

export interface Allocation {
  invoice_id: string;
  amount_kobo: number;
  /** When this slice was applied (credit may be applied later than paid_at). */
  applied_at?: string;
}

export interface Payment {
  reference: string;
  retailer_id: string;
  amount_kobo: number;
  paid_at: string;
  channel: string;
  source: "webhook" | "verify" | "seed";
  allocations_json: string;
  unapplied_kobo: number;
  /** When check_payments last told the trader about this payment ("" = not yet). */
  reported_at: string;
}

export interface PaymentRequest {
  reference: string;
  retailer_id: string;
  amount_kobo: number;
  created_at: string;
  status: "pending" | "paid" | "abandoned";
  authorization_url: string;
}

export interface PromiseRow {
  promise_id: string;
  retailer_id: string;
  amount_kobo: number;
  due_at: string;
  created_at: string;
  status: "open" | "kept" | "broken";
}

export interface StockCheck {
  retailer_id: string;
  sku: string;
  units_left: number;
  checked_at: string;
}

export interface Escalation {
  ticket_id: string;
  retailer_id: string;
  phone: string;
  reason: string;
  summary: string;
  invoice_id: string;
  created_at: string;
  status: "open" | "resolved";
}

export interface ScorecardRow {
  retailer_id: string;
  name: string;
  tier: Tier;
  balance_kobo: number;
  credit_limit_kobo: number;
  cash_return_rate_30d: number | "";
  avg_days_to_pay: number | "";
  sell_through_units_per_day: number | "";
  sell_through_source: "reported" | "inferred" | "none";
  promise_reliability: number | "";
  flags: string;
  suggested_limit_kobo: number;
  recommendation: string;
  updated_at: string;
}

export interface Db {
  Retailers: Retailer[];
  Products: Product[];
  Invoices: Invoice[];
  Payments: Payment[];
  PaymentRequests: PaymentRequest[];
  Promises: PromiseRow[];
  StockChecks: StockCheck[];
  Escalations: Escalation[];
  Scorecard: ScorecardRow[];
}

export type TabName = keyof Db;

/** Column order per tab (row 1 of each sheet). */
export const HEADERS: { [K in TabName]: (keyof Db[K][number])[] } = {
  Retailers: [
    "retailer_id", "name", "shop_name", "phone", "market", "credit_limit_kobo", "tier",
    "dva_bank", "dva_account_number", "paystack_customer_code", "email", "last_stock_check_at",
  ],
  Products: ["sku", "name", "unit", "price_kobo", "units_on_hand", "reorder_point"],
  Invoices: [
    "invoice_id", "retailer_id", "issued_at", "due_at", "items_json", "amount_kobo", "paid_kobo",
    "status", "disputed_reason",
  ],
  Payments: [
    "reference", "retailer_id", "amount_kobo", "paid_at", "channel", "source", "allocations_json",
    "unapplied_kobo", "reported_at",
  ],
  PaymentRequests: ["reference", "retailer_id", "amount_kobo", "created_at", "status", "authorization_url"],
  Promises: ["promise_id", "retailer_id", "amount_kobo", "due_at", "created_at", "status"],
  StockChecks: ["retailer_id", "sku", "units_left", "checked_at"],
  Escalations: ["ticket_id", "retailer_id", "phone", "reason", "summary", "invoice_id", "created_at", "status"],
  Scorecard: [
    "retailer_id", "name", "tier", "balance_kobo", "credit_limit_kobo", "cash_return_rate_30d",
    "avg_days_to_pay", "sell_through_units_per_day", "sell_through_source", "promise_reliability",
    "flags", "suggested_limit_kobo", "recommendation", "updated_at",
  ],
};

/** Columns that hold numbers (coerced on read). */
export const NUMERIC = new Set([
  "credit_limit_kobo", "price_kobo", "units_on_hand", "reorder_point", "amount_kobo", "paid_kobo",
  "unapplied_kobo", "units_left", "balance_kobo", "suggested_limit_kobo",
]);

export const TABS = Object.keys(HEADERS) as TabName[];
