/**
 * Fractional ranks for manual ordering (Kanban columns). A rank is a base-36 string compared
 * byte-wise; there is always a rank strictly between two others, so moving a card is a single
 * document write and never renumbers the column. Ranks never end in '0', which keeps the
 * "between" operation total.
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

export const RANK_PATTERN = /^[0-9a-z]*[1-9a-z]$/;
export const MAX_RANK_LENGTH = 128;
/** Past this length the caller should re-space the column (see evenRanks). */
export const REBALANCE_LENGTH = 32;

function digit(s: string, i: number): number {
  return DIGITS.indexOf(s[i] ?? '0');
}

/** Rank strictly between `a` and `b`. `a = ''` means "start of list", `b = null` means "end of list". */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const lo = a ? digit(a, 0) : 0;
  const hi = b !== null ? digit(b, 0) : BASE;
  if (hi - lo > 1) return DIGITS[Math.round((lo + hi) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[lo]! + midpoint(a.slice(1), null);
}

/**
 * Rank after `a` with nothing above it: bump the most significant digit that can still grow and drop
 * the rest. Appending (the most common move) therefore grows ranks by one character per ~17 appends
 * instead of one per ~5 with plain halving.
 */
function after(a: string): string {
  for (let i = 0; i < a.length; i++) {
    const d = digit(a, i);
    if (d < BASE - 1) return a.slice(0, i) + DIGITS[d + 1]!;
  }
  return `${a}i`;
}

export class RankOrderError extends Error {}

/** Rank for an item placed after `prev` and before `next` (either may be null for the list ends). */
export function rankBetween(prev: string | null, next: string | null): string {
  if (prev !== null && !RANK_PATTERN.test(prev)) throw new RankOrderError(`invalid rank "${prev}"`);
  if (next !== null && !RANK_PATTERN.test(next)) throw new RankOrderError(`invalid rank "${next}"`);
  if (prev !== null && next !== null && prev >= next) throw new RankOrderError(`"${prev}" is not before "${next}"`);
  if (next === null) return prev === null ? 'i' : after(prev);
  return midpoint(prev ?? '', next);
}

/**
 * `count` evenly spaced, equal-width ranks in the middle half of the key space, leaving room above and
 * below for later inserts. Each ends in 'i' so none ends in '0'.
 */
export function evenRanks(count: number): string[] {
  let width = 1;
  while (BASE ** width < 4 * (count + 1)) width++;
  const space = BASE ** width;
  const step = space / 2 / (count + 1);
  return Array.from({ length: count }, (_, i) => `${Math.floor(space / 4 + step * (i + 1)).toString(BASE).padStart(width, '0')}i`);
}
