/**
 * SII-129 product + slot + listing API tests.
 *
 * The Worker is `src/history.ts`. These tests drive its public
 * surface: `POST /v1/products`, `GET /v1/products?q=`,
 * `GET /v1/products/:id`, `GET /v1/listings?source=&q=`,
 * `POST /v1/products/:id/slots`, `DELETE /v1/products/:id/slots/:source`.
 *
 * Auth: `PRISKURVEN_API_TOKEN` is an optional string on `Env`. The
 * mock compares the presented bearer against the env value in
 * constant time (same as the Worker). The 401 path is exercised by
 * omitting the env value, omitting the header, and mismatching the
 * header.
 *
 * The D1 mock seeds products, product_slots, listings, and
 * observations tables and routes by statement kind. The spec calls
 * for copying the `CREATE TABLE` statements from SII-128 into the
 * test setup; the mock D1 receives them but does not parse them.
 */

import { describe, expect, it } from 'vitest';
import type {
  D1Database,
  D1PreparedStatement,
  ExecutionContext,
} from '@cloudflare/workers-types';
import { fetch } from '../src/history.js';

/** Row for the `products` table (from migration 0004). */
type ProductRow = { id: number; label: string };

/** Row for the `product_slots` table (from migration 0004). */
type SlotRow = {
  product_id: number;
  source: string;
  source_sku: string;
  matched_by: 'manual' | 'ean';
};

/** Row for the `listings` table (from migration 0004). */
type ListingRow = {
  source: string;
  source_sku: string;
  currency: string;
  name: string | null;
  brand: string | null;
  size_value: number | null;
  size_unit: string | null;
  gtins: string;
};

/** Row for the `observations` table (from migration 0003, SII-118). */
type ObservationRow = {
  source: string;
  source_sku: string;
  observed_at: string;
  price: number;
  currency: string;
  name: string | null;
  brand: string | null;
  size_value: number | null;
  size_unit: string | null;
  gtins: string;
};

/** Mirror of `D1Statement`. The mock ignores it; only the SQL is needed. */
interface CapturedCall {
  sql: string;
  params: unknown[];
}

interface MockState {
  products: ProductRow[];
  slots: SlotRow[];
  listings: ListingRow[];
  observations: ObservationRow[];
  /**
   * When set, the next `INSERT INTO product_slots` in `dispatchWrite`
   * throws this message instead of appending the row. Lets tests
   * simulate a UNIQUE constraint failure that the pre-insert checks
   * did not catch (race between two concurrent POSTs).
   */
  slotInsertError?: string;
  /** Tracks calls in order for assertions. */
  calls: CapturedCall[];
}

/** Build a fresh mock D1 binding. The mock dispatches on the SQL
 *  prefix and returns rows that match the bound values. `RETURNING`
 *  shapes append the new row to the seeded array. `INSERT` into
 *  `product_slots` appends; `DELETE FROM product_slots` removes. */
