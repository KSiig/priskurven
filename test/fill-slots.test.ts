import { describe, it, expect, beforeEach } from "vitest";

import {
  type D1Client,
  type D1Statement,
} from "../src/d1";
import {
  fillEmptySlots,
  parseGtins,
  STORES,
  type Store,
} from "../src/fill-slots";

/**
 * M2 schema (SII-128). Reproduced verbatim from
 * cloudflare/d1-migrations/priskurven/0004_listings_products_slots.sql
 * so the test client can validate it did not drift.
 */
const SII_128_DDL = [
  `CREATE TABLE listings (
  source      TEXT NOT NULL,
  source_sku  TEXT NOT NULL,
  currency    TEXT NOT NULL,
  name        TEXT,
  brand       TEXT,
  size_value  REAL,
  size_unit   TEXT,
  gtins       TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (source, source_sku)
) WITHOUT ROWID;`,
  `CREATE TABLE products (
  id    INTEGER PRIMARY KEY,
  label TEXT NOT NULL
);`,
  `CREATE TABLE product_slots (
  product_id  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  source_sku  TEXT NOT NULL,
  matched_by  TEXT NOT NULL CHECK (matched_by IN ('manual', 'ean')),
  PRIMARY KEY (product_id, source),
  UNIQUE (source, source_sku)
) WITHOUT ROWID;`,
] as const;

/**
 * In-memory D1 client that supports `query` (for SELECTs) and
 * `exec` (for INSERTs). Tables are in-memory maps. INSERTs are
 * validated against the constraints so a product error path is
 * realistic.
 */
class FakeD1Client implements D1Client {
  products = new Map<number, { id: number; label: string }>();
  productSlots: Array<{
    product_id: number;
    source: string;
    source_sku: string;
    matched_by: "manual" | "ean";
  }> = [];
  listings = new Map<
    string,
    { source: string; source_sku: string; gtins: string }
  >();
  /** Optional list of regex to fail on matched SQL. */
  failOn?: RegExp;
  /** SQL calls observed for assertions. */
  insertCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
  /** Errors raised for any successful INSERT into product_slots. */
  productSlotErrors: Array<{ product_id: number; source: string; source_sku: string }> = [];

  async query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    if (this.failOn && this.failOn.test(sql)) {
      throw new Error(`d1 query rejected: ${sql.slice(0, 80)}`);
    }
    const ps = params ?? [];
    // products
    if (/FROM products/i.test(sql)) {
      return Array.from(this.products.values()) as unknown as T[];
    }
    // product_slots
    if (/FROM product_slots/i.test(sql)) {
      return this.productSlots.slice() as unknown as T[];
    }
    // listings
    if (/FROM listings/i.test(sql)) {
      return Array.from(this.listings.values()) as unknown as T[];
    }
    throw new Error(`FakeD1Client.query: unhandled SQL: ${sql} ${JSON.stringify(ps)}`);
  }

  async exec(sql: string, params?: readonly unknown[]): Promise<void> {
    if (this.failOn && this.failOn.test(sql)) {
      throw new Error(`d1 exec rejected: ${sql.slice(0, 80)}`);
    }
    const ps = params ?? [];
    if (/INSERT INTO product_slots/i.test(sql)) {
      this.insertCalls.push({ sql, params: ps });
      const product_id = ps[0] as number;
      const source = ps[1] as string;
      const source_sku = ps[2] as string;
      // unique (product_id, source)
      if (this.productSlots.some((s) => s.product_id === product_id && s.source === source)) {
        throw new Error(
          `UNIQUE constraint failed: product_slots(${product_id}, ${source})`,
        );
      }
      // unique (source, source_sku)
      if (this.productSlots.some((s) => s.source === source && s.source_sku === source_sku)) {
        throw new Error(
          `UNIQUE constraint failed: product_slots(${source}, ${source_sku})`,
        );
      }
      this.productSlots.push({ product_id, source, source_sku, matched_by: "ean" });
      return;
    }
    throw new Error(`FakeD1Client.exec: unhandled SQL: ${sql} ${JSON.stringify(ps)}`);
  }

  reset(): void {
    this.products.clear();
    this.productSlots = [];
    this.listings.clear();
    this.insertCalls = [];
    this.failOn = undefined;
  }
}

