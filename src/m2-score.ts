/**
 * M2 same-product-across-stores scoring — SII-104.
 *
 * Pure score: takes already-fetched observation rows, keeps only the
 * latest `observed_at` per source (so two collects are not mixed —
 * the issue spec is explicit about this), then evaluates three
 * candidate join keys — `ean`, `brand-name-size`, `exact-name` —
 * against each pass-set and report-only source.
 *
 * For every anchor `source_sku` we record one of:
 *   - `unique-hit` — exactly one `source_sku` in the target source
 *     matches on the candidate key.
 *   - `ambiguous`   — more than one target `source_sku` matches.
 *   - `no-key`      — the anchor has no value for this key, or no
 *     target row matches.
 *
 * Rate = `unique-hit / anchorCount` (denominator includes `no-key`
 * rows, per SII-104). A source with zero rows is `no-key` for every
 * anchor row.
 *
 * Pass rule (SII-104): a key passes when its rate is at least 0.50
 * on `minkobmand`, on `nemlig`, AND on `netto`. The recommendation
 * line is derived from the set of passing keys.
 *
 * The module does not call the network. The caller (the docs script
 * and the unit tests) feeds already-fetched `Observation` rows in.
 *
 * Source of truth: SII-104 issue body — every observable table here is
 * pinned by that spec.
 */

import type { Observation } from './types.js';

export const PASS_THRESHOLD = 0.5;
export const ANCHOR = 'rema';
export const PASS_SET: ReadonlyArray<string> = [
  'minkobmand',
  'nemlig',
  'netto',
];
export const REPORT_ONLY: ReadonlyArray<string> = [
  'bilkatogo',
  'fotex',
  'spar',
  'lidl',
];
export const KEYS = ['ean', 'brand-name-size', 'exact-name'] as const;

export type AnchorKey = (typeof KEYS)[number];

/** Per-source breakdown for one key. */
export type SourceBreakdown = {
  source: string;
  /** Number of anchor `source_sku` values evaluated. */
  anchorCount: number;
  /** Anchor rows whose key matched exactly one target `source_sku`. */
  uniqueHit: number;
  /** Anchor rows whose key matched more than one target `source_sku`. */
  ambiguous: number;
  /** Anchor rows whose key was missing or matched nothing. */
  noKey: number;
  /** `uniqueHit / anchorCount`; 0 when `anchorCount === 0`. */
  rate: number;
};

export type KeyResult = {
  key: AnchorKey;
  /** One breakdown per (pass-set + report-only) source. */
  sources: SourceBreakdown[];
  /** `true` iff every pass-set source has `rate >= PASS_THRESHOLD`. */
  passes: boolean;
};

export type ScoreReport = {
  /** Counts per source after the latest-only filter. */
  rowCountsBySource: Record<string, number>;
  /** Per-key results. */
  keys: Record<AnchorKey, KeyResult>;
  /** One recommendation line per the SII-104 rule. */
  recommendation: string;
};

export type ScoreInput = {
  /** All observations to consider. The function filters to the latest
   *  `observed_at` per source. */
  observations: ReadonlyArray<Observation>;
  /** Source treated as the anchor. Defaults to `ANCHOR` (`rema`). */
  anchor?: string;
  /** Sources whose rates decide whether a key passes. Defaults to
   *  `PASS_SET` (`minkobmand`, `nemlig`, `netto`). */
  passSet?: ReadonlyArray<string>;
  /** Additional sources to include in the report. Defaults to
   *  `REPORT_ONLY` (`bilkatogo`, `fotex`, `spar`, `lidl`). */
  reportOnly?: ReadonlyArray<string>;
};

/**
 * Normalise a string for the `brand-name-size` and `exact-name`
 * keys. The spec says "compare strings after trim and lower case".
 *
 * An empty string after trimming is still a valid key value — it is
 * not the same as `no-key`. The no-key branch is taken only when the
 * underlying field is missing (`undefined`) or `null`; the SII-104
 * spec explicitly lists null fields as no-key.
 */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Test whether two EAN arrays share at least one string entry.
 *
 * Per SII-104: "two rows match when their gtins arrays share one
 * string. Do not filter the arrays again." — meaning we do NOT
 * re-validate the EAN-13 checksum here, we just compare the strings
 * the writers stored. Comparison is exact string equality.
 */
function sharesEan(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  if (a.length === 0 || b.length === 0) return false;
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
    }
  }
  return false;
}