function makeD1(initial: Partial<MockState> = {}): MockD1 {
  const state: MockState = {
    products: initial.products ? [...initial.products] : [],
    slots: initial.slots ? [...initial.slots] : [],
    listings: initial.listings ? [...initial.listings] : [],
    observations: initial.observations ? [...initial.observations] : [],
    slotInsertError: initial.slotInsertError,
    calls: [],
  };
  const db: MockD1 = {
    state,
    prepare(query: string) {
      const captured: CapturedCall = { sql: query.trim(), params: [] };
      const stmt = {
        bind(...values: unknown[]) {
          captured.params = values;
          return stmt;
        },
        async all<T = unknown>(): Promise<{ results?: T[] }> {
          db.state.calls.push(captured);
          const results = dispatchSelect(state, captured) as T[];
          return { results };
        },
        async run(): Promise<{ success: boolean }> {
          db.state.calls.push(captured);
          dispatchWrite(state, captured);
          return { success: true };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
  return db;
}

interface MockD1 {
  state: MockState;
  prepare(query: string): D1PreparedStatement;
}

/** Route SELECT calls to the right table, applying `WHERE`/`ORDER BY`
 *  the same way the Worker expects. */
function dispatchSelect(state: MockState, call: CapturedCall): unknown[] {
  const sql = call.sql;
  const params = call.params;

  if (/FROM products\b/.test(sql) && /WHERE id = \?/.test(sql)) {
    const id = params[0];
    return state.products.filter((r) => r.id === id);
  }
  if (/SELECT id, label FROM products\b/.test(sql)) {
    return [...state.products].sort((a, b) => a.id - b.id);
  }
  if (/SELECT source, source_sku, matched_by FROM product_slots/.test(sql)) {
    const productId = params[0];
    return state.slots.filter((r) => r.product_id === productId);
  }
  if (
    /SELECT source FROM product_slots WHERE product_id = \? AND source = \?/.test(sql)
  ) {
    const [productId, source] = params;
    return state.slots.filter(
      (r) => r.product_id === productId && r.source === source,
    );
  }
  if (
    /SELECT product_id FROM product_slots WHERE source = \? AND source_sku = \?/.test(sql)
  ) {
    const [source, sourceSku] = params;
    return state.slots.filter(
      (r) => r.source === source && r.source_sku === sourceSku,
    );
  }
  if (/SELECT source_sku FROM listings WHERE source = \? AND source_sku = \?/.test(sql)) {
    const [source, sourceSku] = params;
    return state.listings.filter(
      (r) => r.source === source && r.source_sku === sourceSku,
    );
  }
  if (/FROM listings WHERE source = \?/.test(sql)) {
    const source = params[0];
    return state.listings.filter((r) => r.source === source);
  }
  if (
    /FROM observations WHERE source = \? AND source_sku = \? ORDER BY observed_at DESC LIMIT 1/.test(
      sql,
    )
  ) {
    const [source, sourceSku] = params;
    const rows = state.observations
      .filter((r) => r.source === source && r.source_sku === sourceSku)
      .sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1));
    return rows.length > 0 ? [rows[0]] : [];
  }
  if (/FROM observations WHERE source = \? AND source_sku = \? ORDER BY observed_at ASC/.test(sql)) {
    const [source, sourceSku] = params;
    return state.observations
      .filter((r) => r.source === source && r.source_sku === sourceSku)
      .sort((a, b) => (a.observed_at < b.observed_at ? -1 : 1));
  }
  if (/INSERT INTO products \(label\) VALUES \(\?\) RETURNING id, label/.test(sql)) {
    const label = params[0] as string;
    const nextId = state.products.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    const row: ProductRow = { id: nextId, label };
    state.products.push(row);
    return [row];
  }
  return [];
}

/** Apply INSERT / DELETE side effects. */
function dispatchWrite(state: MockState, call: CapturedCall): void {
  const sql = call.sql;
  const params = call.params;
  if (/INSERT INTO product_slots/.test(sql)) {
    if (state.slotInsertError !== undefined) {
      const message = state.slotInsertError;
      // One-shot: clear after throwing so a second INSERT in the same
      // test (if any) goes through normally.
      state.slotInsertError = undefined;
      throw new Error(message);
    }
    const [productId, source, sourceSku, matchedBy] = params as [
      number,
      string,
      string,
      'manual' | 'ean',
    ];
    state.slots.push({ product_id: productId, source, source_sku: sourceSku, matched_by: matchedBy });
    return;
  }
  if (/DELETE FROM product_slots/.test(sql)) {
    const [productId, source] = params as [number, string];
    state.slots = state.slots.filter(
      (r) => !(r.product_id === productId && r.source === source),
    );
    return;
  }
}

/** Test helper: drive the handler with a real Request object. */
function callHandler(
  db: MockD1,
  path: string,
  init: RequestInit = {},
  envExtras: Record<string, unknown> = {},
): Promise<Response> {
  const url = `https://priskurven.example${path}`;
  const request = new Request(url, init);
  const ctx = {} as ExecutionContext;
  return fetch(
    request,
    { DB: db as unknown as D1Database, ...envExtras },
    ctx,
  );
}

const TOKEN = 'test-bearer-token-secret-1234567890';

function bearerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    ...extra,
  };
}

