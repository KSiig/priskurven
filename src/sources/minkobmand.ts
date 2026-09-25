import type { Observation, Source } from '../types.js';

/**
 * Min Købmand Holluf Pile shelf-price collector.
 *
 * Pulls from the public Longjohn catalog (`longjohnapi.azurewebsites.net`).
 * Store: Hollufgårdsvej 219, 5220 Odense SØ — Longjohn `merchantId=769`.
 *
 * Spec: SII-92. No isolation logic — see SII-103.
 */

const SOURCE = 'minkobmand';
const MERCHANT_ID = 769;
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

async function* fetchMinkobmand(): AsyncIterable<Observation> {
  const url = `${URL_BASE}?merchantId=${MERCHANT_ID}&pageNumber=0&pageSize=${PAGE_SIZE}&displayedInStore=true`;
  const observedAt = new Date().toISOString();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`minkobmand: HTTP ${res.status} from Longjohn`);
  }
  const body = (await res.json()) as LongjohnResponse;
  for (const p of body.products) {
    yield mapProduct(p, observedAt);
  }
}

/**
 * Pinned: single GET with `pageSize=10000`. No `pageNumber` walk unless
 * a future probe shows the response is truncated.
 */
export const minkobmand: Source = fetchMinkobmand;