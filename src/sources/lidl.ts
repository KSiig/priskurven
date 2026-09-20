/**
 * Lidl.dk shelf-price collector.
 *
 * Pulls from the public Lidl search API:
 *
 *   GET https://www.lidl.dk/q/api/search?q=<wildcard>&assortment=DK&locale=da_DK&version=2.0&offset=<n>
 *   Accept: wildcard (no constraint)
 *
 * Response shape (2026-09-20 probe):
 *   numFound, fetchsize, maxfetchsize, items[]
 *   item.gridbox.data.productId   → source_sku
 *   item.gridbox.data.fullTitle   → name
 *   item.gridbox.data.price.price → price (DKK)
 *   item.gridbox.data.brand.name  → brand (optional)
 *   item.gridbox.meta.ean         → gtins (only when checksum-valid EAN-13)
 *   item.gridbox.data.ians        → Lidl internal article numbers; NOT EAN-13
 *
 * Paging: walk `offset += response.fetchsize` until `offset >= numFound`.
 * Items without a `price.price` are dropped (per spec).
 *
 * NOTE: heissepreise's `stores/lidl.js` hits `lidl.dk/p/api/gridboxes` with
 * `?max=∼30000`. That path is the homepage-tile endpoint (HTTP 200, only
 * 25 tiles) — not the catalog. We use the search endpoint above.
 *
 * Spec: SII-98. No isolation logic — see SII-103.
 *
 * @see https://linear.app/siig/issue/SII-98
 */

/**
 * Canonical observation emitted by every Priskurven source.  The shape
 * is owned by SII-103; this file inlines it so the module stands alone
 * until the shared type module lands.
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

const SOURCE = 'lidl';
const CURRENCY = 'DKK';
const SEARCH_URL =
  'https://www.lidl.dk/q/api/search?q=*&assortment=DK&locale=da_DK&version=2.0';

type LidlPrice = {
  /** Numeric shelf price in `currencyCode`. May be absent for promo-only items. */
  price?: number | null;
  currencyCode?: string;
};

type LidlData = {
  productId: number | string;
  fullTitle?: string;
  /** May be missing on promo-only / out-of-stock tiles. */
  price?: LidlPrice | null;
  brand?: { name?: string } | null;
  /** Lidl internal article numbers — NOT EAN-13. Kept in `raw` only. */
  ians?: ReadonlyArray<string>;
};

type LidlGridbox = {
  data?: LidlData;
  meta?: { ean?: string | null };
};

type LidlItem = {
  gridbox?: LidlGridbox;
};

type LidlResponse = {
  numFound: number;
  fetchsize: number;
  maxfetchsize: number;
  items: LidlItem[];
};

/**
 * EAN-13 checksum validation per GS1 spec.
 * `true` when the 13-digit string passes the mod-10 check.
 */
export function isValidEan13(sku: string): boolean {
  if (!/^\d{13}$/.test(sku)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = sku.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === sku.charCodeAt(12) - 48;
}

/**
 * Pure transform: turn one Lidl gridbox item into an Observation.
 * Returns `null` when the item has no `price.price` (the spec says to
 * skip such rows). Pulls EAN-13 only from `meta.ean` (never `ians`).
 */
export function observationFromItem(
  item: LidlItem,
  observedAt: string,
): Observation | null {
  const gridbox = item.gridbox;
  if (!gridbox) return null;
  const data = gridbox.data;
  if (!data) return null;
  const price = data.price?.price;
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;

  const rawEan = gridbox.meta?.ean;
  const gtins: string[] =
    typeof rawEan === 'string' && isValidEan13(rawEan) ? [rawEan] : [];

  const obs: Observation = {
    source: SOURCE,
    source_sku: String(data.productId),
    observed_at: observedAt,
    price,
    currency: CURRENCY,
    gtins,
    raw: item,
  };
  if (typeof data.fullTitle === 'string' && data.fullTitle.length > 0) {
    obs.name = data.fullTitle;
  }
  if (data.brand && typeof data.brand.name === 'string' && data.brand.name.length > 0) {
    obs.brand = data.brand.name;
  }
  return obs;
}

type Fetcher = typeof fetch;

/**
 * Parse a Lidl search response body. Throws on malformed input.
 * Exported for tests; the live `lidl()` source handles paging.
 */
export function parseLidlResponse(body: unknown): LidlResponse {
  if (!body || typeof body !== 'object') {
    throw new Error('lidl: response is not an object');
  }
  const obj = body as Partial<LidlResponse>;
  if (typeof obj.numFound !== 'number') {
    throw new Error('lidl: response missing numFound');
  }
  if (typeof obj.fetchsize !== 'number') {
    throw new Error('lidl: response missing fetchsize');
  }
  if (!Array.isArray(obj.items)) {
    throw new Error('lidl: response missing items[]');
  }
  return {
    numFound: obj.numFound,
    fetchsize: obj.fetchsize,
    maxfetchsize: typeof obj.maxfetchsize === 'number' ? obj.maxfetchsize : obj.fetchsize,
    items: obj.items as LidlItem[],
  };
}

/**
 * Fetch one page from the Lidl search endpoint. Throws on non-2xx.
 * Exported for tests; the live `lidl()` source composes this with paging.
 */
export async function fetchLidlPage(
  offset: number,
  fetcher: Fetcher = fetch,
  url: string = SEARCH_URL,
): Promise<LidlResponse> {
  const fullUrl = `${url}&offset=${offset}`;
  const res = await fetcher(fullUrl, {
    headers: { Accept: '*/*' },
  });
  if (!res.ok) {
    throw new Error(`lidl: HTTP ${res.status} from ${fullUrl}`);
  }
  return parseLidlResponse(await res.json());
}

/**
 * The Lidl source. Walks `/q/api/search` with `offset += fetchsize`
 * until `offset >= numFound`, emitting one Observation per priced
 * item. Iterating the iterable triggers N+1 HTTP GETs where N is the
 * final page count.
 */
async function* fetchLidl(): AsyncIterable<Observation> {
  const observedAt = new Date().toISOString();
  let offset = 0;
  let total: number | null = null;
  // Hard cap on pages to avoid infinite loops if the upstream changes
  // shape (e.g. fetchsize=0). Real probes return 156 / 36 ≈ 5 pages.
  let safety = 0;
  const MAX_PAGES = 200;
  while (total === null || offset < total) {
    if (safety++ >= MAX_PAGES) {
      throw new Error(`lidl: aborted after ${MAX_PAGES} pages (offset=${offset}, total=${total})`);
    }
    const body = await fetchLidlPage(offset);
    total = body.numFound;
    for (const item of body.items) {
      const obs = observationFromItem(item, observedAt);
      if (obs !== null) yield obs;
    }
    offset += body.fetchsize;
  }
}

/**
 * Pinned: walk `/q/api/search` with `offset += response.fetchsize`
 * until `offset >= numFound`. Confirmed 2026-09-20:
 *   - `numFound`: 156 (counter from 327 mentioned in the spec dropped
 *     to 156 between the spec's two probes; do not hardcode it).
 *   - `fetchsize`: 36 per page; `maxfetchsize` 1000.
 *   - `q=*` returns the full catalog subset that Lidl exposes to its
 *     public search endpoint (weekly offers + bazaar).
 */
export const lidl: Source = fetchLidl;