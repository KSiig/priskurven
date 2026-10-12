/**
 * SII-141 approval queue tests.
 *
 * The module under test is `backoffice/src/approval.ts`. These
 * tests drive the public surface of that file plus the wiring
 * into the SII-137 dispatch chain in `backoffice/src/index.ts`.
 *
 * Coverage (per the SII-141 spec):
 *   1. A rema sku on `product_slots` is absent from the queue.
 *      A sku on `review_skips` is absent. An unslotted, unskipped
 *      sku is present.
 *   2. With 21 unslotted, unskipped skus, the queue page renders
 *      20 rows and the last row (by `name, source_sku`) is
 *      dropped.
 *   3. Approve with a blank label returns 200 HTML containing
 *      "label is required" and never calls `fetch`.
 *   4. Approve with a valid label calls `POST /v1/products` and
 *      then `POST /v1/products/<id>/slots` in that order. The slot
 *      body is `{ source, source_sku }` only — no `matched_by`
 *      (the public API fills that in).
 *   5. Create returns 201 and setSlot returns 409 with the
 *      "listing is on another product" message. The HTML contains
 *      the new product id and the upstream message.
 *   6. Skip prepares `INSERT OR REPLACE INTO review_skips` and
 *      303s to `/approval`.
 *   7. `GET /approval` through `fetch` from `backoffice/src/index.ts`
 *      with a `ctx` that has no `access` returns 403.
 *
 * Mocks for `globalThis.fetch` and the D1 binding live in this
 * file. No cross-file imports of fixtures.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  D1Database,
  D1PreparedStatement,
  ExecutionContext,
} from "@cloudflare/workers-types";

import { handleApproval } from "../../backoffice/src/approval";
import { fetch as workerFetch } from "../../backoffice/src/index";

/* ---------------------------------------------------------------- *
 * Shared types — mirror the tables from the SII-128 / SII-136      *
 * migrations that this module reads from.                          *
 * ---------------------------------------------------------------- */

/** `listings` row (SII-128). */
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

/** `product_slots` row (SII-128). */
type SlotRow = {
  product_id: number;
  source: string;
  source_sku: string;
  matched_by: "manual" | "ean";
};

/** `review_skips` row (SII-136). */
type SkipRow = {
  source: string;
  source_sku: string;
  skipped_at: string;
};

/** `observations` row (SII-118 / SII-130). Only `price` is read
 *  by this module; the rest is captured to keep the mock honest. */
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

/* ---------------------------------------------------------------- *
 * D1 mock                                                          *
 * ---------------------------------------------------------------- */

/** A captured call to `env.DB.prepare(...).bind(...).run() / .all() /
 *  .first()`. We only inspect the SQL string and the bound params. */
interface CapturedCall {
  sql: string;
  params: unknown[];
  kind: "all" | "first" | "run";
}

/** Mutable state the mock D1 reads and writes. */
interface MockD1State {
  listings: ListingRow[];
  slots: SlotRow[];
  skips: SkipRow[];
  observations: ObservationRow[];
  calls: CapturedCall[];
}

/** Minimal mock D1 binding. Only the methods this module uses are
 *  implemented; the rest of the surface is left `as unknown` so
 *  the type system does not need to know. */
interface MockD1 {
  state: MockD1State;
  prepare(query: string): D1PreparedStatement;
}

/** Build a fresh mock D1. The test seeds the tables it wants the
 *  module to see; the mock then dispatches on the SQL prefix and
 *  the bound params to shape the response. */
function makeD1(initial: Partial<MockD1State> = {}): MockD1 {
  const state: MockD1State = {
    listings: initial.listings ? [...initial.listings] : [],
    slots: initial.slots ? [...initial.slots] : [],
    skips: initial.skips ? [...initial.skips] : [],
    observations: initial.observations ? [...initial.observations] : [],
    calls: [],
  };
  const db: MockD1 = {
    state,
    prepare(query: string) {
      const captured: CapturedCall = {
        sql: query.trim(),
        params: [],
        kind: "all",
      };
      const stmt: D1PreparedStatement = {
        bind(...values: unknown[]): D1PreparedStatement {
          captured.params = values;
          return stmt;
        },
        async all<T = unknown>(): Promise<{ results?: T[] }> {
          captured.kind = "all";
          state.calls.push(captured);
          return { results: dispatchAll(state, captured) as T[] };
        },
        async first<T = unknown>(): Promise<T | null> {
          captured.kind = "first";
          state.calls.push(captured);
          return dispatchFirst(state, captured) as T | null;
        },
        async run(): Promise<{ success: boolean }> {
          captured.kind = "run";
          state.calls.push(captured);
          dispatchRun(state, captured);
          return { success: true };
        },
        async raw<T = unknown>(): Promise<T[]> {
          return [] as T[];
        },
      } as unknown as D1PreparedStatement;
      return stmt;
    },
  };
  return db;
}

