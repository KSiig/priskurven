/**
 * SII-131 — Fill empty product slots from a unique GTIN.
 *
 * For each product that already has at least one `product_slots` row,
 * take the union of `gtins` on the listings its slots point at. For
 * each store in the canonical store list that does not yet have a
 * slot on this product, find listings in that store whose `gtins`
 * share one of those strings. When the set of matching `source_sku`
 * values has size 1, insert one `product_slots` row with
 * `matched_by = 'ean'`. When the size is 0 or more than 1, leave the
 * slot empty.
 *
 * This module never creates a product, never overwrites a slot, and
 * never deletes a slot. A `manual` slot stays. An existing `ean`
 * slot stays. A constraint error on one product is logged and the
 * next product is processed.
 *
 * The SII-130 writer adds `query<T>` to {@link D1Client}; SII-131
 * imports it from there. There is no second D1 client.
 */

import type { D1Client } from "./d1.js";

/** Canonical store list, in the order SII-129's API emits them. */
export const STORES: readonly string[] = [
  "rema",
  "minkobmand",
  "spar",
  "netto",
  "bilkatogo",
  "fotex",
  "lidl",
  "nemlig",
] as const;

export type Store = (typeof STORES)[number];

/** One product row pulled from `products`. */
interface ProductRow {
  id: number;
  label: string;
}

/** One slot row pulled from `product_slots`. */
interface SlotRow {
  product_id: number;
  source: string;
  source_sku: string;
  matched_by: "manual" | "ean";
}

/** One listing row pulled from `listings`. Only the columns we need. */
interface ListingRow {
  source: string;
  source_sku: string;
  gtins: string;
}

/** Outcome of a single fill pass. */
export interface FillSlotsSummary {
  /** Number of products considered (had at least one slot to seed gtins from). */
  productsConsidered: number;
  /** Number of `ean` slots inserted. */
  slotsFilled: number;
  /** Number of products that raised a constraint error and were skipped. */
  productsErrored: number;
}

/** Read every product. */
async function readProducts(client: D1Client): Promise<ProductRow[]> {
  return client.query<ProductRow>(
    "SELECT id, label FROM products",
  );
}

/** Read every slot. */
async function readSlots(client: D1Client): Promise<SlotRow[]> {
  return client.query<SlotRow>(
    "SELECT product_id, source, source_sku, matched_by FROM product_slots",
  );
}

/** Read every listing's `gtins` text. */
async function readListings(client: D1Client): Promise<ListingRow[]> {
  return client.query<ListingRow>(
    "SELECT source, source_sku, gtins FROM listings",
  );
}

/**
 * Parse the `gtins` JSON text of a listing. Returns an empty array
 * on `[]`, an empty array when the value is the SQL default
 * (`'[]'`), and an empty array when the value is not JSON. A
 * non-array parsed value is also rejected.
 */
export function parseGtins(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  const text = String(raw).trim();
  if (text === "" || text === "[]") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((g): g is string => typeof g === "string");
}

/**
 * Seed the union of GTINs for a product from the listings its
 * existing slots point at. `[]` is ignored (already in
 * `parseGtins`). Listings whose `gtins` text is not JSON are
 * skipped and logged. Returns the union as a Set.
 */
function seedGtinsForProduct(
  productId: number,
  slots: readonly SlotRow[],
  listings: ReadonlyMap<string, ListingRow>,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Set<string> {
  const union = new Set<string>();
  for (const slot of slots) {
    if (slot.product_id !== productId) continue;
    const key = `${slot.source}::${slot.source_sku}`;
    const listing = listings.get(key);
    if (!listing) continue;
    const text = listing.gtins;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        for (const g of parsed) {
          if (typeof g === "string" && g !== "") union.add(g);
        }
      } else {
        log("fillEmptySlots: listing gtins is not a JSON array, skipping", {
          source: slot.source,
          source_sku: slot.source_sku,
        });
      }
    } catch {
      log("fillEmptySlots: listing gtins is not JSON, skipping", {
        source: slot.source,
        source_sku: slot.source_sku,
      });
    }
  }
  return union;
}

