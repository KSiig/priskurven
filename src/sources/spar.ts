/**
 * SPAR Odense NØ shelf-price collector.
 *
 * Pulls from the public Longjohn catalog (`longjohnapi.azurewebsites.net`).
 * Store: Risingevej 132, 5240 Odense NØ — Longjohn `merchantId=1329`.
 *
 * This is an optional extra Dagrofa source; lower priority than
 * Min Købmand Holluf Pile (merchantId=769, 5220 Odense SØ).
 *
 * NOTE: `merchantId=1329` is the SPAR Odense NØ store at **5240** —
 * NOT Kasper's default 5220 store, and NOT the heissepreise SPAR
 * default `merchantId=1222` (Glostrup).
 *
 * Spec: SII-95. No isolation logic — see SII-103. The Longjohn client
 * mirrors SII-92 (`src/sources/minkobmand.ts`); once SII-92 lands on
 * main this file should be migrated to import a shared Longjohn
 * helper instead of duplicating the request/parse logic.
 *
 * @see https://linear.app/siig/issue/SII-95
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

const SOURCE = 'spar';
const MERCHANT_ID = 1329;
const CURRENCY = 'DKK';
const URL_BASE = 'https://longjohnapi.azurewebsites.net/Product/query';
const PAGE_SIZE = 10000;

type LongjohnProduct = {
  id: number;
  productDisplayName: string;
  sku: string;
  assortmentNumber: string;
  price: number;
  discountPrice: number;
  discountAmount: number;
  discountMaxQuantity: number;
  summary: string;
  advertisementProduct: boolean;
  categoryId: number;
  isTobacco: boolean;
  lowResImg: string;
  medResImg: string;
  highResImg: string;
  ageRestricted: boolean;
};

type LongjohnResponse = {
  total: number;
  products: LongjohnProduct[];
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

function mapProduct(p: LongjohnProduct, observedAt: string): Observation {
  const hasDiscount = p.discountPrice > 0;
  return {
    source: SOURCE,
    source_sku: p.sku,
    observed_at: observedAt,
    price: hasDiscount ? p.discountPrice : p.price,
    currency: CURRENCY,
    name: p.productDisplayName,
    gtins: isValidEan13(p.sku) ? [p.sku] : [],
    raw: p,
  };
}

async function* fetchSpar(): AsyncIterable<Observation> {
  const url = `${URL_BASE}?merchantId=${MERCHANT_ID}&pageNumber=0&pageSize=${PAGE_SIZE}&displayedInStore=true`;
  const observedAt = new Date().toISOString();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`spar: HTTP ${res.status} from Longjohn`);
  }
  const body = (await res.json()) as LongjohnResponse;
  for (const p of body.products) {
    yield mapProduct(p, observedAt);
  }
}

/**
 * Pinned: single GET with `pageSize=10000`. No `pageNumber` walk unless
 * a future probe shows the response is truncated.  Live dry-run on
 * 2026-09-20 against `merchantId=1329` returned 5044 products in one
 * page — well within `PAGE_SIZE`.
 */
export const spar: Source = fetchSpar;