/** Pick the queue rows. Mirrors the spec's NOT EXISTS filters. */
function dispatchAll(
  state: MockD1State,
  call: CapturedCall,
): unknown[] {
  const sql = call.sql;
  if (sql.includes("FROM listings")) {
    const source = call.params[0] as string;
    return state.listings
      .filter((l) => l.source === source)
      .filter((l) =>
        !state.slots.some((s) =>
          s.source === l.source && s.source_sku === l.source_sku
        )
      )
      .filter((l) =>
        !state.skips.some((k) =>
          k.source === l.source && k.source_sku === l.source_sku
        )
      )
      .map((l) => ({
        source_sku: l.source_sku,
        name: l.name,
        brand: l.brand,
        size_value: l.size_value,
        size_unit: l.size_unit,
      }))
      .sort((a, b) => {
        const an = a.name ?? "";
        const bn = b.name ?? "";
        if (an !== bn) {
          return an < bn ? -1 : 1;
        }
        return a.source_sku < b.source_sku ? -1 : 1;
      })
      .slice(0, call.params[1] as number);
  }
  if (sql.includes("FROM review_skips")) {
    const source = call.params[0] as string;
    return state.skips
      .filter((k) => k.source === source)
      .map((k) => ({ source_sku: k.source_sku, skipped_at: k.skipped_at }))
      .sort((a, b) => a.source_sku < b.source_sku ? -1 : 1);
  }
  return [];
}

/** Pick the latest price for one sku, or null when there is none. */
function dispatchFirst(
  state: MockD1State,
  call: CapturedCall,
): unknown {
  const sql = call.sql;
  if (sql.includes("FROM observations")) {
    const source = call.params[0] as string;
    const sourceSku = call.params[1] as string;
    const candidates = state.observations
      .filter((o) => o.source === source && o.source_sku === sourceSku)
      .sort((a, b) => a.observed_at < b.observed_at ? 1 : -1);
    if (candidates.length === 0) {
      return null;
    }
    return { price: candidates[0]?.price ?? null };
  }
  return null;
}

/** Apply a write. The mock does not enforce constraints; it just
 *  captures the call so the test can assert the SQL. */
function dispatchRun(
  state: MockD1State,
  call: CapturedCall,
): void {
  const sql = call.sql;
  if (sql.includes("INSERT OR REPLACE INTO review_skips")) {
    const source = call.params[0] as string;
    const sourceSku = call.params[1] as string;
    const skippedAt = call.params[2] as string;
    const existing = state.skips.findIndex((k) =>
      k.source === source && k.source_sku === sourceSku
    );
    if (existing >= 0) {
      state.skips[existing] = { source, source_sku: sourceSku, skipped_at: skippedAt };
    } else {
      state.skips.push({ source, source_sku: sourceSku, skipped_at: skippedAt });
    }
    return;
  }
  if (sql.includes("DELETE FROM review_skips")) {
    const source = call.params[0] as string;
    const sourceSku = call.params[1] as string;
    state.skips = state.skips.filter((k) =>
      !(k.source === source && k.source_sku === sourceSku)
    );
    return;
  }
  // Unknown write — the test will assert on the SQL string, so
  // we just record the call.
}

/* ---------------------------------------------------------------- *
 * fetch mock                                                       *
 * ---------------------------------------------------------------- */

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

/**
 * Install a fresh `globalThis.fetch` mock for one test. The mock
 * routes on URL prefix and returns whatever the test programmed.
 * `restore()` undoes the mock.
 */
