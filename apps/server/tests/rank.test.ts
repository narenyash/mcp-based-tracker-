import { describe, expect, it } from 'vitest';
import { evenRanks, rankBetween, RankOrderError, RANK_PATTERN } from '../src/db/rank';
import { withTestingStatus } from '../migrations/0002-tasks';

describe('rankBetween', () => {
  it('produces ranks strictly between the neighbours', () => {
    const cases: [string | null, string | null][] = [[null, null], [null, 'i'], ['i', null], ['a', 'b'], ['a', 'a1'], ['0i', '1'], ['zz', null], [null, '01']];
    for (const [a, b] of cases) {
      const r = rankBetween(a, b);
      expect(r).toMatch(RANK_PATTERN);
      if (a !== null) expect(r > a).toBe(true);
      if (b !== null) expect(r < b).toBe(true);
    }
  });

  it('survives many inserts at the same spot without collisions', () => {
    const ranks = [rankBetween(null, null)];
    let lo: string | null = null;
    // Always insert right after the first item: the worst case for growth.
    for (let i = 0; i < 300; i++) {
      const r = rankBetween(ranks[0]!, ranks[1] ?? null);
      ranks.splice(1, 0, r);
      lo = r;
    }
    expect(new Set(ranks).size).toBe(ranks.length);
    expect([...ranks].sort()).toEqual(ranks);
    expect(lo!.length).toBeLessThan(128);
  });

  it('appending grows slowly (about one character per 17 appends)', () => {
    let r: string | null = null;
    for (let i = 0; i < 170; i++) {
      const next = rankBetween(r, null);
      if (r !== null) expect(next > r).toBe(true);
      r = next;
    }
    expect(r!.length).toBeLessThanOrEqual(11);
  });

  it('evenRanks gives sorted, distinct, equal-width ranks with room at both ends', () => {
    for (const n of [1, 2, 35, 36, 1000, 5000]) {
      const ranks = evenRanks(n);
      expect(ranks).toHaveLength(n);
      expect(new Set(ranks).size).toBe(n);
      expect([...ranks].sort()).toEqual(ranks);
      expect(ranks.every((r) => RANK_PATTERN.test(r) && r.length === ranks[0]!.length)).toBe(true);
      expect(rankBetween(null, ranks[0]!).length).toBeLessThanOrEqual(ranks[0]!.length + 1);
      expect(rankBetween(ranks.at(-1)!, null).length).toBeLessThanOrEqual(ranks[0]!.length);
    }
  });

  it('rejects out-of-order or malformed neighbours', () => {
    expect(() => rankBetween('b', 'a')).toThrow(RankOrderError);
    expect(() => rankBetween('a', 'a')).toThrow(RankOrderError);
    expect(() => rankBetween('a0', null)).toThrow(RankOrderError);
  });
});

describe('0002 workflow backfill', () => {
  const base = [
    { id: 'todo', name: 'To do', category: 'todo', color: '#a3a3a3', order: 0 },
    { id: 'doing', name: 'Doing', category: 'in_progress', color: '#3b82f6', order: 1 },
    { id: 'done', name: 'Done', category: 'done', color: '#22c55e', order: 2 },
  ];

  it('inserts Testing before the first done status and renumbers', () => {
    expect(withTestingStatus(base)!.map((s) => [s.id, s.order])).toEqual([['todo', 0], ['doing', 1], ['testing', 2], ['done', 3]]);
  });

  it('leaves workflows that already have a testing status alone', () => {
    expect(withTestingStatus(withTestingStatus(base)!)).toBeNull();
  });

  it('avoids an id clash with an existing "testing" status', () => {
    const clash = [...base.slice(0, 2), { id: 'testing', name: 'Legacy', category: 'in_progress', color: '#000000', order: 2 }, { ...base[2]!, order: 3 }];
    expect(withTestingStatus(clash)!.find((s) => s.category === 'testing')!.id).toBe('testing_qa');
  });
});
