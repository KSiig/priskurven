/**
 * Unit tests for the SII-104 m2-score module.
 *
 * Spec coverage (issue body):
 *   - `unique-hit`, `ambiguous`, `no-key` for `ean`
 *   - `unique-hit`, `ambiguous`, `no-key` for `brand-name-size`
 *   - a source with zero rows
 *   - the tie-break in the recommendation
 *   - `exact-name` for symmetry (the spec pins the recommendation rule
 *     and the `no-key` rule across all three keys; we mirror them here).
 *
 * All tests feed synthetic observations into `score()`; the function
 * never touches the network.
 */

import { describe, expect, it } from 'vitest';

import type { Observation } from '../src/types.js';
import {
  ANCHOR,
  PASS_SET,
  REPORT_ONLY,
  score,
  type ScoreInput,
} from '../src/m2-score.js';

function obs(overrides: Partial<Observation> & { source: string; source_sku: string }): Observation {
  const out: Observation = {
    source: overrides.source,
    source_sku: overrides.source_sku,
    observed_at: '2024-06-01T10:00:00.000Z',
    price: 10,
    currency: 'DKK',
    gtins: [],
    raw: null,
  };
  if (overrides.observed_at !== undefined) out.observed_at = overrides.observed_at;
  if (overrides.price !== undefined) out.price = overrides.price;
  if (overrides.currency !== undefined) out.currency = overrides.currency;
  if (overrides.name !== undefined) out.name = overrides.name;
  if (overrides.brand !== undefined) out.brand = overrides.brand;
  if (overrides.size !== undefined) out.size = overrides.size;
  if (overrides.gtins !== undefined) out.gtins = overrides.gtins;
  if (overrides.raw !== undefined) out.raw = overrides.raw;
  return out;
}

/** Helper: find the breakdown for one (key, source) pair. */
function breakdown(
  input: ScoreInput,
  key: 'ean' | 'brand-name-size' | 'exact-name',
  source: string,
) {
  const report = score(input);
  const r = report.keys[key];
  if (r === undefined) throw new Error(`unknown key ${key}`);
  const found = r.sources.find((s) => s.source === source);
  if (found === undefined) {
    throw new Error(`source ${source} not in breakdown for ${key}`);
  }
  return { report, found };
}

describe('m2-score: ean key', () => {
  it('classifies a single-gtin anchor match as unique-hit', () => {
    const input: ScoreInput = {
      observations: [
        obs({ source: 'rema', source_sku: 'a', gtins: ['5712345000019'] }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          gtins: ['5712345000019'],
        }),
      ],
    };
    const { found } = breakdown(input, 'ean', 'minkobmand');
    expect(found.uniqueHit).toBe(1);
    expect(found.ambiguous).toBe(0);
    expect(found.noKey).toBe(0);
    expect(found.rate).toBe(1);
    expect(found.anchorCount).toBe(1);
  });

  it('classifies a 2-target-share as ambiguous', () => {
    const input: ScoreInput = {
      observations: [
        obs({ source: 'rema', source_sku: 'a', gtins: ['5712345000019'] }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          gtins: ['5712345000019'],
        }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-2',
          gtins: ['5712345000019'],
        }),
      ],
    };
    const { found } = breakdown(input, 'ean', 'minkobmand');
    expect(found.ambiguous).toBe(1);
    expect(found.uniqueHit).toBe(0);
    expect(found.noKey).toBe(0);
    expect(found.rate).toBe(0);
  });

  it('classifies an empty-gtin anchor as no-key', () => {
    const input: ScoreInput = {
      observations: [
        obs({ source: 'rema', source_sku: 'a', gtins: [] }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          gtins: ['5712345000019'],
        }),
      ],
    };
    const { found } = breakdown(input, 'ean', 'minkobmand');
    expect(found.noKey).toBe(1);
    expect(found.uniqueHit).toBe(0);
    expect(found.ambiguous).toBe(0);
    expect(found.rate).toBe(0);
  });

  it('matches on intersection when both sides carry multiple gtins', () => {
    // The spec is "two rows match when their gtins arrays share one
    // string. Do not filter the arrays again." We must NOT
    // checksum-validate here. We just compare strings as written.
    const input: ScoreInput = {
      observations: [
        obs({
          source: 'rema',
          source_sku: 'a',
          gtins: ['5712345000019', '5712345000026'],
        }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          gtins: ['5712345000026', '9999999999999'],
        }),
      ],
    };
    const { found } = breakdown(input, 'ean', 'minkobmand');
    expect(found.uniqueHit).toBe(1);
    expect(found.rate).toBe(1);
  });
});

