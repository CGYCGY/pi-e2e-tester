/**
 * hub/format.ts — tiny display formatters for the hub UI.
 *
 * Ported verbatim from pi-4b-tester's shared/format.ts. Kept hub-LOCAL (not under
 * shared/) because phase 1 only the hub renders a widget/footer, and shared/ is
 * owned by the foundation — this is the "hub-local helper file" the spec permits.
 */

/** Compact token count: 999 → "999", 272000 → "272k", 1_500_000 → "1.5M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Percent with up to 2 decimals, trailing zeros stripped: 5 → "5", 2.1106 → "2.11". */
export function fmtPct(n: number): string {
  return String(parseFloat(n.toFixed(2)));
}
