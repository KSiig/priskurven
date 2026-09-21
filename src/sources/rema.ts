/**
 * Rema 1000 (Denmark) shelf-catalog source for the Priskurven collector.
 *
 * Fetches the in-store catalog from cphapp.rema1000.dk once per run and
 * walks `departments -> categories -> items`, emitting one
 * {@link Observation} per item.  Items are keyed by Rema's `id` (not by
 * barcode); `bar_codes` are emitted as EAN-13s in `gtins` after
 * filtering out in-store 20..29 prefixes and short PLUs.
 *
 * SII-94 deliverable. Observation / Source come from `src/types.ts`.
 *
 * @see https://linear.app/siig/issue/SII-94
 */

import type { Observation } from '../types.js';

export const SOURCE = 'rema' as const;
export const CURRENCY = 'DKK' as const;

/**
 * URL of the live Rema catalog for store 1 (Copenhagen HQ reference
 * store).  Confirmed reachable on 2026-09-20 (~9 MB, ~3850 item-like
 * rows; counts drift slightly between fetches).
 */
export const REMA_CATALOG_URL =
  'https://cphapp.rema1000.dk/api/v1/catalog/store/1/withchildren' as const;

/** Single item inside an Rema category. */
export type RemaItem = {
  id: number | string;
  name?: string;
  pricing?: { price?: number | null } | null;
  bar_codes?: ReadonlyArray<string> | null;
  [key: string]: unknown;
};

/** Single category inside an Rema department. */
export type RemaCategory = {
  categories?: ReadonlyArray<{ items?: ReadonlyArray<RemaItem> }>;
  items?: ReadonlyArray<RemaItem>;
};

/** Single department inside an Rema catalog. */
export type RemaDepartment = {
  categories?: ReadonlyArray<RemaCategory>;
};

/** Subset of the live Rema payload we touch.  Other fields are ignored. */
export type RemaCatalog = {
  departments?: ReadonlyArray<RemaDepartment>;
};

/**
 * Returns true iff `s` is a 13-digit string whose leading two digits
 * are not in the 20..29 in-store-prefix range and whose trailing
 * check digit matches the EAN-13 mod-10 algorithm
 * (weights 1,3,1,3,... applied left-to-right over the leading 12
 * digits; check digit = (10 - sum mod 10) mod 10).
 *
 * Short PLUs (e.g. `"1006"`, `"574289"`) are rejected by the
 * length check; 13-digit codes that fail the checksum are rejected
 * by the mod-10 check.
 */
export function isValidEan13(s: unknown): s is string {
  if (typeof s !== 'string' || s.length !== 13) return false;
  for (let i = 0; i < 13; i++) {
    const code = s.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  const prefix = (s.charCodeAt(0) - 48) * 10 + (s.charCodeAt(1) - 48);
  if (prefix >= 20 && prefix <= 29) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = s.charCodeAt(i) - 48;
    const weight = i % 2 === 0 ? 1 : 3;
    sum += d * weight;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === s.charCodeAt(12) - 48;
}

function toObservation(item: RemaItem, observedAt: string): Observation {
  const price =
    item.pricing && typeof item.pricing.price === 'number'
      ? item.pricing.price
      : 0;
  const gtins = Array.isArray(item.bar_codes)
    ? (item.bar_codes.filter(isValidEan13) as string[])
    : [];
  const obs: Observation = {
    source: SOURCE,
    source_sku: String(item.id),
    observed_at: observedAt,
    price,
    currency: CURRENCY,
    gtins,
    raw: item,
  };
  if (typeof item.name === 'string' && item.name.length > 0) {
    obs.name = item.name;
  }
  return obs;
}

/**
 * Pure transform: walk a parsed Rema catalog payload and emit
 * observations in document order.  A single `observed_at` timestamp
 * is pinned once per call so the run can be selected by that
 * timestamp (it is part of the observation primary key).  Exported
 * so tests can drive the mapping from a fixture without going
 * through the network.
 */
export function observationsFromCatalog(catalog: RemaCatalog): Observation[] {
  const out: Observation[] = [];
  const observedAt = new Date().toISOString();
  for (const dept of catalog.departments ?? []) {
    for (const cat of dept.categories ?? []) {
      for (const item of cat.items ?? []) {
        if (item == null) continue;
        out.push(toObservation(item, observedAt));
      }
    }
  }
  return out;
}

type Fetcher = typeof fetch;

/**
 * Fetch the live Rema catalog and return the parsed JSON.  The
 * `fetcher` and `url` parameters are exposed so tests can run against
 * the truncated fixture; the default hits the live endpoint.
 */
export async function fetchRemaCatalog(
  fetcher: Fetcher = fetch,
  url: string = REMA_CATALOG_URL,
): Promise<RemaCatalog> {
  const res = await fetcher(url);
  if (!res.ok) {
    throw new Error(`rema catalog GET ${url} -> HTTP ${res.status}`);
  }
  return (await res.json()) as RemaCatalog;
}

/**
 * The Rema source.  Implements {@link Source}: zero-arg factory
 * returning an `AsyncIterable<Observation>`.  Iterating the iterable
 * triggers exactly one HTTP GET to {@link REMA_CATALOG_URL}.
 *
 * Note: the catalog is fetched fresh on every invocation.  A
 * process-lifetime cache was tried and reverted: Cloud Functions
 * warm-start reuses the module, so a cached payload would carry
 * the previous run's prices with a fresh `observed_at`, producing
 * stale observations.
 */
export async function* rema(): AsyncIterable<Observation> {
  const catalog = await fetchRemaCatalog();
  for (const obs of observationsFromCatalog(catalog)) {
    yield obs;
  }
}