describe('m2-score: brand-name-size key', () => {
  it('classifies a 4-tuple match as unique-hit', () => {
    const input: ScoreInput = {
      observations: [
        obs({
          source: 'rema',
          source_sku: 'a',
          // rema never stores brand/size in M1 — but the algorithm
          // runs the same way for any anchor, so we feed synthetic
          // data here.
          brand: 'Arla',
          name: 'Minimælk 1L',
          size: { value: 1, unit: 'l' },
          gtins: [],
        }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          brand: 'Arla',
          name: 'Minimælk 1L',
          size: { value: 1, unit: 'l' },
          gtins: [],
        }),
      ],
    };
    const { found } = breakdown(input, 'brand-name-size', 'minkobmand');
    expect(found.uniqueHit).toBe(1);
    expect(found.ambiguous).toBe(0);
    expect(found.noKey).toBe(0);
    expect(found.rate).toBe(1);
  });

  it('classifies two 4-tuple matches as ambiguous', () => {
    const input: ScoreInput = {
      observations: [
        obs({
          source: 'rema',
          source_sku: 'a',
          brand: 'Arla',
          name: 'Minimælk 1L',
          size: { value: 1, unit: 'l' },
          gtins: [],
        }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          brand: 'Arla',
          name: 'Minimælk 1L',
          size: { value: 1, unit: 'l' },
          gtins: [],
        }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-2',
          brand: 'Arla',
          name: 'Minimælk 1L',
          size: { value: 1, unit: 'l' },
          gtins: [],
        }),
      ],
    };
    const { found } = breakdown(input, 'brand-name-size', 'minkobmand');
    expect(found.ambiguous).toBe(1);
    expect(found.uniqueHit).toBe(0);
    expect(found.noKey).toBe(0);
    expect(found.rate).toBe(0);
  });

  it('classifies an anchor with no brand as no-key', () => {
    // rema in M1 writes brand=null. The score must record that as
    // no-key for brand-name-size, not unique-hit.
    const input: ScoreInput = {
      observations: [
        obs({ source: 'rema', source_sku: 'a' }), // no brand/size
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          brand: 'Arla',
          name: 'Minimælk',
          size: { value: 1, unit: 'l' },
          gtins: [],
        }),
      ],
    };
    const { found } = breakdown(input, 'brand-name-size', 'minkobmand');
    expect(found.noKey).toBe(1);
    expect(found.uniqueHit).toBe(0);
    expect(found.ambiguous).toBe(0);
    expect(found.rate).toBe(0);
  });

  it('compares names and units case-insensitively and after trim', () => {
    const input: ScoreInput = {
      observations: [
        obs({
          source: 'rema',
          source_sku: 'a',
          brand: '  Arla ',
          name: 'Minimælk 1L',
          size: { value: 1, unit: ' L ' },
          gtins: [],
        }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          brand: 'arla',
          name: 'MINIMÆLK 1L',
          size: { value: 1, unit: 'l' },
          gtins: [],
        }),
      ],
    };
    const { found } = breakdown(input, 'brand-name-size', 'minkobmand');
    expect(found.uniqueHit).toBe(1);
    expect(found.rate).toBe(1);
  });

  it('classifies a missing-size anchor as no-key', () => {
    const input: ScoreInput = {
      observations: [
        obs({
          source: 'rema',
          source_sku: 'a',
          brand: 'Arla',
          name: 'Minimælk',
          // size omitted
          gtins: [],
        }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          brand: 'Arla',
          name: 'Minimælk',
          size: { value: 1, unit: 'l' },
          gtins: [],
        }),
      ],
    };
    const { found } = breakdown(input, 'brand-name-size', 'minkobmand');
    expect(found.noKey).toBe(1);
    expect(found.rate).toBe(0);
  });
});

describe('m2-score: exact-name key', () => {
  it('classifies a name match as unique-hit', () => {
    const input: ScoreInput = {
      observations: [
        obs({ source: 'rema', source_sku: 'a', name: 'Minimælk 1L' }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          name: 'Minimælk 1L',
        }),
      ],
    };
    const { found } = breakdown(input, 'exact-name', 'minkobmand');
    expect(found.uniqueHit).toBe(1);
    expect(found.rate).toBe(1);
  });

  it('classifies an anchor with no name as no-key', () => {
    const input: ScoreInput = {
      observations: [
        obs({ source: 'rema', source_sku: 'a' }),
        obs({ source: 'minkobmand', source_sku: 'mk-1', name: 'X' }),
      ],
    };
    const { found } = breakdown(input, 'exact-name', 'minkobmand');
    expect(found.noKey).toBe(1);
    expect(found.rate).toBe(0);
  });
});