function mockFetch(
  responder: (url: string, init: RequestInit) => Promise<Response>,
): { read: () => CapturedFetch[]; restore: () => void } {
  const captured: CapturedFetch[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const safeInit: RequestInit = init ?? {};
    captured.push({ url, init: safeInit });
    return responder(url, safeInit);
  }) as typeof fetch;
  return {
    read: () => captured,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Build a JSON response with the right content-type. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* ---------------------------------------------------------------- *
 * Test helpers                                                     *
 * ---------------------------------------------------------------- */

/** A listings row factory that supplies the bare minimum. */
function listing(
  sourceSku: string,
  partial: Partial<ListingRow> = {},
): ListingRow {
  return {
    source: "rema",
    source_sku: sourceSku,
    currency: "DKK",
    name: `Listing ${sourceSku}`,
    brand: null,
    size_value: null,
    size_unit: null,
    gtins: "[]",
    ...partial,
  };
}

/** Run `GET /approval` through the module under test. */
function callGetQueue(
  env: Env,
): Promise<Response> {
  return handleApproval(
    new Request("https://backoffice.priskurven.example/approval"),
    env,
  );
}

/** Run `POST /approval/approve` with a form body. */
function callPostApprove(
  env: Env,
  body: Record<string, string>,
): Promise<Response> {
  const form = new URLSearchParams(body);
  return handleApproval(
    new Request("https://backoffice.priskurven.example/approval/approve", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    env,
  );
}

/** Run `POST /approval/skip` with a form body. */
function callPostSkip(
  env: Env,
  sourceSku: string,
): Promise<Response> {
  return handleApproval(
    new Request("https://backoffice.priskurven.example/approval/skip", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ source_sku: sourceSku }).toString(),
    }),
    env,
  );
}

/** Env shape used by the backoffice Worker. */
type Env = { DB: D1Database; PRISKURVEN_API_TOKEN?: string };

