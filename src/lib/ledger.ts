/**
 * Ledger rules (SPEC §6). Pure functions: inputs are never mutated; updated copies are returned.
 */
import type { Allocation, Invoice, Payment, PromiseRow, Tier } from "./types.js";

const DAY = 86_400_000;

export function invoiceLeft(inv: Invoice): number {
  return Math.max(0, inv.amount_kobo - inv.paid_kobo);
}

export function isOpen(inv: Invoice): boolean {
  return inv.status === "open" || inv.status === "part_paid";
}

export function parseAllocations(p: Payment): Allocation[] {
  try {
    const a = JSON.parse(p.allocations_json || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export interface BalanceSummary {
  /** Owed on open/part_paid invoices, before credit. */
  owed_kobo: number;
  /** Left on disputed invoices (excluded from balance_due). */
  disputed_kobo: number;
  /** Net amount due after unapplied credit. */
  balance_due_kobo: number;
  /** Unapplied credit left over after netting against owed. */
  credit_kobo: number;
}

export function summarise(invoices: Invoice[], payments: Payment[], retailerId: string): BalanceSummary {
  let owed = 0;
  let disputed = 0;
  for (const inv of invoices) {
    if (inv.retailer_id !== retailerId) continue;
    if (isOpen(inv)) owed += invoiceLeft(inv);
    else if (inv.status === "disputed") disputed += invoiceLeft(inv);
  }
  const unapplied = payments
    .filter((p) => p.retailer_id === retailerId)
    .reduce((s, p) => s + (p.unapplied_kobo || 0), 0);
  return {
    owed_kobo: owed,
    disputed_kobo: disputed,
    balance_due_kobo: Math.max(0, owed - unapplied),
    credit_kobo: Math.max(0, unapplied - owed),
  };
}

function settle(inv: Invoice, add: number): Invoice {
  const paid = inv.paid_kobo + add;
  return { ...inv, paid_kobo: paid, status: paid >= inv.amount_kobo ? "paid" : paid > 0 ? "part_paid" : inv.status };
}

/**
 * Allocate an amount across a retailer's open invoices, oldest issued_at first, skipping disputed.
 * Returns updated copies of the touched invoices (and untouched ones unchanged).
 */
export function allocate(
  invoices: Invoice[],
  retailerId: string,
  amountKobo: number,
  appliedAt: string,
): { invoices: Invoice[]; allocations: Allocation[]; unapplied_kobo: number } {
  let remaining = amountKobo;
  const allocations: Allocation[] = [];
  const order = invoices
    .map((inv, idx) => ({ inv, idx }))
    .filter(({ inv }) => inv.retailer_id === retailerId && isOpen(inv) && invoiceLeft(inv) > 0)
    .sort((a, b) => a.inv.issued_at.localeCompare(b.inv.issued_at) || a.inv.invoice_id.localeCompare(b.inv.invoice_id));
  const out = invoices.slice();
  for (const { inv, idx } of order) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, invoiceLeft(inv));
    out[idx] = settle(inv, take);
    allocations.push({ invoice_id: inv.invoice_id, amount_kobo: take, applied_at: appliedAt });
    remaining -= take;
  }
  return { invoices: out, allocations, unapplied_kobo: remaining };
}

export interface NewPayment {
  reference: string;
  retailer_id: string;
  amount_kobo: number;
  paid_at: string;
  channel: string;
  source: Payment["source"];
}

/**
 * Record a payment idempotently (keyed on reference) and allocate it.
 * If the reference already exists, returns the existing payment unchanged with duplicate=true.
 */
export function applyPayment(
  state: { invoices: Invoice[]; payments: Payment[] },
  p: NewPayment,
): { duplicate: boolean; payment: Payment; invoices: Invoice[]; payments: Payment[] } {
  const existing = state.payments.find((x) => x.reference === p.reference);
  if (existing) return { duplicate: true, payment: existing, invoices: state.invoices, payments: state.payments };
  const { invoices, allocations, unapplied_kobo } = allocate(state.invoices, p.retailer_id, p.amount_kobo, p.paid_at);
  const payment: Payment = {
    ...p,
    allocations_json: JSON.stringify(allocations),
    unapplied_kobo,
    reported_at: "",
  };
  return { duplicate: false, payment, invoices, payments: [...state.payments, payment] };
}

/**
 * Apply a retailer's unapplied credit (oldest payment first) to a newly created invoice.
 */
export function applyCreditToInvoice(
  invoice: Invoice,
  payments: Payment[],
  appliedAt: string,
): { invoice: Invoice; payments: Payment[]; applied_kobo: number } {
  let inv = invoice;
  let applied = 0;
  const order = payments
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => p.retailer_id === invoice.retailer_id && p.unapplied_kobo > 0)
    .sort((a, b) => a.p.paid_at.localeCompare(b.p.paid_at));
  const out = payments.slice();
  for (const { p, idx } of order) {
    const left = invoiceLeft(inv);
    if (left <= 0) break;
    const take = Math.min(left, p.unapplied_kobo);
    inv = settle(inv, take);
    applied += take;
    const allocs = parseAllocations(p);
    allocs.push({ invoice_id: inv.invoice_id, amount_kobo: take, applied_at: appliedAt });
    out[idx] = { ...p, unapplied_kobo: p.unapplied_kobo - take, allocations_json: JSON.stringify(allocs) };
  }
  return { invoice: inv, payments: out, applied_kobo: applied };
}

/** Promise status, recomputed on read (SPEC §6). */
export function promiseStatus(promise: PromiseRow, payments: Payment[], now: Date): PromiseRow["status"] {
  const paid = payments
    .filter(
      (p) => p.retailer_id === promise.retailer_id && p.paid_at >= promise.created_at && p.paid_at <= promise.due_at,
    )
    .reduce((s, p) => s + p.amount_kobo, 0);
  if (paid >= promise.amount_kobo) return "kept";
  if (now.getTime() > Date.parse(promise.due_at)) return "broken";
  return "open";
}

export interface CreditCheck {
  approved: boolean;
  exposure_after_kobo: number;
  unlock_amount_kobo: number;
  max_order_value_kobo: number;
}

export function creditCheck(args: {
  balance_due_kobo: number;
  disputed_kobo: number;
  order_total_kobo: number;
  credit_limit_kobo: number;
}): CreditCheck {
  const exposure = args.balance_due_kobo + args.disputed_kobo + args.order_total_kobo;
  const approved = exposure <= args.credit_limit_kobo;
  return {
    approved,
    exposure_after_kobo: exposure,
    unlock_amount_kobo: approved ? 0 : exposure - args.credit_limit_kobo,
    max_order_value_kobo: Math.max(0, args.credit_limit_kobo - args.balance_due_kobo - args.disputed_kobo),
  };
}

export const TERMS_DAYS: Record<Tier, number> = { A: 14, B: 10, C: 7 };

export function dueDateFor(tier: Tier, issuedAt: string): string {
  const days = TERMS_DAYS[tier] ?? TERMS_DAYS.B;
  return new Date(Date.parse(issuedAt) + days * DAY).toISOString();
}

/** When an invoice became fully paid: the latest allocation timestamp among payments that touched it. */
export function invoicePaidAt(inv: Invoice, payments: Payment[]): string | null {
  if (inv.status !== "paid") return null;
  let latest: string | null = null;
  for (const p of payments) {
    if (p.retailer_id !== inv.retailer_id) continue;
    for (const a of parseAllocations(p)) {
      if (a.invoice_id !== inv.invoice_id) continue;
      const t = a.applied_at || p.paid_at;
      if (!latest || t > latest) latest = t;
    }
  }
  return latest;
}