type ExtractedKey =
  | { kind: 'ean'; gtins: ReadonlyArray<string> }
  | {
      kind: 'brand-name-size';
      brand: string;
      name: string;
      sizeValue: number;
      sizeUnit: string;
    }
  | { kind: 'exact-name'; name: string };

/** Pull the key value out of one observation, or `null` when the
 *  spec rules this row out of the score. */
function extract(obs: Observation, key: AnchorKey): ExtractedKey | null {
  if (key === 'ean') {
    if (obs.gtins.length === 0) return null;
    return { kind: 'ean', gtins: obs.gtins };
  }
  if (key === 'brand-name-size') {
    if (typeof obs.brand !== 'string') return null;
    if (typeof obs.name !== 'string') return null;
    if (obs.size === undefined) return null;
    if (typeof obs.size.value !== 'number') return null;
    if (typeof obs.size.unit !== 'string') return null;
    return {
      kind: 'brand-name-size',
      brand: norm(obs.brand),
      name: norm(obs.name),
      sizeValue: obs.size.value,
      sizeUnit: norm(obs.size.unit),
    };
  }
  // key === 'exact-name'
  if (typeof obs.name !== 'string') return null;
  return { kind: 'exact-name', name: norm(obs.name) };
}

function keysEqual(a: ExtractedKey, b: ExtractedKey): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ean' && b.kind === 'ean') {
    return sharesEan(a.gtins, b.gtins);
  }
  if (a.kind === 'brand-name-size' && b.kind === 'brand-name-size') {
    return (
      a.brand === b.brand &&
      a.name === b.name &&
      a.sizeValue === b.sizeValue &&
      a.sizeUnit === b.sizeUnit
    );
  }
  if (a.kind === 'exact-name' && b.kind === 'exact-name') {
    return a.name === b.name;
  }
  return false;
}

/**
 * Collect the set of `source_sku` values in `target` whose extracted
 * key equals `anchorKey` (both non-null). Duplicates inside one
 * target row's `gtins` array collapse to one source_sku because we
 * use a `Set`.
 */
function matchingSkus(
  target: ReadonlyArray<Observation>,
  key: AnchorKey,
  anchorKey: ExtractedKey,
): Set<string> {
  const out = new Set<string>();
  for (const obs of target) {
    const tKey = extract(obs, key);
    if (tKey === null) continue;
    if (keysEqual(anchorKey, tKey)) out.add(obs.source_sku);
  }
  return out;
}

/** Bucket rows by source, keeping only the max-`observed_at` rows
 *  for each source. The spec says "do not mix two collects". */
function keepLatest(
  rows: ReadonlyArray<Observation>,
): Record<string, Observation[]> {
  const maxBySource = new Map<string, string>();
  for (const row of rows) {
    const cur = maxBySource.get(row.source);
    if (cur === undefined || row.observed_at > cur) {
      maxBySource.set(row.source, row.observed_at);
    }
  }
  const out: Record<string, Observation[]> = {};
  for (const source of maxBySource.keys()) {
    out[source] = [];
  }
  for (const row of rows) {
    const observedAt = maxBySource.get(row.source);
    if (observedAt === undefined) continue;
    if (row.observed_at !== observedAt) continue;
    const list = out[row.source];
    if (list !== undefined) list.push(row);
  }
  return out;
}

/** Compose the final `Recommendation: ...` line per the SII-104 rule. */
function recommend(
  passing: ReadonlyArray<AnchorKey>,
  minRate: (k: AnchorKey) => number,
): string {
  if (passing.length === 0) return 'Recommendation: do not join yet';
  if (passing.length === 1) {
    const k = passing[0];
    if (k !== undefined) return labelFor(k);
  }
  // Two or more pass. Pick the one with the higher minimum pass-set
  // rate; tie-break on the spec order: ean, brand-name-size, exact-name.
  let best: AnchorKey = passing[0]!;
  for (const k of passing) {
    if (minRate(k) > minRate(best)) best = k;
  }
  for (const k of KEYS) {
    if (passing.includes(k) && minRate(k) === minRate(best)) {
      best = k;
      break;
    }
  }
  return labelFor(best);
}

function labelFor(k: AnchorKey): string {
  if (k === 'ean') return 'Recommendation: use ean';
  if (k === 'brand-name-size') return 'Recommendation: use brand-name-size';
  return 'Recommendation: use exact-name';
}

/**
 * Run the SII-104 score. Pure: no network access; no reads of process
 * environment. The caller is responsible for handing in observations
 * fetched from D1.
 */
