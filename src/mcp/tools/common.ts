import { z } from "zod";
import type { Ctx } from "../../lib/desk.js";
import { findRetailerByPhone, isOwner, normalisePhone } from "../../lib/identity.js";
import { nairaToKobo } from "../../lib/money.js";
import type { Product, Retailer } from "../../lib/types.js";

export type Result = { status: string; [k: string]: unknown };

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<Result>;
}

export function defineTool<S extends z.ZodRawShape>(t: ToolDef<S>): ToolDef<S> {
  return t;
}

export const phone = z
  .string()
  .describe("The sender's WhatsApp phone number, e.g. +2348030000001 or 08030000001.");

export const pin = z.string().optional().describe("Owner PIN. Only needed if the owner's phone number is not recognised.");

/** Amounts: prefer naira as the trader said it; kobo also accepted. Code converts. */
export const amountFields = {
  amount_naira: z.coerce.number().optional().describe("Amount in naira exactly as the trader said it, e.g. 20000 for ₦20,000."),
  amount_kobo: z.coerce.number().int().optional().describe("Amount in kobo (₦1 = 100 kobo). Use amount_naira instead if unsure."),
};

export function resolveAmount(a: { amount_naira?: number; amount_kobo?: number }): number | null {
  if (typeof a.amount_naira === "number" && Number.isFinite(a.amount_naira)) return nairaToKobo(a.amount_naira);
  if (typeof a.amount_kobo === "number" && Number.isFinite(a.amount_kobo)) return Math.round(a.amount_kobo);
  return null;
}

export function retailerOr(ctx: Ctx, p: string): Retailer | Result {
  const r = findRetailerByPhone(ctx.db, p);
  if (r) return r;
  return {
    status: "not_retailer",
    phone: normalisePhone(p),
    message: "This phone number is not registered as an Ibinabo Distribution trader.",
  };
}

export function ownerCheck(p: string, ownerPin?: string): Result | null {
  if (isOwner(p, ownerPin)) return null;
  return { status: "not_owner", message: "Owner tools are only available to the owner's registered number." };
}

export const isResult = (x: unknown): x is Result => typeof x === "object" && x !== null && "status" in x;

const ALIASES: Record<string, string[]> = {
  noodles: ["indomie"],
  noodle: ["indomie"],
  milk: ["peak"],
  pasta: ["spaghetti"],
  coke: ["coca", "cola"],
  oil: ["kings", "vegetable"],
  groundnut: ["oil"],
  water: ["eva"],
};

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !["of", "and", "the", "carton", "cartons", "bag", "bags", "pack", "packs", "keg", "kegs", "50kg", "25l"].includes(t));
}

/** Match a product by exact SKU or fuzzy name. */
export function matchProduct(products: Product[], query: string): { product: Product } | { suggestions: string[] } {
  const q = query.trim().toLowerCase();
  const bySku = products.find((p) => p.sku.toLowerCase() === q);
  if (bySku) return { product: bySku };
  const qt = tokens(q).flatMap((t) => [t, ...(ALIASES[t] ?? [])]);
  const scored = products
    .map((p) => {
      const hay = `${p.sku} ${p.name}`.toLowerCase();
      return { p, hits: qt.filter((t) => hay.includes(t)).length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (scored.length && (scored.length === 1 || scored[0].hits > scored[1].hits)) return { product: scored[0].p };
  const sugg = (scored.length ? scored.map((x) => x.p) : products).map((p) => `${p.name} (${p.sku})`);
  return { suggestions: sugg.slice(0, 5) };
}
