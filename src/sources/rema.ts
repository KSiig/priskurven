/**
 * Rema 1000 (Denmark) shelf-catalog source for the Priskurven collector.
 *
 * Fetches the in-store catalog from cphapp.rema1000.dk once per run and
 * walks `departments -> categories -> items`, emitting one
 * {@link Observation} per item.  Items are keyed by Rema's `id` (not by
 * barcode); `bar_codes` are emitted as EAN-13s in `gtins` after
 * filtering out in-store 20..29 prefixes and short PLUs.
 *
 * SII-94 deliverable.  The {@link Observation} / {@link Source} type
 * aliases are local until SII-103 hoists them into a shared module.
 *
 * @see https://linear.app/siig/issue/SII-94
 */

export const SOURCE = 'rema' as const;
export const CURRENCY = 'DKK' as const;

/**
 * URL of the live Rema catalog for store 1 (Copenhagen HQ reference
 * store).  Confirmed reachable on 2026-09-20 (~9 MB, ~3850 item-like
 * rows; counts drift slightly between fetches).
 */
export const REMA_CATALOG_URL =
  'https://cphapp.rema1000.dk/api/v1/catalog/store/1/withchildren' as const;

/**
 * Canonical observation emitted by every Priskurven source.  The shape
 * is owned by SII-103; this file inlines it so the module stands
 * alone until the shared type module lands.
 */
export type Observation = {
  source: string;
  source_sku: string;
  /** ISO 8601 UTC with milliseconds, e.g. `2026-09-20T13:45:01.123Z`. */
  observed_at: string;
  price: number;
  currency: string;
  name?: string;
  brand?: string;
  size?: { value: number; unit: string };
  gtins: string[];
  /** Original payload node, retained verbatim for downstream debugging. */
  raw: unknown;
};

/** A source is a zero-arg factory returning an async iterable of observations. */
export type Source = () => AsyncIterable<Observation>;

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

function toObservation(item: RemaItem): Observation {
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
    observed_at: new Date().toISOString(),
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
 * observations in document order.  Exported so tests can drive the
 * mapping from a fixture without going through the network.
 */
export function observationsFromCatalog(catalog: RemaCatalog): Observation[] {
  const out: Observation[] = [];
  for (const dept of catalog.departments ?? []) {
    for (const cat of dept.categories ?? []) {
      for (const item of cat.items ?? []) {
        if (item == null) continue;
        out.push(toObservation(item));
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
 * Cached, lazy-initialised fetcher.  A single invocation of `rema()`
 * issues exactly one HTTP GET; subsequent iterations reuse the
 * in-memory payload.
 */
let cached: Promise<RemaCatalog> | null = null;
function liveCatalog(): Promise<RemaCatalog> {
  if (!cached) cached = fetchRemaCatalog();
  return cached;
}

/** Reset the in-memory cache.  Used by tests; not exported as part of {@link Source}. */
export function _resetCache(): void {
  cached = null;
}

/**
 * The Rema source.  Implements {@link Source}: zero-arg factory
 * returning an `AsyncIterable<Observation>`.  Iterating the iterable
 * triggers exactly one HTTP GET to {@link REMA_CATALOG_URL}.
 */
export async function* rema(): AsyncIterable<Observation> {
  const catalog = await liveCatalog();
  for (const obs of observationsFromCatalog(catalog)) {
    yield obs;
  }
}