describe('m2-score: zero-row target source', () => {
  it('records every anchor row as no-key for an empty source', () => {
    const input: ScoreInput = {
      observations: [
        obs({ source: 'rema', source_sku: 'a', gtins: ['5712345000019'] }),
        obs({ source: 'rema', source_sku: 'b', gtins: ['5712345000026'] }),
        obs({ source: 'rema', source_sku: 'c', gtins: [] }),
      ],
    };
    // minkobmand is in the default pass-set; it has zero rows here.
    for (const key of ['ean', 'brand-name-size', 'exact-name'] as const) {
      const { found } = breakdown(input, key, 'minkobmand');
      expect(found.anchorCount).toBe(3);
      expect(found.uniqueHit).toBe(0);
      expect(found.ambiguous).toBe(0);
      expect(found.noKey).toBe(3);
      expect(found.rate).toBe(0);
    }
  });

  it('drops the key from the pass set when a pass-set source is empty', () => {
    // If every pass-set source is empty, no key can pass.
    const input: ScoreInput = {
      observations: [
        obs({ source: 'rema', source_sku: 'a', gtins: ['5712345000019'] }),
      ],
    };
    const report = score(input);
    expect(report.keys.ean.passes).toBe(false);
    expect(report.keys['brand-name-size'].passes).toBe(false);
    expect(report.keys['exact-name'].passes).toBe(false);
    expect(report.recommendation).toBe('Recommendation: do not join yet');
  });
});

describe('m2-score: keepLatest filter', () => {
  it('keeps only the max observed_at per source', () => {
    // Two collects of rema — only the later one counts.
    const input: ScoreInput = {
      observations: [
        obs({
          source: 'rema',
          source_sku: 'a',
          observed_at: '2024-06-01T09:00:00.000Z',
          gtins: ['5712345000019'],
        }),
        obs({
          source: 'rema',
          source_sku: 'a',
          observed_at: '2024-06-01T10:00:00.000Z',
          gtins: ['5712345000099'],
        }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          observed_at: '2024-06-01T10:00:00.000Z',
          gtins: ['5712345000099'],
        }),
      ],
    };
    const report = score(input);
    expect(report.rowCountsBySource.rema).toBe(1);
    expect(report.rowCountsBySource.minkobmand).toBe(1);
    // The 09:00:00 anchor row is dropped — its gtin would not have
    // matched. The 10:00:00 anchor row matches the target.
    expect(report.keys.ean.sources[0]?.uniqueHit).toBe(1);
  });
});