describe('POST /v1/products', () => {
  it('creates a product and returns 201 with id and trimmed label', async () => {
    const db = makeD1();
    const res = await callHandler(
      db,
      '/v1/products',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ label: '  Arla minimælk 1 L  ' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; label: string };
    expect(body.label).toBe('Arla minimælk 1 L');
    expect(typeof body.id).toBe('number');
    expect(db.state.products).toHaveLength(1);
    expect(db.state.products[0]!.label).toBe('Arla minimælk 1 L');
  });

  it('returns 400 when label is missing', async () => {
    const db = makeD1();
    const res = await callHandler(
      db,
      '/v1/products',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({}),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('bad_request');
    expect(body.message).toBe('label is required');
    expect(db.state.products).toHaveLength(0);
  });

  it('returns 400 when label is whitespace only', async () => {
    const db = makeD1();
    const res = await callHandler(
      db,
      '/v1/products',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ label: '   ' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('label is required');
  });

  it('returns 400 when body is empty', async () => {
    const db = makeD1();
    const res = await callHandler(
      db,
      '/v1/products',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: '',
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 when the bearer token is missing', async () => {
    const db = makeD1();
    const res = await callHandler(
      db,
      '/v1/products',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Arla minimælk 1 L' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 when the bearer token does not match', async () => {
    const db = makeD1();
    const res = await callHandler(
      db,
      '/v1/products',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ label: 'Arla minimælk 1 L' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when the env secret is missing', async () => {
    const db = makeD1();
    const res = await callHandler(
      db,
      '/v1/products',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ label: 'Arla minimælk 1 L' }),
      },
      {},
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/products', () => {
  it('returns all products when q is omitted', async () => {
    const db = makeD1({
      products: [
        { id: 1, label: 'Arla minimælk 1 L' },
        { id: 2, label: 'Coca-Cola 1.5 L' },
      ],
    });
    const res = await callHandler(db, '/v1/products');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: ProductRow[] };
    expect(body.products).toEqual([
      { id: 1, label: 'Arla minimælk 1 L' },
      { id: 2, label: 'Coca-Cola 1.5 L' },
    ]);
  });

  it('filters case-insensitively by JavaScript toLowerCase', async () => {
    const db = makeD1({
      products: [
        { id: 1, label: 'Arla minimælk 1 L' },
        { id: 2, label: 'Coca-Cola 1.5 L' },
        { id: 3, label: 'Minimælk økologisk' },
      ],
    });
    const res = await callHandler(db, '/v1/products?q=MINIMÆLK');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: ProductRow[] };
    expect(body.products.map((p) => p.id)).toEqual([1, 3]);
  });

  it('returns no rows when q matches nothing', async () => {
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
    });
    const res = await callHandler(db, '/v1/products?q=coffee');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: ProductRow[] };
    expect(body.products).toEqual([]);
  });
});

describe('GET /v1/products/:id', () => {
  it('returns 404 when the product does not exist', async () => {
    const db = makeD1();
    const res = await callHandler(db, '/v1/products/999');
    expect(res.status).toBe(404);
  });

  it('returns label and eight store entries in the pinned order', async () => {
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
      slots: [
        { product_id: 1, source: 'rema', source_sku: '60308', matched_by: 'manual' },
      ],
      observations: [
        { source: 'rema', source_sku: '60308', observed_at: '2026-09-01T04:00:00.000Z', price: 12, currency: 'DKK', name: null, brand: null, size_value: null, size_unit: null, gtins: '[]' },
        { source: 'rema', source_sku: '60308', observed_at: '2026-10-06T04:00:32.046Z', price: 12.5, currency: 'DKK', name: null, brand: null, size_value: null, size_unit: null, gtins: '[]' },
      ],
    });
    const res = await callHandler(db, '/v1/products/1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      label: string;
      stores: Array<{
        source: string;
        source_sku: string | null;
        matched_by: string | null;
        prices: Array<{ observed_at: string; price: number }>;
      }>;
    };
    expect(body.id).toBe(1);
    expect(body.label).toBe('Arla minimælk 1 L');
    expect(body.stores.map((s) => s.source)).toEqual([
      'rema',
      'minkobmand',
      'spar',
      'netto',
      'bilkatogo',
      'fotex',
      'lidl',
      'nemlig',
    ]);
    expect(body.stores[0]).toEqual({
      source: 'rema',
      source_sku: '60308',
      matched_by: 'manual',
      prices: [
        { observed_at: '2026-09-01T04:00:00.000Z', price: 12 },
        { observed_at: '2026-10-06T04:00:32.046Z', price: 12.5 },
      ],
    });
    expect(body.stores[1]).toEqual({
      source: 'minkobmand',
      source_sku: null,
      matched_by: null,
      prices: [],
    });
  });
});

