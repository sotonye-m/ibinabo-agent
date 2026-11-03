import type { Db, Retailer } from "./types.js";

/** Normalise a Nigerian phone number to E.164: 0803… / 234803… / +234 803 … → +234803… */
export function normalisePhone(raw: string | undefined | null): string {
  if (!raw) return "";
  let s = String(raw).trim();
  // Chord / WhatsApp ids sometimes look like "2348030000001@s.whatsapp.net" or "whatsapp:+234…"
  s = s.replace(/^whatsapp:/i, "").replace(/@.*$/, "");
  const plus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return "";
  if (plus) return `+${digits}`;
  if (digits.startsWith("234")) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+234${digits.slice(1)}`;
  if (digits.length === 10) return `+234${digits}`; // 803xxxxxxx
  return `+${digits}`;
}

export function ownerPhones(): string[] {
  return (process.env.OWNER_PHONES ?? "")
    .split(",")
    .map((p) => normalisePhone(p))
    .filter(Boolean);
}

export type Role = "retailer" | "owner" | "unknown";

export function isOwner(phone: string, pin?: string): boolean {
  const p = normalisePhone(phone);
  if (p && ownerPhones().includes(p)) return true;
  const ownerPin = process.env.OWNER_PIN;
  return Boolean(ownerPin && pin && String(pin).trim() === ownerPin);
}

export function findRetailerByPhone(db: Db, phone: string): Retailer | undefined {
  const p = normalisePhone(phone);
  if (!p) return undefined;
  return db.Retailers.find((r) => normalisePhone(r.phone) === p);
}

export function roleFor(db: Db, phone: string, pin?: string): Role {
  if (isOwner(phone, pin)) return "owner";
  return findRetailerByPhone(db, phone) ? "retailer" : "unknown";
}

/** Simple fuzzy match on name / shop / id: returns all retailers whose tokens match the query. */
export function matchRetailers(db: Db, query: string): Retailer[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = db.Retailers.filter(
    (r) => r.retailer_id.toLowerCase() === q || r.name.toLowerCase() === q || r.shop_name.toLowerCase() === q,
  );
  if (exact.length) return exact;
  const all = q.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  const meaningful = all.filter((t) => !STOP.has(t));
  const tokens = meaningful.length ? meaningful : all;
  if (!tokens.length) return [];
  const scored = db.Retailers.map((r) => {
    const hay = `${r.retailer_id} ${r.name} ${r.shop_name}`.toLowerCase();
    const hits = tokens.filter((t) => hay.includes(t)).length;
    return { r, hits };
  }).filter((x) => x.hits > 0);
  if (!scored.length) return [];
  const best = Math.max(...scored.map((x) => x.hits));
  return scored.filter((x) => x.hits === best).map((x) => x.r);
}

const STOP = new Set(["the", "and", "mama", "iya", "chief", "alhaji", "stores", "store", "shop", "ltd", "&"]);