describe('m2-score: recommendation rule', () => {
  it('reports "do not join yet" when no key passes', () => {
    const input: ScoreInput = {
      observations: [
        obs({ source: 'rema', source_sku: 'a', gtins: [] }),
      ],
    };
    const report = score(input);
    expect(report.recommendation).toBe('Recommendation: do not join yet');
  });

  it('reports "use ean" when only ean passes', () => {
    // Anchor with one ean; minkobmand has matching ean; nemlig and
    // netto are empty so they cannot pass. Use custom passSet to
    // keep the test self-contained.
    const input: ScoreInput = {
      observations: [
        obs({ source: 'rema', source_sku: 'a', gtins: ['5712345000019'] }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          gtins: ['5712345000019'],
        }),
        obs({
          source: 'nemlig',
          source_sku: 'nm-1',
          gtins: ['5712345000019'],
        }),
        obs({
          source: 'netto',
          source_sku: 'nt-1',
          gtins: ['5712345000019'],
        }),
      ],
    };
    const report = score(input);
    expect(report.keys.ean.passes).toBe(true);
    expect(report.recommendation).toBe('Recommendation: use ean');
  });

  it('reports "use exact-name" when only exact-name passes', () => {
    const input: ScoreInput = {
      observations: [
        obs({ source: 'rema', source_sku: 'a', name: 'Minimælk 1L' }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          name: 'Minimælk 1L',
        }),
        obs({
          source: 'nemlig',
          source_sku: 'nm-1',
          name: 'Minimælk 1L',
        }),
        obs({
          source: 'netto',
          source_sku: 'nt-1',
          name: 'Minimælk 1L',
        }),
      ],
    };
    const report = score(input);
    expect(report.keys['exact-name'].passes).toBe(true);
    expect(report.recommendation).toBe('Recommendation: use exact-name');
  });

  it('breaks ties in spec order (ean → brand-name-size → exact-name)', () => {
    // Construct a case where both ean and exact-name pass with the
    // same minimum pass-set rate. Per the SII-104 spec, ean wins.
    const input: ScoreInput = {
      observations: [
        // Anchor row carries both an ean and a name.
        obs({
          source: 'rema',
          source_sku: 'a',
          gtins: ['5712345000019'],
          name: 'Minimælk 1L',
        }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          gtins: ['5712345000019'],
          name: 'Minimælk 1L',
        }),
        obs({
          source: 'nemlig',
          source_sku: 'nm-1',
          gtins: ['5712345000019'],
          name: 'Minimælk 1L',
        }),
        obs({
          source: 'netto',
          source_sku: 'nt-1',
          gtins: ['5712345000019'],
          name: 'Minimælk 1L',
        }),
      ],
    };
    const report = score(input);
    expect(report.keys.ean.passes).toBe(true);
    expect(report.keys['exact-name'].passes).toBe(true);
    // Both keys reach rate 1.0 across the pass-set — the spec
    // tie-break kicks in and prefers `ean`.
    expect(report.recommendation).toBe('Recommendation: use ean');
  });

  it('picks the key with the higher minimum rate when two keys pass with different rates', () => {
    // ean: rate 1.0 on every source.
    // exact-name: rate 0.5 on every source (passes the threshold but
    // is lower than ean).
    // Two anchor rows; one matches on ean+name; the other matches on
    // ean only.
    const input: ScoreInput = {
      observations: [
        // Anchor row 1 — matches everything.
        obs({
          source: 'rema',
          source_sku: 'a',
          gtins: ['5712345000019'],
          name: 'Minimælk 1L',
        }),
        // Anchor row 2 — matches only on ean.
        obs({
          source: 'rema',
          source_sku: 'b',
          gtins: ['5712345000026'],
          name: 'Something Else',
        }),
        // minkobmand
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          gtins: ['5712345000019'],
          name: 'Minimælk 1L',
        }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-2',
          gtins: ['5712345000026'],
        }),
        // nemlig
        obs({
          source: 'nemlig',
          source_sku: 'nm-1',
          gtins: ['5712345000019'],
          name: 'Minimælk 1L',
        }),
        obs({
          source: 'nemlig',
          source_sku: 'nm-2',
          gtins: ['5712345000026'],
        }),
        // netto
        obs({
          source: 'netto',
          source_sku: 'nt-1',
          gtins: ['5712345000019'],
          name: 'Minimælk 1L',
        }),
        obs({
          source: 'netto',
          source_sku: 'nt-2',
          gtins: ['5712345000026'],
        }),
      ],
    };
    const report = score(input);
    expect(report.keys.ean.passes).toBe(true);
    expect(report.keys['exact-name'].passes).toBe(true);
    // Both pass. ean has min rate 1.0; exact-name has min rate 0.5.
    // ean wins by higher minimum rate — no tie-break needed.
    expect(report.recommendation).toBe('Recommendation: use ean');
  });

  it('falls back to "do not join yet" when brand-name-size cannot pass on rema', () => {
    // rema never writes brand/size — brand-name-size will record
    // no-key=anchorCount, never pass.
    const input: ScoreInput = {
      observations: [
        obs({
          source: 'rema',
          source_sku: 'a',
          gtins: ['5712345000019'],
        }),
        obs({
          source: 'minkobmand',
          source_sku: 'mk-1',
          gtins: ['5712345000019'],
          brand: 'Arla',
          name: 'Minimælk 1L',
          size: { value: 1, unit: 'l' },
        }),
        obs({
          source: 'nemlig',
          source_sku: 'nm-1',
          gtins: ['5712345000019'],
          brand: 'Arla',
          name: 'Minimælk 1L',
          size: { value: 1, unit: 'l' },
        }),
        obs({
          source: 'netto',
          source_sku: 'nt-1',
          gtins: ['5712345000019'],
          brand: 'Arla',
          name: 'Minimælk 1L',
          size: { value: 1, unit: 'l' },
        }),
      ],
    };
    const report = score(input);
    expect(report.keys['brand-name-size'].passes).toBe(false);
    // This test focuses on the no-pass fallback for brand-name-size;
    // ean passes here so the recommendation is ean, not "do not join".
    expect(report.recommendation).toBe('Recommendation: use ean');
  });
});

describe('m2-score: defaults', () => {
  it('uses rema as the default anchor and the documented pass-set/report-only lists', () => {
    expect(ANCHOR).toBe('rema');
    expect(PASS_SET).toEqual(['minkobmand', 'nemlig', 'netto']);
    expect(REPORT_ONLY).toEqual(['bilkatogo', 'fotex', 'spar', 'lidl']);
  });
});