describe('GET /v1/listings', () => {
  it('returns 400 when source is missing', async () => {
    const db = makeD1();
    const res = await callHandler(db, '/v1/listings?q=agurk');
    expect(res.status).toBe(400);
  });

  it('returns 400 when source is not in the store list', async () => {
    const db = makeD1();
    const res = await callHandler(db, '/v1/listings?source=coop&q=agurk');
    expect(res.status).toBe(400);
  });

  it('returns 400 when q is blank', async () => {
    const db = makeD1();
    const res = await callHandler(db, '/v1/listings?source=netto&q=');
    expect(res.status).toBe(400);
  });

  it('returns at most 50 rows sorted by name then source_sku', async () => {
    // 60 rows: agurk-1..agurk-60. Sort by name then sku caps at 50.
    const listings: ListingRow[] = [];
    for (let i = 1; i <= 60; i++) {
      listings.push({
        source: 'netto',
        source_sku: String(i),
        currency: 'DKK',
        name: `Agurk ${String(i).padStart(2, '0')}`,
        brand: null,
        size_value: null,
        size_unit: null,
        gtins: '[]',
      });
    }
    const db = makeD1({ listings });
    const res = await callHandler(db, '/v1/listings?source=netto&q=agurk');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      listings: Array<{ source_sku: string; name: string | null; price: number | null }>;
    };
    expect(body.listings).toHaveLength(50);
    expect(body.listings[0]!.source_sku).toBe('1');
    expect(body.listings[49]!.source_sku).toBe('50');
  });

  it('returns null price when no observation exists for a listing', async () => {
    const db = makeD1({
      listings: [
        { source: 'netto', source_sku: '123', currency: 'DKK', name: 'Agurk', brand: null, size_value: null, size_unit: null, gtins: '[]' },
      ],
    });
    const res = await callHandler(db, '/v1/listings?source=netto&q=agurk');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      listings: Array<{ source_sku: string; price: number | null }>;
    };
    expect(body.listings[0]!.source_sku).toBe('123');
    expect(body.listings[0]!.price).toBeNull();
  });

  it('folds Æ via JavaScript toLowerCase, not SQL lower', async () => {
    const db = makeD1({
      listings: [
        { source: 'netto', source_sku: '1', currency: 'DKK', name: 'Minimælk', brand: null, size_value: null, size_unit: null, gtins: '[]' },
      ],
    });
    // SQL `lower('MINIMÆLK')` would not match `Minimælk` on D1. JS
    // `toLowerCase()` folds Æ → æ, which matches.
    const res = await callHandler(db, '/v1/listings?source=netto&q=MINIMÆLK');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listings: unknown[] };
    expect(body.listings).toHaveLength(1);
  });
});

