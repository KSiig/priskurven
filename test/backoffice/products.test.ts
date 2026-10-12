/**
 * SII-138 backoffice product page tests.
 *
 * The page is `backoffice/src/products.ts`. These tests cover the
 * six behaviours the SII-138 spec enumerates:
 *
 *   1. A listing named `MINIMÆLK` is shown for `q=minimælk` — the
 *      JavaScript `toLowerCase()` fold matches the public API, even
 *      though D1's SQL `lower()` would not.
 *   2. A product with eight empty stores renders all eight source
 *      names, in the SII-129 order.
 *   3. A filled `rema` slot renders its `source_sku` and `manual`.
 *   4. Attach posts to `/v1/products/<id>/slots` with the bearer
 *      header.
 *   5. A 409 body `{ error: "conflict", message: "listing is on
 *      another product" }` is rendered, and a separate case renders
 *      `slot is filled`.
 *   6. `GET /products/1` through `fetch` from `index.ts` with a
 *      `ctx` that has no `access` returns 403.
 *
 * The D1 stand-in and the fetch mock live in this file. We do not
 * import the mocks from `test/products.test.ts` or
 * `test/history.test.ts` — every test file owns its own fixtures.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  D1Database,
  D1PreparedStatement,
  ExecutionContext,
} from "@cloudflare/workers-types";

import { handleProducts } from "../../backoffice/src/products";
import { fetch as indexFetch } from "../../backoffice/src/index";

/* ------------------------------------------------------------------ *
 * D1 stand-in
 * ------------------------------------------------------------------ */

interface ListingRow {
  source: string;
  source_sku: string;
  name: string | null;
  brand: string | null;
  size_value: number | null;
  size_unit: string | null;
}

interface ObservationRow {
  source: string;
  source_sku: string;
  observed_at: string;
  price: number;
}

interface MockState {
  listings: ListingRow[];
  observations: ObservationRow[];
  /** Recorded calls (for assertion). */
  calls: Array<{ sql: string; params: unknown[] }>;
}

interface MockD1 {
  state: MockState;
  prepare(query: string): D1PreparedStatement;
}