export function score(input: ScoreInput): ScoreReport {
  const anchor = input.anchor ?? ANCHOR;
  const passSet = input.passSet ?? PASS_SET;
  const reportOnly = input.reportOnly ?? REPORT_ONLY;

  const latest = keepLatest(input.observations);

  const rowCountsBySource: Record<string, number> = {};
  for (const source of Object.keys(latest)) {
    const list = latest[source];
    rowCountsBySource[source] = list === undefined ? 0 : list.length;
  }

  const anchorRows = latest[anchor] ?? [];
  const anchorCount = anchorRows.length;

  const allTargetSources: ReadonlyArray<string> = [...passSet, ...reportOnly];

  // Per-key results are accumulated by direct property access so we
  // do not rely on `noUncheckedIndexedAccess` lookups in `Record<...>`.
  const eanSources: SourceBreakdown[] = [];
  const bnsSources: SourceBreakdown[] = [];
  const nameSources: SourceBreakdown[] = [];
  const eanPassSetRates: number[] = [];
  const bnsPassSetRates: number[] = [];
  const namePassSetRates: number[] = [];

  for (const source of allTargetSources) {
    const targetRows = latest[source] ?? [];

    const ean = scoreOneKey(source, anchorRows, targetRows, 'ean', anchorCount);
    const bns = scoreOneKey(source, anchorRows, targetRows, 'brand-name-size', anchorCount);
    const name = scoreOneKey(source, anchorRows, targetRows, 'exact-name', anchorCount);

    eanSources.push(ean);
    bnsSources.push(bns);
    nameSources.push(name);

    if (passSet.includes(source)) {
      eanPassSetRates.push(ean.rate);
      bnsPassSetRates.push(bns.rate);
      namePassSetRates.push(name.rate);
    }
  }

  const eanResult: KeyResult = {
    key: 'ean',
    sources: eanSources,
    passes:
      eanPassSetRates.length > 0 &&
      eanPassSetRates.every((r) => r >= PASS_THRESHOLD),
  };
  const bnsResult: KeyResult = {
    key: 'brand-name-size',
    sources: bnsSources,
    passes:
      bnsPassSetRates.length > 0 &&
      bnsPassSetRates.every((r) => r >= PASS_THRESHOLD),
  };
  const nameResult: KeyResult = {
    key: 'exact-name',
    sources: nameSources,
    passes:
      namePassSetRates.length > 0 &&
      namePassSetRates.every((r) => r >= PASS_THRESHOLD),
  };

  const minRate = (k: AnchorKey): number => {
    if (k === 'ean') return minOf(eanPassSetRates);
    if (k === 'brand-name-size') return minOf(bnsPassSetRates);
    return minOf(namePassSetRates);
  };

  const passing: AnchorKey[] = [];
  if (eanResult.passes) passing.push('ean');
  if (bnsResult.passes) passing.push('brand-name-size');
  if (nameResult.passes) passing.push('exact-name');

  return {
    rowCountsBySource,
    keys: {
      'ean': eanResult,
      'brand-name-size': bnsResult,
      'exact-name': nameResult,
    },
    recommendation: recommend(passing, minRate),
  };
}

function scoreOneKey(
  source: string,
  anchorRows: ReadonlyArray<Observation>,
  targetRows: ReadonlyArray<Observation>,
  key: AnchorKey,
  anchorCount: number,
): SourceBreakdown {
  let uniqueHit = 0;
  let ambiguous = 0;
  let noKey = 0;

  // A source with zero rows is `no-key` for every anchor row —
  // `matchingSkus` returns an empty set so every anchor row falls
  // into the noKey branch.
  for (const anchorRow of anchorRows) {
    const aKey = extract(anchorRow, key);
    if (aKey === null) {
      noKey += 1;
      continue;
    }
    const hitSkus = matchingSkus(targetRows, key, aKey);
    if (hitSkus.size === 0) {
      noKey += 1;
    } else if (hitSkus.size === 1) {
      uniqueHit += 1;
    } else {
      ambiguous += 1;
    }
  }

  return {
    source,
    anchorCount,
    uniqueHit,
    ambiguous,
    noKey,
    rate: anchorCount > 0 ? uniqueHit / anchorCount : 0,
  };
}

function minOf(xs: ReadonlyArray<number>): number {
  if (xs.length === 0) return Number.POSITIVE_INFINITY;
  let m = Number.POSITIVE_INFINITY;
  for (const x of xs) {
    if (x < m) m = x;
  }
  return m;
}