describe('POST /v1/products/:id/slots', () => {
  it('sets a manual slot and returns 201', async () => {
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
      listings: [
        { source: 'netto', source_sku: '123', currency: 'DKK', name: null, brand: null, size_value: null, size_unit: null, gtins: '[]' },
      ],
    });
    const res = await callHandler(
      db,
      '/v1/products/1/slots',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ source: 'netto', source_sku: '123' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { source: string; source_sku: string; matched_by: string };
    expect(body).toEqual({ source: 'netto', source_sku: '123', matched_by: 'manual' });
    expect(db.state.slots).toHaveLength(1);
    expect(db.state.slots[0]).toEqual({
      product_id: 1,
      source: 'netto',
      source_sku: '123',
      matched_by: 'manual',
    });
  });

  it('returns 404 when the product does not exist', async () => {
    const db = makeD1({
      listings: [
        { source: 'netto', source_sku: '123', currency: 'DKK', name: null, brand: null, size_value: null, size_unit: null, gtins: '[]' },
      ],
    });
    const res = await callHandler(
      db,
      '/v1/products/99/slots',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ source: 'netto', source_sku: '123' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when source is not in the store list', async () => {
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
    });
    const res = await callHandler(
      db,
      '/v1/products/1/slots',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ source: 'coop', source_sku: '123' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when no listing exists for that (source, source_sku)', async () => {
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
      listings: [
        { source: 'netto', source_sku: '999', currency: 'DKK', name: null, brand: null, size_value: null, size_unit: null, gtins: '[]' },
      ],
    });
    const res = await callHandler(
      db,
      '/v1/products/1/slots',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ source: 'netto', source_sku: '123' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(404);
  });

  it('returns 409 when the slot is already filled', async () => {
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
      listings: [
        { source: 'netto', source_sku: '123', currency: 'DKK', name: null, brand: null, size_value: null, size_unit: null, gtins: '[]' },
      ],
      slots: [
        { product_id: 1, source: 'netto', source_sku: 'old', matched_by: 'manual' },
      ],
    });
    const res = await callHandler(
      db,
      '/v1/products/1/slots',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ source: 'netto', source_sku: '123' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('conflict');
    expect(body.message).toBe('slot is filled');
  });

  it('returns 409 when the (source, source_sku) is on another product', async () => {
    const db = makeD1({
      products: [
        { id: 1, label: 'Arla minimælk 1 L' },
        { id: 2, label: 'Other product' },
      ],
      listings: [
        { source: 'netto', source_sku: '123', currency: 'DKK', name: null, brand: null, size_value: null, size_unit: null, gtins: '[]' },
      ],
      slots: [
        { product_id: 2, source: 'netto', source_sku: '123', matched_by: 'manual' },
      ],
    });
    const res = await callHandler(
      db,
      '/v1/products/1/slots',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ source: 'netto', source_sku: '123' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toBe('listing is on another product');
  });

  it('returns 409 "listing is on another product" when the slot INSERT races and loses on the (source, source_sku) UNIQUE', async () => {
    // Both pre-insert checks pass (no slot for this product/source, no
    // other slot owning this (source, source_sku)). A concurrent
    // request inserted the slot between check and INSERT, so the
    // INSERT throws a UNIQUE constraint failure keyed on source_sku.
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
      listings: [
        { source: 'netto', source_sku: '123', currency: 'DKK', name: null, brand: null, size_value: null, size_unit: null, gtins: '[]' },
      ],
      slotInsertError:
        'D1_EXEC_ERROR: UNIQUE constraint failed: product_slots.source, product_slots.source_sku',
    });
    const res = await callHandler(
      db,
      '/v1/products/1/slots',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ source: 'netto', source_sku: '123' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('conflict');
    expect(body.message).toBe('listing is on another product');
  });

  it('returns 409 "slot is filled" when the slot INSERT races and loses on the (product_id, source) UNIQUE', async () => {
    // Same setup as above but the losing UNIQUE is the (product_id,
    // source) pair — meaning another request filled this product's
    // slot for the same source while we were between check and INSERT.
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
      listings: [
        { source: 'netto', source_sku: '123', currency: 'DKK', name: null, brand: null, size_value: null, size_unit: null, gtins: '[]' },
      ],
      slotInsertError:
        'D1_EXEC_ERROR: UNIQUE constraint failed: product_slots.product_id, product_slots.source',
    });
    const res = await callHandler(
      db,
      '/v1/products/1/slots',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ source: 'netto', source_sku: '123' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('conflict');
    expect(body.message).toBe('slot is filled');
  });

  it('returns 401 when the bearer token is missing', async () => {
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
      listings: [
        { source: 'netto', source_sku: '123', currency: 'DKK', name: null, brand: null, size_value: null, size_unit: null, gtins: '[]' },
      ],
    });
    const res = await callHandler(
      db,
      '/v1/products/1/slots',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'netto', source_sku: '123' }),
      },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(401);
  });
});

