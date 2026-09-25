/**
 * Shared Algolia helper for the Salling webshop catalog sources
 * (netto, fotex, bilkatogo).
 *
 * Salling group webshops (netto.dk, fotex.dk, bilkatogo.dk) expose
 * their product catalogs through Algolia — same path as the
 * `salling-lib.js` helper in `Herover/heissepreise`:
 *
 *   POST https://{appId}-dsn.algolia.net/1/indexes/prod_{path}_PRODUCTS/query
 *     Headers: X-Algolia-Application-Id, X-Algolia-Api-Key
 *     Body:    { query: "", hitsPerPage: 1000, page: N, ... }
 *     Reply:   { hits: AlgoliaHit[], nbPages: number, page: number }
 *
 * The retrieved fields do NOT include barcode / EAN.  Per the SII-97
 * spec, `gtins` stays `[]` for every row unless we discover one in a
 * later probe.
 *
 * Canonical id is `objectID`.  Price is
 * `storeData[firstKey].price / 100` (øre -> DKK).
 *
 * Observation / Source come from `src/types.ts`.
 *
 * @see https://linear.app/siig/issue/SII-97
 * @see https://github.com/Herover/heissepreise/blob/master/stores/salling-lib.js
 */

import type { Observation } from '../types.js';

/**
 * Subset of the Algolia hit payload used by Salling stores.  Only the
 * fields the SII-97 spec calls out are typed; everything else flows
 * through `raw` unchanged.
 */
export type AlgoliaHit = {
  /** Canonical id for this catalog row. */
  objectID: string;
  /** Salling product name.  Preferred over `name` / `productType`. */
  productName?: string;
  /** Generic Algolia name field. */
  name?: string;
  /** Generic Algolia type field. */
  productType?: string;
  /** Long-form description. */
  description?: string;
  brand?: string;
  subBrand?: string;
  /** Net content expressed in `unitsOfMeasure`. */
  units?: number;
  unitsOfMeasure?: string;
  /**
   * Per-store price/availability snapshot.  The key is the Salling
   * store id; the value carries the price in øre and other per-store
   * metadata.  The SII-97 spec reads the first key.
   */
  storeData?: Record<string, { price?: number | null } | undefined>;
};

/** Subset of the Algolia search response we touch. */
export type AlgoliaResponse = {
  hits?: ReadonlyArray<AlgoliaHit | null | undefined>;
  /** Total number of pages returned at the requested `hitsPerPage`. */
  nbPages?: number;
  /** Index of the page just returned (0-based). */
  page?: number;
  /** Total number of hits across all pages. */
  nbHits?: number;
  /** Echoes `hitsPerPage` from the request. */
  hitsPerPage?: number;
};

/** Static config for one Salling source (netto, fotex, bilkatogo). */
export type AlgoliaConfig = {
  /** Source identifier used in every emitted `Observation.source`. */
  source: string;
  /** `process.env` key carrying the Algolia path segment (e.g. `"netto"`). */
  pathEnv: string;
  /** `process.env` key carrying the Algolia application id. */
  appIdEnv: string;
  /** `process.env` key carrying the Algolia API key. */
  keyEnv: string;
};

type Fetcher = typeof fetch;

/**
 * Build the Algolia search URL for a Salling source.
 *
 * Host: `{appId}-dsn.algolia.net`.  `appId` is lower-cased to match
 * the heissepreise convention; Algolia tolerates either case but the
 * real upstream always returns a lowercase host.
 *
 * Path: `/1/indexes/prod_{path}_PRODUCTS/query`.
 */
export function algoliaSearchUrl(appId: string, path: string): string {
  return `https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/prod_${path}_PRODUCTS/query`;
}

/**
 * Build the JSON body for one Algolia search request.
 *
 * `query` is the empty string (full catalog dump), `hitsPerPage` is
 * pinned at 1000 (Algolia's hard cap), `page` is the 0-based page
 * index.  `analyticsTags` and the analytics flags are disabled — they
 * are forwarded by heissepreise; we do not need them.
 *
 * `attributesToRetrieve` matches the heissepreise subset.  It excludes
 * barcode / EAN by design (Salling's Algolia index does not carry one).
 */