/** Wrap the mock D1 into an `Env`. */
function envWith(d1: MockD1, token: string | undefined = "test-token"): Env {
  return { DB: d1 as unknown as D1Database, PRISKURVEN_API_TOKEN: token };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------- *
 * Test cases                                                       *
 * ---------------------------------------------------------------- */

describe("backoffice approval queue", () => {
  it("hides listings that are already slotted or skipped", async () => {
    const d1 = makeD1({
      listings: [
        listing("S1", { name: "Alpha" }),
        listing("S2", { name: "Bravo" }),
        listing("S3", { name: "Charlie" }),
      ],
      slots: [
        {
          product_id: 100,
          source: "rema",
          source_sku: "S1",
          matched_by: "manual",
        },
      ],
      skips: [
        { source: "rema", source_sku: "S2", skipped_at: "2026-10-12T00:00:00Z" },
      ],
    });
    const env = envWith(d1);
    const res = await callGetQueue(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    // S1 is in product_slots; absent.
    expect(body).not.toContain('value="S1"');
    // S2 is in review_skips; absent.
    expect(body).not.toContain('value="S2"');
    // S3 is the only unslotted, unskipped row; present.
    expect(body).toContain('value="S3"');
    expect(body).toContain("Charlie");
  });

  it("renders 20 rows and drops the lexicographically last when 21 are eligible", async () => {
    const listings: ListingRow[] = [];
    // 21 rows, with the last (by name, then source_sku) being
    // "Listing Z9" so it sorts last in `ORDER BY name, source_sku`.
    for (let i = 1; i <= 20; i++) {
      listings.push(listing(`S${i}`, { name: `Listing A${i}` }));
    }
    listings.push(listing("S21", { name: "Listing Z9" }));
    const d1 = makeD1({ listings });
    const env = envWith(d1);
    const res = await callGetQueue(env);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The dropped row is absent.
    expect(body).not.toContain("Listing Z9");
    expect(body).not.toContain('value="S21"');
    // The other 20 rows are present.
    for (let i = 1; i <= 20; i++) {
      expect(body).toContain(`Listing A${i}`);
    }
    // Two `<form>` elements per row (Approve + Skip).
    const formCount = (body.match(/<form /g) ?? []).length;
    expect(formCount).toBe(40);
  });

  it("approve with a blank label returns label is required and never calls fetch", async () => {
    const d1 = makeD1();
    const env = envWith(d1);
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const res = await callPostApprove(env, {
        source_sku: "S1",
        label: "   ",
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("label is required");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("approve calls POST /v1/products then POST /v1/products/<id>/slots with source and source_sku only", async () => {
    const d1 = makeD1();
    const env = envWith(d1, "bearer-token");
    const { read, restore } = mockFetch(async (url, init) => {
      if (url === "https://priskurven.siig.tech/v1/products") {
        return jsonResponse(201, { id: 42, label: "Mælk 1L" });
      }
      if (url === "https://priskurven.siig.tech/v1/products/42/slots") {
        return jsonResponse(201, {
          source: "rema",
          source_sku: "S1",
          matched_by: "manual",
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    try {
      const res = await callPostApprove(env, {
        source_sku: "S1",
        label: "Mælk 1L",
      });
      // Both calls succeeded → 303 to /approval.
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/approval");
      const calls = read();
      expect(calls).toHaveLength(2);
      // 1. POST /v1/products with { label }.
      const createCall = calls[0]!;
      expect(createCall.url).toBe("https://priskurven.siig.tech/v1/products");
      expect(createCall.init.method).toBe("POST");
      const createHeaders = new Headers(createCall.init.headers ?? {});
      expect(createHeaders.get("authorization")).toBe("Bearer bearer-token");
      expect(createCall.init.body).toBe(JSON.stringify({ label: "Mælk 1L" }));
      // 2. POST /v1/products/42/slots with { source, source_sku }.
      const slotCall = calls[1]!;
      expect(slotCall.url).toBe(
        "https://priskurven.siig.tech/v1/products/42/slots",
      );
      expect(slotCall.init.method).toBe("POST");
      const slotBody = JSON.parse(slotCall.init.body as string) as Record<
        string,
        unknown
      >;
      expect(slotBody).toEqual({ source: "rema", source_sku: "S1" });
      // matched_by is NOT sent by the page.
      expect("matched_by" in slotBody).toBe(false);
    } finally {
      restore();
    }
  });

  it("approve with a slot conflict shows the new id and the upstream message", async () => {
    const d1 = makeD1();
    const env = envWith(d1);
    const { read, restore } = mockFetch(async (url) => {
      if (url === "https://priskurven.siig.tech/v1/products") {
        return jsonResponse(201, { id: 7, label: "Mælk 1L" });
      }
      if (url === "https://priskurven.siig.tech/v1/products/7/slots") {
        return jsonResponse(409, {
          error: "conflict",
          message: "listing is on another product",
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    try {
      const res = await callPostApprove(env, {
        source_sku: "S1",
        label: "Mælk 1L",
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("7");
      expect(body).toContain("listing is on another product");
      // The new id links to the product page so the user can fix
      // the slot by hand.
      expect(body).toContain('href="/products/7"');
      // Both calls were issued in order.
      const calls = read();
      expect(calls).toHaveLength(2);
      expect(calls[0]!.url).toBe("https://priskurven.siig.tech/v1/products");
      expect(calls[1]!.url).toBe(
        "https://priskurven.siig.tech/v1/products/7/slots",
      );
    } finally {
      restore();
    }
  });

  it("skip prepares INSERT OR REPLACE into review_skips and 303s to /approval", async () => {
    const d1 = makeD1();
    const env = envWith(d1);
    const res = await callPostSkip(env, "S42");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/approval");
    // Exactly one write was issued.
    const writes = d1.state.calls.filter((c) => c.kind === "run");
    expect(writes).toHaveLength(1);
    const call = writes[0]!;
    expect(call.sql).toContain("INSERT OR REPLACE INTO review_skips");
    expect(call.params[0]).toBe("rema");
    expect(call.params[1]).toBe("S42");
    // The timestamp is an ISO string; we don't pin the exact
    // value, only the shape.
    expect(typeof call.params[2]).toBe("string");
    expect((call.params[2] as string)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    // The skip row landed in the mock state.
    expect(d1.state.skips).toEqual([
      {
        source: "rema",
        source_sku: "S42",
        skipped_at: call.params[2] as string,
      },
    ]);
  });

  it("GET /approval through the Worker fetch with no access returns 403", async () => {
    const d1 = makeD1();
    const env = envWith(d1);
    const ctx = {} as ExecutionContext;
    const request = new Request(
      "https://backoffice.priskurven.example/approval",
    );
    const res = await workerFetch(request, env, ctx);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("access_required");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    // The Access check short-circuited before the approval module
    // ran — no D1 call should have been made.
    expect(d1.state.calls).toHaveLength(0);
  });
});