function makeD1(initial: Partial<MockState> = {}): MockD1 {
  const state: MockState = {
    listings: initial.listings ? [...initial.listings] : [],
    observations: initial.observations ? [...initial.observations] : [],
    calls: [],
  };
  const db: MockD1 = {
    state,
    prepare(query: string) {
      const captured = { sql: query.trim(), params: [] as unknown[] };
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
          return { success: true };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
  return db;
}

function dispatchSelect(state: MockState, call: { sql: string; params: unknown[] }): unknown[] {
  const sql = call.sql;
  const params = call.params;

  // observations latest price
  if (
    /FROM observations WHERE source = \? AND source_sku = \? ORDER BY observed_at DESC LIMIT 1/.test(
      sql,
    )
  ) {
    const [source, sourceSku] = params as [string, string];
    const rows = state.observations
      .filter((r) => r.source === source && r.source_sku === sourceSku)
      .sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1))
      .slice(0, 1);
    return rows.map((r) => ({ price: r.price }));
  }
  // listings search (no SQL filter on name)
  if (/FROM listings WHERE source = \?/.test(sql)) {
    const source = params[0];
    return state.listings
      .filter((r) => r.source === source)
      .map((r) => ({
        source_sku: r.source_sku,
        name: r.name,
        brand: r.brand,
        size_value: r.size_value,
        size_unit: r.size_unit,
      }));
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * Fetch mock
 * ------------------------------------------------------------------ */

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

function mockFetch(
  responder: (url: string, init: RequestInit) => Promise<Response>,
): { read: () => CapturedFetch | null; restore: () => void } {
  const handle: { captured: CapturedFetch | null } = { captured: null };
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    handle.captured = { url, init: init ?? {} };
    return responder(url, init ?? {});
  }) as typeof fetch;
  return {
    read: () => handle.captured,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function envWithToken(token = "test-token-abc"): {
  DB: D1Database;
  PRISKURVEN_API_TOKEN: string;
} {
  return { DB: {} as D1Database, PRISKURVEN_API_TOKEN: token };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyProduct(id: number, label: string) {
  return {
    id,
    label,
    stores: [
      { source: "rema", source_sku: null, matched_by: null, prices: [] },
      { source: "minkobmand", source_sku: null, matched_by: null, prices: [] },
      { source: "spar", source_sku: null, matched_by: null, prices: [] },
      { source: "netto", source_sku: null, matched_by: null, prices: [] },
      { source: "bilkatogo", source_sku: null, matched_by: null, prices: [] },
      { source: "fotex", source_sku: null, matched_by: null, prices: [] },
      { source: "lidl", source_sku: null, matched_by: null, prices: [] },
      { source: "nemlig", source_sku: null, matched_by: null, prices: [] },
    ],
  };
}

function filledRemaProduct(id: number, label: string) {
  return {
    id,
    label,
    stores: [
      {
        source: "rema",
        source_sku: "21464",
        matched_by: "manual" as const,
        prices: [{ observed_at: "2026-10-01T00:00:00.000Z", price: 12.5 }],
      },
      { source: "minkobmand", source_sku: null, matched_by: null, prices: [] },
      { source: "spar", source_sku: null, matched_by: null, prices: [] },
      { source: "netto", source_sku: null, matched_by: null, prices: [] },
      { source: "bilkatogo", source_sku: null, matched_by: null, prices: [] },
      { source: "fotex", source_sku: null, matched_by: null, prices: [] },
      { source: "lidl", source_sku: null, matched_by: null, prices: [] },
      { source: "nemlig", source_sku: null, matched_by: null, prices: [] },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe("backoffice products page", () => {
  it("renders a listing named MINIMÆLK for q=minimælk (JS toLowerCase, not SQL lower)", async () => {
    // Mock the public API to return a product with 8 empty stores.
    const listings: ListingRow[] = [
      { source: "rema", source_sku: "sku-1", name: "MINIMÆLK", brand: "Arla", size_value: 1, size_unit: "L" },
    ];
    const db = makeD1({ listings });
    const env = { ...envWithToken(), DB: db as unknown as D1Database };

    const product = emptyProduct(1, "Arla minimælk 1 L");
    const { read: _read, restore } = mockFetch(async (url) => {
      if (url.endsWith("/v1/products/1")) {
        return jsonResponse(200, product);
      }
      throw new Error("unexpected fetch: " + url);
    });
    try {
      // Empty rema slot + q=minimælk → the rema block should render
      // the MINIMÆLK listing match.
      const res = await handleProducts(
        new Request("https://backoffice.priskurven.example/products/1?source=rema&q=minim%C3%A6lk"),
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("MINIMÆLK");
      // The Attach button + the source_sku hidden input.
      expect(body).toContain("sku-1");
      expect(body).toContain("Attach");
    } finally {
      restore();
    }
  });

  it("renders all eight source names in the SII-129 order for an empty product", async () => {
    const product = emptyProduct(1, "Empty product");
    const { restore } = mockFetch(async (url) => {
      if (url.endsWith("/v1/products/1")) {
        return jsonResponse(200, product);
      }
      throw new Error("unexpected fetch: " + url);
    });
    try {
      const res = await handleProducts(
        new Request("https://backoffice.priskurven.example/products/1"),
        envWithToken(),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      // The eight sources, in order.
      const order = ["rema", "minkobmand", "spar", "netto", "bilkatogo", "fotex", "lidl", "nemlig"];
      let cursor = 0;
      for (const source of order) {
        const idx = body.indexOf(`<h3>${source}</h3>`, cursor);
        expect(idx, `source ${source} should appear in order`).toBeGreaterThan(cursor);
        cursor = idx;
      }
    } finally {
      restore();
    }
  });

  it("renders source_sku and matched_by=manual for a filled rema slot", async () => {
    const product = filledRemaProduct(1, "Arla minimælk 1 L");
    const { restore } = mockFetch(async (url) => {
      if (url.endsWith("/v1/products/1")) {
        return jsonResponse(200, product);
      }
      throw new Error("unexpected fetch: " + url);
    });
    try {
      const res = await handleProducts(
        new Request("https://backoffice.priskurven.example/products/1"),
        envWithToken(),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("21464");
      expect(body).toContain("manual");
      // The clear form.
      expect(body).toContain('action="/products/1/slots/clear"');
      expect(body).toContain("Clear");
    } finally {
      restore();
    }
  });

  it("attach posts to /v1/products/<id>/slots with the bearer header", async () => {
    const { read, restore } = mockFetch(async () =>
      jsonResponse(201, { source: "rema", source_sku: "21464", matched_by: "manual" }),
    );
    try {
      const formBody = new URLSearchParams({ source: "rema", source_sku: "21464" }).toString();
      const req = new Request(
        "https://backoffice.priskurven.example/products/1/slots",
        {
          method: "POST",
          body: formBody,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        },
      );
      const res = await handleProducts(req, envWithToken());
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/products/1");
      const captured = read();
      expect(captured).not.toBeNull();
      const { url, init } = captured as CapturedFetch;
      expect(url).toBe("https://priskurven.siig.tech/v1/products/1/slots");
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers ?? {});
      expect(headers.get("authorization")).toBe("Bearer test-token-abc");
      expect(init.body).toBe(JSON.stringify({ source: "rema", source_sku: "21464" }));
    } finally {
      restore();
    }
  });

  it("renders 'listing is on another product' on the 409 conflict", async () => {
    const { restore } = mockFetch(async () =>
      jsonResponse(409, {
        error: "conflict",
        message: "listing is on another product",
      }),
    );
    try {
      const formBody = new URLSearchParams({ source: "rema", source_sku: "21464" }).toString();
      const req = new Request(
        "https://backoffice.priskurven.example/products/1/slots",
        {
          method: "POST",
          body: formBody,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        },
      );
      const res = await handleProducts(req, envWithToken());
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("listing is on another product");
    } finally {
      restore();
    }
  });

  it("renders 'slot is filled' on a separate 409 conflict", async () => {
    const { restore } = mockFetch(async () =>
      jsonResponse(409, {
        error: "conflict",
        message: "slot is filled",
      }),
    );
    try {
      const formBody = new URLSearchParams({ source: "rema", source_sku: "21464" }).toString();
      const req = new Request(
        "https://backoffice.priskurven.example/products/1/slots",
        {
          method: "POST",
          body: formBody,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        },
      );
      const res = await handleProducts(req, envWithToken());
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("slot is filled");
    } finally {
      restore();
    }
  });

  it("returns 403 when the index.ts fetch is called with a ctx that has no access", async () => {
    // This goes through the backoffice Worker entry, not
    // handleProducts directly. A missing `ctx.access` should be
    // caught by the Access gate and 403 returned before the
    // /products branch runs.
    type AccessCtx = ExecutionContext & {
      access?: { getIdentity(): Promise<{ email?: string } | null> };
    };
    const ctx = {} as AccessCtx;
    const env = { DB: {} as D1Database };
    const res = await indexFetch(
      new Request("https://backoffice.priskurven.example/products/1"),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("access_required");
  });
});