export function algoliaSearchBody(page: number): {
  analytics: boolean;
  query: string;
  clickAnalytics: boolean;
  attributesToRetrieve: string[];
  hitsPerPage: number;
  page: number;
  analyticsTags: string[];
} {
  return {
    analytics: false,
    query: '',
    clickAnalytics: false,
    attributesToRetrieve: [
      'objectID',
      'productName',
      'name',
      'brand',
      'subBrand',
      'description',
      'units',
      'unitsOfMeasure',
      'storeData',
      'productType',
    ],
    hitsPerPage: 1000,
    page,
    analyticsTags: [],
  };
}

/**
 * Headers required by Algolia's search endpoint.
 */
export function algoliaHeaders(
  appId: string,
  key: string,
): Record<string, string> {
  return {
    'X-Algolia-Application-Id': appId,
    'X-Algolia-Api-Key': key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Pull a finite numeric price out of an Algolia `storeData` payload.
 * Reads the first key only (per the SII-97 spec).
 *
 * Returns `0` when no priced store entry is present.  Items without a
 * price still surface through the `raw` field — the caller decides
 * whether to skip them.
 */
export function priceFromHit(hit: AlgoliaHit): number {
  const storeData = hit.storeData;
  if (!storeData) return 0;
  for (const key of Object.keys(storeData)) {
    const entry = storeData[key];
    if (!entry) continue;
    const candidate = entry.price;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate / 100;
    }
  }
  return 0;
}

function hitHasPrice(hit: AlgoliaHit): boolean {
  const storeData = hit.storeData;
  if (!storeData) return false;
  for (const key of Object.keys(storeData)) {
    const entry = storeData[key];
    if (!entry) continue;
    const candidate = entry.price;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return true;
  }
  return false;
}

/**
 * Combine the brand-ish fields on a hit into a single string.  Returns
 * `undefined` when the result is empty so the caller can omit the
 * `brand` property entirely.
 */
function brandFromHit(hit: AlgoliaHit): string | undefined {
  const parts: string[] = [];
  if (typeof hit.brand === 'string' && hit.brand.length > 0) parts.push(hit.brand);
  if (typeof hit.subBrand === 'string' && hit.subBrand.length > 0) parts.push(hit.subBrand);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Combine the name-ish fields on a hit into a single string.
 *
 * Order of preference (mirrors heissepreise `getCanonical`):
 *   1. `productName`
 *   2. `name`
 *   3. `productType`
 *
 * `description` is intentionally NOT included; heissepreise appends it
 * separately.  We omit it here so the `name` field stays short.
 */
function nameFromHit(hit: AlgoliaHit): string | undefined {
  if (typeof hit.productName === 'string' && hit.productName.length > 0) return hit.productName;
  if (typeof hit.name === 'string' && hit.name.length > 0) return hit.name;
  if (typeof hit.productType === 'string' && hit.productType.length > 0) return hit.productType;
  return undefined;
}

/**
 * Pull `size: { value, unit }` out of the hit's `units` /
 * `unitsOfMeasure` fields.  Returns `undefined` when the hit does not
 * carry a unit count.
 */
function sizeFromHit(hit: AlgoliaHit): { value: number; unit: string } | undefined {
  if (typeof hit.units !== 'number' || !Number.isFinite(hit.units)) return undefined;
  if (typeof hit.unitsOfMeasure !== 'string' || hit.unitsOfMeasure.length === 0) return undefined;
  return { value: hit.units, unit: hit.unitsOfMeasure };
}

/**
 * Pure transform: turn one Algolia hit into an Observation.  Returns
 * `null` when the hit has no priced `storeData` entry — the spec says
 * to drop such rows.
 *
 * `gtins` is always `[]`: the Algolia index for Salling does not
 * carry a barcode field per `attributesToRetrieve`.  When a future
 * probe discovers one, this is the place to extract it.
 */
export function observationFromHit(
  hit: AlgoliaHit,
  source: string,
  observedAt: string,
): Observation | null {
  if (typeof hit.objectID !== 'string' || hit.objectID.length === 0) return null;
  if (!hitHasPrice(hit)) return null;

  const obs: Observation = {
    source,
    source_sku: hit.objectID,
    observed_at: observedAt,
    price: priceFromHit(hit),
    currency: 'DKK',
    gtins: [],
    raw: hit,
  };

  const name = nameFromHit(hit);
  if (name !== undefined) obs.name = name;

  const brand = brandFromHit(hit);
  if (brand !== undefined) obs.brand = brand;

  const size = sizeFromHit(hit);
  if (size !== undefined) obs.size = size;

  return obs;
}

/**
 * Fetch one page from the Algolia search endpoint.  Throws on non-2xx
 * or on a malformed JSON body.  Exported for tests; the live Salling
 * sources compose this with pagination.
 */
export async function fetchAlgoliaPage(
  url: string,
  appId: string,
  key: string,
  page: number,
  fetcher: Fetcher = fetch,
): Promise<AlgoliaResponse> {
  const res = await fetcher(url, {
    method: 'POST',
    headers: algoliaHeaders(appId, key),
    body: JSON.stringify(algoliaSearchBody(page)),
  });
  if (!res.ok) {
    throw new Error(`algolia ${url} page=${page} -> HTTP ${res.status}`);
  }
  const body = (await res.json()) as AlgoliaResponse;
  return body;
}

/**
 * Walk `nbPages` calls of `fetchAlgoliaPage`, emitting one Observation
 * per priced hit.  Exported for tests; the live Salling sources
 * compose this with env-var reads.
 *
 * `hitsPerPage` is hard-coded at 1000 (Algolia's max) and matches the
 * `algoliaSearchBody(page)` factory.  Do not override.
 */
export async function* paginateAlgoliaCatalog(
  url: string,
  appId: string,
  key: string,
  source: string,
  fetcher: Fetcher = fetch,
): AsyncIterable<Observation> {
  const observedAt = new Date().toISOString();
  let page = 0;
  let totalPages: number | null = null;
  // Hard cap on pages to avoid infinite loops if Algolia's `nbPages`
  // ever misbehaves.  The Salling indexes sit comfortably below this
  // (a few thousand rows each, so ~10 pages at 1000/page).
  let safety = 0;
  const MAX_PAGES = 200;
  while (totalPages === null || page < totalPages) {
    if (safety++ >= MAX_PAGES) {
      throw new Error(
        `algolia ${source}: aborted after ${MAX_PAGES} pages (page=${page}, totalPages=${totalPages})`,
      );
    }
    const body = await fetchAlgoliaPage(url, appId, key, page, fetcher);
    const nbPages = typeof body.nbPages === 'number' ? body.nbPages : 0;
    totalPages = nbPages;
    for (const hit of body.hits ?? []) {
      if (hit == null) continue;
      const obs = observationFromHit(hit, source, observedAt);
      if (obs !== null) yield obs;
    }
    page += 1;
  }
}

/**
 * Read the four env vars a Salling source needs.  Returns `null`
 * when any of `path`, `appId`, or `key` is missing — the caller then
 * yields nothing (per the SII-97 spec: "skip live calls if env is
 * unset").  `path`/`appId`/`key` are trimmed; whitespace-only strings
 * count as missing.
 */
export function readAlgoliaEnv(
  config: AlgoliaConfig,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; appId: string; key: string } | null {
  const rawPath = env[config.pathEnv];
  const rawAppId = env[config.appIdEnv];
  const rawKey = env[config.keyEnv];
  const path = typeof rawPath === 'string' ? rawPath.trim() : '';
  const appId = typeof rawAppId === 'string' ? rawAppId.trim() : '';
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (path.length === 0 || appId.length === 0 || key.length === 0) return null;
  return { path, appId, key };
}