/** True when the slot is filled for this product on this store. */
function storeHasSlot(
  productId: number,
  store: string,
  slots: readonly SlotRow[],
): boolean {
  for (const slot of slots) {
    if (slot.product_id === productId && slot.source === store) {
      return true;
    }
  }
  return false;
}

/**
 * For one product, run the per-store GTIN match. Returns the list of
 * `(source, source_sku)` rows that should be inserted as new `ean`
 * slots. Insertion itself is performed by the caller; that lets the
 * caller wrap a per-product try/catch without breaking the loop.
 */
function planEanInserts(
  productId: number,
  seedGtins: ReadonlySet<string>,
  slots: readonly SlotRow[],
  listings: readonly ListingRow[],
): Array<{ source: string; source_sku: string }> {
  if (seedGtins.size === 0) return [];
  const inserts: Array<{ source: string; source_sku: string }> = [];
  for (const store of STORES) {
    if (storeHasSlot(productId, store, slots)) continue;
    const skusForThisStore = new Set<string>();
    for (const listing of listings) {
      if (listing.source !== store) continue;
      const listingGtins = parseGtins(listing.gtins);
      let shares = false;
      for (const g of listingGtins) {
        if (seedGtins.has(g)) {
          shares = true;
          break;
        }
      }
      if (shares) skusForThisStore.add(listing.source_sku);
    }
    if (skusForThisStore.size === 1) {
      const source_sku = skusForThisStore.values().next().value as string;
      inserts.push({ source: store, source_sku });
    }
    // 0 or >1 — leave the slot empty. Per spec.
  }
  return inserts;
}

/**
 * Run the M2 slot filler. Safe to call from the handler after
 * `runOrchestrator` resolves. Throws only on environment-level
 * failures (cannot read the tables); per-product errors are caught,
 * logged via the supplied `log` function, and counted in
 * `productsErrored`.
 */
export async function fillEmptySlots(
  client: D1Client,
  log: (message: string, fields?: Record<string, unknown>) => void = (
    message,
    fields,
  ) => {
    if (fields) {
      console.error(message, fields);
    } else {
      console.error(message);
    }
  },
): Promise<FillSlotsSummary> {
  const products = await readProducts(client);
  const slots = await readSlots(client);
  const listings = await readListings(client);

  // Index listings by (source, source_sku) so seedGtins is O(slots) per
  // product, not O(slots * listings).
  const listingByPair = new Map<string, ListingRow>();
  for (const listing of listings) {
    listingByPair.set(`${listing.source}::${listing.source_sku}`, listing);
  }

  const summary: FillSlotsSummary = {
    productsConsidered: 0,
    slotsFilled: 0,
    productsErrored: 0,
  };

  for (const product of products) {
    // Only consider products that already have at least one slot. We
    // do not create products.
    const hasAnySlot = slots.some((s) => s.product_id === product.id);
    if (!hasAnySlot) continue;
    summary.productsConsidered += 1;

    try {
      const seedGtins = seedGtinsForProduct(
        product.id,
        slots,
        listingByPair,
        log,
      );
      const inserts = planEanInserts(
        product.id,
        seedGtins,
        slots,
        listings,
      );
      for (const row of inserts) {
        await client.exec(
          "INSERT INTO product_slots (product_id, source, source_sku, matched_by) VALUES (?, ?, ?, 'ean')",
          [product.id, row.source, row.source_sku],
        );
        summary.slotsFilled += 1;
      }
    } catch (err) {
      summary.productsErrored += 1;
      const message = err instanceof Error ? err.message : String(err);
      log("fillEmptySlots: product error, continuing", {
        product_id: product.id,
        error: message,
      });
    }
  }

  return summary;
}
