/**
 * Nemlig.com shelf-price collector.
 *
 * Nemlig exposes the daily-vare catalog as JSON (not behind Queue-it like
 * the HTML product pages are). The fetcher walks the catalog by:
 *
 *   1. GET https://www.nemlig.com/dagligvarer?sortorder=navn  with
 *      `Accept: application/json`. The response carries
 *        - `Settings.CombinedProductsAndSitecoreTimestamp`
 *          (format: `<ProductsImportedTimestamp>-<SitecorePublishedStamp>`)
 *        - `Settings.TimeslotUtc` (delivery-slot id)
 *        - `content[].ProductGroupId` (UUID, one per product-list ribbon)
 *
 *   2. For each `ProductGroupId`, GET
 *      `/webapi/{CombinedProductsAndSitecoreTimestamp}/{TimeslotUtc}/1/0/Products/GetByProductGroupId?productGroupId={UUID}`.
 *      The response carries `Products[]` with `Id` and `Name`; the JSON
 *      payload does NOT carry GTINs, so `gtins` stays `[]` for every row.
 *
 * The path-segment values (timestamp, timeslot) MUST be read from the
 * frontpage — hard-coding `/webapi/s/0/1/0/...` (the literal Sitecore
 * default) 404s/500s as soon as Nemlig rotates the slot. The fixture
 * suite asserts this by using non-trivial `s`-values so a hardcoded
 * path fails the test.
 *
 * Spec: SII-96. No isolation logic — see SII-103.
 */

/**
 * Canonical observation emitted by every Priskurven source.  The shape
 * is owned by SII-103; this file inlines it so the module stands
 * alone until the shared type module lands on main.
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

export const SOURCE = 'nemlig' as const;
export const CURRENCY = 'DKK' as const;

/** Dagligvarer frontpage, JSON variant. */
export const FRONTPAGE_URL =
  'https://www.nemlig.com/dagligvarer?sortorder=navn' as const;

/** Origin used by the per-group webapi calls. */
export const WEBAPI_ORIGIN = 'https://www.nemlig.com' as const;

/** Subset of the frontpage payload we touch. */
export type NemligFrontpage = {
  Settings?: {
    CombinedProductsAndSitecoreTimestamp?: string;
    TimeslotUtc?: string;
  };
  content?: ReadonlyArray<{ ProductGroupId?: string } | null | undefined>;
};

/** Subset of the per-group payload we touch. */
export type NemligGroupResponse = {
  Products?: ReadonlyArray<NemligProduct | null | undefined>;
};

/** Subset of a single Nemlig product that we read. */
export type NemligProduct = {
  Id?: string | number;
  Name?: string;
  /** Nemlig serialises Price as a JSON number (e.g. `32.0`). */
  Price?: number | string | null;
  Brand?: string | null;
  [key: string]: unknown;
};

type Fetcher = typeof fetch;

/**
 * EAN-13 checksum per GS1.  Returns true iff `s` is a 13-digit string
 * whose trailing check digit matches the mod-10 algorithm with
 * weights 1,3,1,3,... applied left-to-right over the leading 12
 * digits.  Used to decide whether an opaque string from a payload
 * belongs in `gtins`.
 */
export function isValidEan13(s: unknown): s is string {
  if (typeof s !== 'string' || s.length !== 13) return false;
  for (let i = 0; i < 13; i++) {
    const code = s.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = s.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === s.charCodeAt(12) - 48;
}

/**
 * Build the per-group webapi URL.  Pulled out as a one-liner helper
 * so the URL shape (timestamp segment + timeslot segment +
 * productGroupId query) lives in exactly one place.  Tests assert the
 * emitted URL goes through here rather than being hard-coded.
 */
export function groupUrl(
  timestamp: string,
  timeslot: string,
  productGroupId: string,
): string {
  return `${WEBAPI_ORIGIN}/webapi/${timestamp}/${timeslot}/1/0/Products/GetByProductGroupId?productGroupId=${encodeURIComponent(productGroupId)}`;
}

/**
 * Fetch the frontpage JSON.  Throws on non-2xx so the caller can
 * surface the failure (SII-103 owns the per-source isolation policy).
 */
export async function fetchNemligFrontpage(
  fetcher: Fetcher = fetch,
  url: string = FRONTPAGE_URL,
): Promise<NemligFrontpage> {
  const res = await fetcher(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`nemlig frontpage GET ${url} -> HTTP ${res.status}`);
  }
  return (await res.json()) as NemligFrontpage;
}

/**
 * Fetch one product group's `Products[]`.  Throws on non-2xx.  The
 * `timestamp` and `timeslot` are read from the frontpage
 * `Settings.CombinedProductsAndSitecoreTimestamp` and
 * `Settings.TimeslotUtc`; do not hard-code them.
 */
export async function fetchNemligGroup(
  fetcher: Fetcher,
  timestamp: string,
  timeslot: string,
  productGroupId: string,
): Promise<NemligGroupResponse> {
  const url = groupUrl(timestamp, timeslot, productGroupId);
  const res = await fetcher(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`nemlig group ${productGroupId} GET -> HTTP ${res.status}`);
  }
  return (await res.json()) as NemligGroupResponse;
}

/** Pull a finite number out of Nemlig's `Price` field. */
function priceOf(p: NemligProduct): number {
  if (typeof p.Price === 'number' && Number.isFinite(p.Price)) return p.Price;
  if (typeof p.Price === 'string') {
    const n = Number(p.Price);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * Pure transform from a parsed per-group payload to the observations
 * it yields.  Exported so tests can drive the mapping straight from a
 * fixture without going through the network.
 */
export function observationsFromGroup(
  group: NemligGroupResponse,
  observedAt: string,
): Observation[] {
  const out: Observation[] = [];
  for (const p of group.Products ?? []) {
    if (p == null) continue;
    const id = p.Id;
    if (id == null) continue;
    const obs: Observation = {
      source: SOURCE,
      source_sku: String(id),
      observed_at: observedAt,
      price: priceOf(p),
      currency: CURRENCY,
      gtins: [],
      raw: p,
    };
    if (typeof p.Name === 'string' && p.Name.length > 0) {
      obs.name = p.Name;
    }
    if (typeof p.Brand === 'string' && p.Brand.length > 0) {
      obs.brand = p.Brand;
    }
    out.push(obs);
  }
  return out;
}

/**
 * The Nemlig source.  Implements {@link Source}: zero-arg factory
 * returning an `AsyncIterable<Observation>`.  Iterating the iterable
 * issues one frontpage GET and one GET per `ProductGroupId` it
 * discovers.
 */
export async function* nemlig(): AsyncIterable<Observation> {
  const frontpage = await fetchNemligFrontpage();
  const ts = frontpage.Settings?.CombinedProductsAndSitecoreTimestamp;
  const slot = frontpage.Settings?.TimeslotUtc;
  if (typeof ts !== 'string' || ts.length === 0) {
    throw new Error('nemlig: missing Settings.CombinedProductsAndSitecoreTimestamp');
  }
  if (typeof slot !== 'string' || slot.length === 0) {
    throw new Error('nemlig: missing Settings.TimeslotUtc');
  }
  const observedAt = new Date().toISOString();
  for (const node of frontpage.content ?? []) {
    const id = node?.ProductGroupId;
    if (typeof id !== 'string' || id.length === 0) continue;
    const group = await fetchNemligGroup(fetch, ts, slot, id);
    for (const obs of observationsFromGroup(group, observedAt)) {
      yield obs;
    }
  }
}