/** Money is kobo (integer) internally. 100 kobo = ₦1. */

export function nairaToKobo(naira: number): number {
  return Math.round(naira * 100);
}

/** ₦84,500 — kobo shown only when non-zero (₦84,500.50). */
export function formatKobo(kobo: number): string {
  const neg = kobo < 0;
  const abs = Math.abs(Math.round(kobo));
  const naira = Math.floor(abs / 100);
  const rem = abs % 100;
  const body = naira.toLocaleString("en-NG");
  const s = rem ? `₦${body}.${String(rem).padStart(2, "0")}` : `₦${body}`;
  return neg ? `-${s}` : s;
}

/** Money pair used in every tool output. */
export function money(kobo: number): { kobo: number; display: string } {
  return { kobo, display: formatKobo(kobo) };
}

/** Spread as `{<name>_kobo, <name>_display}`. */
export function moneyFields<N extends string>(name: N, kobo: number) {
  return { [`${name}_kobo`]: kobo, [`${name}_display`]: formatKobo(kobo) } as Record<`${N}_kobo`, number> &
    Record<`${N}_display`, string>;
}

/** Round to nearest ₦5,000 (500,000 kobo). */
export function roundTo5k(kobo: number): number {
  return Math.round(kobo / 500_000) * 500_000;
}