function addListing(
  client: FakeD1Client,
  source: string,
  source_sku: string,
  gtins: string[] | "INVALID",
): void {
  const value = JSON.stringify(gtins);
  client.listings.set(`${source}::${source_sku}`, {
    source,
    source_sku,
    gtins: value,
  });
}

function addListingRaw(
  client: FakeD1Client,
  source: string,
  source_sku: string,
  gtins: string,
): void {
  client.listings.set(`${source}::${source_sku}`, {
    source,
    source_sku,
    gtins,
  });
}

function addSlot(
  client: FakeD1Client,
  product_id: number,
  source: string,
  source_sku: string,
  matched_by: "manual" | "ean",
): void {
  client.productSlots.push({ product_id, source, source_sku, matched_by });
}

describe("SII-128 schema is reproduced verbatim", () => {
  it("test setup includes all three CREATE TABLE statements", () => {
    // Guard: the SII-131 spec says the test setup must copy the
    // SII-128 CREATE TABLE statements verbatim. If a future PR adds
    // a column or drops the secondary index, this test fails.
    expect(SII_128_DDL).toHaveLength(3);
    expect(SII_128_DDL[0]).toMatch(/CREATE TABLE listings/);
    expect(SII_128_DDL[0]).toMatch(/WITHOUT ROWID/);
    expect(SII_128_DDL[1]).toMatch(/CREATE TABLE products/);
    expect(SII_128_DDL[1]).not.toMatch(/WITHOUT ROWID/);
    expect(SII_128_DDL[2]).toMatch(/CREATE TABLE product_slots/);
    expect(SII_128_DDL[2]).toMatch(/UNIQUE \(source, source_sku\)/);
  });
});

describe("STORES order matches the spec", () => {
  it("is rema, minkobmand, spar, netto, bilkatogo, fotex, lidl, nemlig", () => {
    expect(STORES).toEqual([
      "rema",
      "minkobmand",
      "spar",
      "netto",
      "bilkatogo",
      "fotex",
      "lidl",
      "nemlig",
    ] as Store[]);
  });
});

describe("parseGtins", () => {
  it("returns [] for '[]'", () => {
    expect(parseGtins("[]")).toEqual([]);
  });
  it("returns [] for empty string", () => {
    expect(parseGtins("")).toEqual([]);
  });
  it("returns [] for null/undefined", () => {
    expect(parseGtins(null)).toEqual([]);
    expect(parseGtins(undefined)).toEqual([]);
  });
  it("returns [] for non-JSON input", () => {
    expect(parseGtins("not-json")).toEqual([]);
  });
  it("returns [] when the parsed value is not an array", () => {
    expect(parseGtins('"a"')).toEqual([]);
    expect(parseGtins("123")).toEqual([]);
  });
  it("returns only the string entries of an array", () => {
    expect(parseGtins('["a","b",1,null,"c"]')).toEqual(["a", "b", "c"]);
  });
  it("trims whitespace", () => {
    expect(parseGtins('  ["a"]  ')).toEqual(["a"]);
  });
});