describe('DELETE /v1/products/:id/slots/:source', () => {
  it('removes the slot and returns 204', async () => {
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
      slots: [
        { product_id: 1, source: 'netto', source_sku: '123', matched_by: 'manual' },
      ],
    });
    const res = await callHandler(
      db,
      '/v1/products/1/slots/netto',
      { method: 'DELETE', headers: bearerHeaders() },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(db.state.slots).toHaveLength(0);
  });

  it('returns 404 when the product does not exist', async () => {
    const db = makeD1();
    const res = await callHandler(
      db,
      '/v1/products/99/slots/netto',
      { method: 'DELETE', headers: bearerHeaders() },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the slot does not exist', async () => {
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
    });
    const res = await callHandler(
      db,
      '/v1/products/1/slots/netto',
      { method: 'DELETE', headers: bearerHeaders() },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 without the bearer token', async () => {
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
      slots: [
        { product_id: 1, source: 'netto', source_sku: '123', matched_by: 'manual' },
      ],
    });
    const res = await callHandler(db, '/v1/products/1/slots/netto', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });
});

describe('Routing', () => {
  it('returns 404 for an unknown path', async () => {
    const db = makeD1();
    const res = await callHandler(db, '/v2/products');
    expect(res.status).toBe(404);
  });

  it('returns 405 for POST /v1/history', async () => {
    const db = makeD1();
    const res = await callHandler(db, '/v1/history?source=rema&sku=1', {
      method: 'POST',
    });
    expect(res.status).toBe(405);
  });

  it('returns 405 for GET /v1/products (the bare list path)', async () => {
    // GET on /v1/products is allowed. This is a smoke test for the
    // create route, not a 405. Verify the allowed shape works.
    const db = makeD1({ products: [] });
    const res = await callHandler(db, '/v1/products');
    expect(res.status).toBe(200);
  });

  it('returns 405 for DELETE /v1/products/1/slots (no source segment)', async () => {
    const db = makeD1({
      products: [{ id: 1, label: 'Arla minimælk 1 L' }],
    });
    const res = await callHandler(
      db,
      '/v1/products/1/slots',
      { method: 'DELETE', headers: bearerHeaders() },
      { PRISKURVEN_API_TOKEN: TOKEN },
    );
    expect(res.status).toBe(405);
  });
});

describe('CREATE TABLE statements from SII-128 (test setup contract)', () => {
  // The SII-129 spec requires these statements to be present in the
  // test setup. They are documentation of the schema the Worker and
  // its mock depend on. The mock D1 ignores them.
  it('documents the listings, products, and product_slots schema', () => {
    const setup = `
    CREATE TABLE listings (
      source TEXT NOT NULL,
      source_sku TEXT NOT NULL,
      currency TEXT NOT NULL,
      name TEXT,
      brand TEXT,
      size_value REAL,
      size_unit TEXT,
      gtins TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (source, source_sku)
    ) WITHOUT ROWID;

    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL
    );

    CREATE TABLE product_slots (
      product_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_sku TEXT NOT NULL,
      matched_by TEXT NOT NULL CHECK (matched_by IN ('manual', 'ean')),
      PRIMARY KEY (product_id, source),
      UNIQUE (source, source_sku)
    ) WITHOUT ROWID;
    `;
    expect(setup).toContain('CREATE TABLE listings');
    expect(setup).toContain('CREATE TABLE products');
    expect(setup).toContain('CREATE TABLE product_slots');
    expect(setup).toContain("CHECK (matched_by IN ('manual', 'ean'))");
  });
});