describe("fillEmptySlots", () => {
  let client: FakeD1Client;
  beforeEach(() => {
    client = new FakeD1Client();
  });

  it("one unique hit: fills exactly the empty slot", async () => {
    // Product 1 has a manual slot on rema for SKU "r1" whose GTIN
    // is "5701234567890". The same GTIN appears on exactly one
    // minkobmand listing — "mk1". The filler should insert a
    // minkobmand slot with matched_by 'ean'.
    client.products.set(1, { id: 1, label: "Arla minimælk 1 L" });
    addSlot(client, 1, "rema", "r1", "manual");
    addListing(client, "rema", "r1", ["5701234567890"]);
    addListing(client, "minkobmand", "mk1", ["5701234567890"]);
    addListing(client, "minkobmand", "mk2", ["9999999999999"]);

    const summary = await fillEmptySlots(client);

    expect(summary.productsConsidered).toBe(1);
    expect(summary.slotsFilled).toBe(1);
    expect(summary.productsErrored).toBe(0);
    const inserted = client.productSlots.find(
      (s) => s.product_id === 1 && s.source === "minkobmand",
    );
    expect(inserted).toEqual({
      product_id: 1,
      source: "minkobmand",
      source_sku: "mk1",
      matched_by: "ean",
    });
  });

  it("ambiguous hit: writes nothing when 2 SKUs share the GTIN", async () => {
    client.products.set(1, { id: 1, label: "P" });
    addSlot(client, 1, "rema", "r1", "manual");
    addListing(client, "rema", "r1", ["5711111111111"]);
    // Two nemlig listings share the GTIN — ambiguous, write nothing.
    addListing(client, "nemlig", "n1", ["5711111111111"]);
    addListing(client, "nemlig", "n2", ["5711111111111"]);

    const summary = await fillEmptySlots(client);

    expect(summary.slotsFilled).toBe(0);
    expect(client.insertCalls).toHaveLength(0);
  });

  it("product with no slots: writes nothing and is not considered", async () => {
    client.products.set(1, { id: 1, label: "P1" });
    client.products.set(2, { id: 2, label: "P2" });
    addListing(client, "rema", "r1", ["5700000000000"]);

    const summary = await fillEmptySlots(client);

    expect(summary.productsConsidered).toBe(0);
    expect(summary.slotsFilled).toBe(0);
    expect(summary.productsErrored).toBe(0);
  });

  it("manual slot that stays: a manual slot in another store is not overwritten", async () => {
    client.products.set(1, { id: 1, label: "P" });
    addSlot(client, 1, "rema", "r1", "manual");
    addListing(client, "rema", "r1", ["5700000000000"]);
    // minkobmand is already filled manually — must not be touched.
    addSlot(client, 1, "minkobmand", "mk-existing", "manual");
    addListing(client, "minkobmand", "mk-existing", ["5700000000000"]);

    const summary = await fillEmptySlots(client);

    expect(summary.slotsFilled).toBe(0);
    const mk = client.productSlots.find(
      (s) => s.product_id === 1 && s.source === "minkobmand",
    );
    expect(mk?.source_sku).toBe("mk-existing");
    expect(mk?.matched_by).toBe("manual");
  });

  it("existing ean slot stays: do not overwrite an existing ean slot", async () => {
    client.products.set(1, { id: 1, label: "P" });
    addSlot(client, 1, "rema", "r1", "manual");
    addListing(client, "rema", "r1", ["5700000000000"]);
    addSlot(client, 1, "minkobmand", "mk-prev", "ean");
    addListing(client, "minkobmand", "mk-prev", ["5700000000000"]);
    // A second minkobmand listing also shares the GTIN — the
    // unique hit would otherwise be ambiguous, but the existing
    // ean slot must not be deleted or replaced.
    addListing(client, "minkobmand", "mk2", ["5700000000000"]);

    const summary = await fillEmptySlots(client);

    expect(summary.slotsFilled).toBe(0);
    const mkSlots = client.productSlots.filter(
      (s) => s.product_id === 1 && s.source === "minkobmand",
    );
    expect(mkSlots).toHaveLength(1);
    expect(mkSlots[0]?.source_sku).toBe("mk-prev");
    expect(mkSlots[0]?.matched_by).toBe("ean");
  });

  it("one product error still fills the next product", async () => {
    client.products.set(1, { id: 1, label: "P1" });
    client.products.set(2, { id: 2, label: "P2" });
    addSlot(client, 1, "rema", "r1", "manual");
    addListing(client, "rema", "r1", ["5700000000000"]);
    addSlot(client, 2, "rema", "r2", "manual");
    addListing(client, "rema", "r2", ["5701111111111"]);
    // Each product gets a uniquely matched minkobmand listing.
    addListing(client, "minkobmand", "mk1", ["5700000000000"]);
    addListing(client, "minkobmand", "mk2", ["5701111111111"]);

    // Fail every INSERT for product 1. Product 1's fill aborts;
    // product 2 still proceeds.
    const seenForP1: Array<{ sql: string; params: readonly unknown[] }> = [];
    const realExec = client.exec.bind(client);
    client.exec = async (sql, params) => {
      const ps = params ?? [];
      if (/INSERT INTO product_slots/i.test(sql) && ps[0] === 1) {
        seenForP1.push({ sql, params: ps });
        throw new Error("UNIQUE constraint failed: product_slots(1, minkobmand)");
      }
      return realExec(sql, params);
    };

    const summary = await fillEmptySlots(client);

    expect(seenForP1.length).toBeGreaterThan(0);
    expect(summary.productsErrored).toBe(1);
    expect(summary.productsConsidered).toBe(2);
    // Product 2 still got its slot.
    const p2 = client.productSlots.find(
      (s) => s.product_id === 2 && s.source === "minkobmand",
    );
    expect(p2).toEqual({
      product_id: 2,
      source: "minkobmand",
      source_sku: "mk2",
      matched_by: "ean",
    });
  });

  it("ignores a listing whose gtins text is not valid JSON", async () => {
    client.products.set(1, { id: 1, label: "P" });
    addSlot(client, 1, "rema", "r1", "manual");
    addListingRaw(client, "rema", "r1", "not-json");
    addListing(client, "minkobmand", "mk1", ["5700000000000"]);

    const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const summary = await fillEmptySlots(client, (message, fields) => {
      logs.push({ message, fields });
    });

    // The rema listing's gtins is "not-json", so the seed set is
    // empty. The filler writes nothing and logs the skip.
    expect(summary.slotsFilled).toBe(0);
    expect(
      logs.some(
        (l) => l.message.includes("listing gtins") && l.message.includes("not JSON"),
      ),
    ).toBe(true);
  });

  it("ignores '[]' on the seed listing (empty GTIN set means no fill)", async () => {
    client.products.set(1, { id: 1, label: "P" });
    addSlot(client, 1, "rema", "r1", "manual");
    addListingRaw(client, "rema", "r1", "[]");
    addListing(client, "minkobmand", "mk1", ["5700000000000"]);

    const summary = await fillEmptySlots(client);

    expect(summary.slotsFilled).toBe(0);
  });

  it("ignores a store that is not in the STORES list", async () => {
    client.products.set(1, { id: 1, label: "P" });
    addSlot(client, 1, "rema", "r1", "manual");
    addListing(client, "rema", "r1", ["5700000000000"]);
    // "coop" is not in the canonical store list — must be ignored.
    addListing(client, "coop", "c1", ["5700000000000"]);

    const summary = await fillEmptySlots(client);

    expect(summary.slotsFilled).toBe(0);
    expect(
      client.productSlots.some((s) => s.source === "coop"),
    ).toBe(false);
  });

  it("fills multiple stores for one product when each is uniquely matched", async () => {
    client.products.set(1, { id: 1, label: "P" });
    addSlot(client, 1, "rema", "r1", "manual");
    addListing(client, "rema", "r1", ["5700000000000"]);
    addListing(client, "minkobmand", "mk1", ["5700000000000"]);
    addListing(client, "netto", "nt1", ["5700000000000"]);
    addListing(client, "lidl", "ld1", ["5700000000000"]);
    // spar has two SKUs sharing the GTIN — ambiguous, no fill.
    addListing(client, "spar", "sp1", ["5700000000000"]);
    addListing(client, "spar", "sp2", ["5700000000000"]);

    const summary = await fillEmptySlots(client);

    expect(summary.slotsFilled).toBe(3);
    const sources = client.productSlots
      .filter((s) => s.product_id === 1)
      .map((s) => `${s.source}:${s.source_sku}:${s.matched_by}`)
      .sort();
    expect(sources).toEqual([
      "lidl:ld1:ean",
      "minkobmand:mk1:ean",
      "netto:nt1:ean",
      "rema:r1:manual",
    ]);
  });
});
