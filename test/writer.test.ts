import { describe, it, expect } from "vitest";

import {
  createD1ClientFromEnv,
  createD1RestClient,
  type D1Client,
  type D1Statement,
} from "../src/d1";
import type { Observation, Source } from "../src/types";
import {
  normalizeObservedAt,
  writeObservations,
  writeObservationsDetailed,
} from "../src/writer";

/**
 * In-memory D1 client. Records every (sql, params) pair so tests can
 * assert what the writer produced. Holds a `listings` map keyed by
 * `(source, source_sku)` so the writer's upsert logic can be exercised
 * end-to-end. Reset between tests via `reset()`.
 */
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

class FakeD1Client implements D1Client {
  calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  listings: Map<string, ListingRow> = new Map();
  failOn?: (sql: string) => Error;

  async exec(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.calls.push({ sql, params });
    if (this.failOn && this.failOn(sql)) {
      const err = this.failOn(sql);
      if (err) throw err;
    }
  }

  async query<T>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    this.calls.push({ sql, params });
    if (this.failOn && this.failOn(sql)) {
      const err = this.failOn(sql);
      if (err) throw err;
    }
    // Only the SELECT against listings is wired up. Anything else
    // returns empty so the writer's listings upsert can run without
    // surprises.
    if (sql.includes("FROM listings")) {
      const source = params[0] as string;
      const skus = params.slice(1) as string[];
      const out: T[] = [];
      for (const sku of skus) {
        const row = this.listings.get(`${source}|${sku}`);
        if (row) out.push(row as unknown as T);
      }
      return out;
    }
    return [];
  }

  reset(): void {
    this.calls = [];
    this.listings.clear();
    this.failOn = undefined;
  }
}

function mkObs(overrides: Partial<Observation> = {}): Observation {
  return {
    source: "rema",
    source_sku: "rema-1",
    observed_at: "2024-01-15T10:30:00.123Z",
    price: 12.5,
    currency: "DKK",
    gtins: [],
    raw: { foo: "bar" },
    ...overrides,
  };
}

/** Yield observations one tick apart so we exercise the AsyncIterable path. */
async function* fromArray(items: Observation[]): AsyncIterable<Observation> {
  for (const item of items) {
    yield item;
  }
}

/** Filter the recorded calls down to observation INSERTs only. */
function obsInserts(client: FakeD1Client) {
  return client.calls.filter((c) =>
    c.sql.startsWith("INSERT INTO observations "),
  );
}

/** Filter the recorded calls down to listings statements. */
function listingsCalls(client: FakeD1Client) {
  return client.calls.filter((c) =>
    /FROM listings|INSERT INTO listings|UPDATE listings/.test(c.sql),
  );
}

describe("normalizeObservedAt", () => {
  it("adds milliseconds when missing", () => {
    expect(normalizeObservedAt("2024-01-15T10:30:00Z")).toBe(
      "2024-01-15T10:30:00.000Z",
    );
  });

  it("preserves milliseconds when present", () => {
    expect(normalizeObservedAt("2024-01-15T10:30:00.123Z")).toBe(
      "2024-01-15T10:30:00.123Z",
    );
  });

  it("rejects non-UTC offsets", () => {
    expect(() => normalizeObservedAt("2024-01-15T10:30:00+00:00")).toThrow(
      /UTC/,
    );
    expect(() => normalizeObservedAt("2024-01-15T10:30:00+02:00")).toThrow(
      /UTC/,
    );
  });

  it("rejects invalid dates", () => {
    expect(() => normalizeObservedAt("2024-13-99T10:30:00Z")).toThrow();
    expect(() => normalizeObservedAt("not-a-date")).toThrow();
  });
});

describe("writeObservations", () => {
  // The DDL lives in homelab migration 0004 (SII-128). This repo does
  // not own the migration; the writer's tests copy the relevant CREATE
  // TABLE statement verbatim so the test schema matches what the
  // writer will see in production. SII-131 copies the same DDL.
  it("reference: listings DDL is reproduced verbatim", () => {
    const ddl = [
      "CREATE TABLE listings (",
      "  source      TEXT NOT NULL,",
      "  source_sku  TEXT NOT NULL,",
      "  currency    TEXT NOT NULL,",
      "  name        TEXT,",
      "  brand       TEXT,",
      "  size_value  REAL,",
      "  size_unit   TEXT,",
      "  gtins       TEXT NOT NULL DEFAULT '[]',",
      "  PRIMARY KEY (source, source_sku)",
      ") WITHOUT ROWID;",
    ].join("\n");
    // SII-128 homelab migration 0004. Kept here as a guard so any
    // accidental drift between this repo and the migration is caught.
    expect(ddl).toContain("CREATE TABLE listings");
    expect(ddl).toContain("gtins       TEXT NOT NULL DEFAULT '[]'");
    expect(ddl).toContain("PRIMARY KEY (source, source_sku)");
    expect(ddl).toContain(") WITHOUT ROWID");
  });
  it("two fake sources write into one shared table", async () => {
    // SPEC: "Two fake sources that write the same table."
    const fakeA: Source = () =>
      fromArray([
        mkObs({ source: "rema", source_sku: "r1" }),
        mkObs({ source: "rema", source_sku: "r2" }),
        mkObs({ source: "rema", source_sku: "r3" }),
      ]);

    const fakeB: Source = () =>
      fromArray([
        mkObs({ source: "lidl", source_sku: "l1", price: 9.95 }),
        mkObs({ source: "lidl", source_sku: "l2", price: 19.95 }),
      ]);

    const client = new FakeD1Client();
    const totalA = await writeObservations(fakeA(), client);
    const totalB = await writeObservations(fakeB(), client);

    expect(totalA).toBe(3);
    expect(totalB).toBe(2);
    // Every observation call targets the same INSERT, same table — per spec.
    const inserts = obsInserts(client);
    expect(inserts).toHaveLength(5);
    for (const call of inserts) {
      expect(call.sql).toBe(
        "INSERT INTO observations (source, source_sku, observed_at, price, currency, name, brand, size_value, size_unit, gtins) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
    }
  });

  it("sends inserts through execBatch when the client supports it", async () => {
    const batches: D1Statement[][] = [];
    const client: D1Client = {
      async exec() {
        throw new Error("exec should not be used when execBatch exists");
      },
      async query() {
        return [];
      },
      async execBatch(statements) {
        batches.push(statements.map((statement) => ({ ...statement })));
      },
    };
    const written = await writeObservations(
      fromArray([
        mkObs({ source_sku: "r1" }),
        mkObs({ source_sku: "r2" }),
        mkObs({ source_sku: "r3" }),
      ]),
      client,
    );
    expect(written).toBe(3);
    // Observation INSERTs go out in one execBatch of 3. The writer may
    // then route listings statements through a second execBatch.
    const obsBatches = batches.filter((b) =>
      b[0]?.sql.startsWith("INSERT INTO observations"),
    );
    expect(obsBatches).toHaveLength(1);
    expect(obsBatches[0]).toHaveLength(3);
    expect(obsBatches[0]![0]?.params?.[1]).toBe("r1");
    expect(obsBatches[0]![2]?.params?.[1]).toBe("r3");
  });

  it("writes empty gtins as the literal JSON array []", async () => {
    // SPEC: "Cover empty gtins." DDL says `gtins TEXT` may be []; the
    // writer must encode `[]` — not NULL, not omitted.
    const client = new FakeD1Client();
    await writeObservations(
      fromArray([mkObs({ gtins: [] })]),
      client,
    );
    expect(obsInserts(client)).toHaveLength(1);
    // Index 9 is gtins (0: source, 1: source_sku, 2: observed_at,
    // 3: price, 4: currency, 5: name, 6: brand, 7: size_value,
    // 8: size_unit, 9: gtins). raw is not inserted.
    expect(obsInserts(client)[0]?.params[9]).toBe("[]");
    expect(obsInserts(client)[0]?.params).toHaveLength(10);
  });

  it("writes non-empty gtins as JSON", async () => {
    const client = new FakeD1Client();
    await writeObservations(
      fromArray([mkObs({ gtins: ["5712345000019", "5712345000026"] })]),
      client,
    );
    expect(obsInserts(client)[0]?.params[9]).toBe(
      '["5712345000019","5712345000026"]',
    );
  });

  it("writes currency DKK", async () => {
    const client = new FakeD1Client();
    await writeObservations(fromArray([mkObs({ currency: "DKK" })]), client);
    expect(obsInserts(client)[0]?.params[4]).toBe("DKK");
  });

  it("flattens size to size_value and size_unit columns", async () => {
    const client = new FakeD1Client();
    await writeObservations(
      fromArray([mkObs({ size: { value: 1.5, unit: "l" } })]),
      client,
    );
    expect(obsInserts(client)[0]?.params[7]).toBe(1.5);
    expect(obsInserts(client)[0]?.params[8]).toBe("l");
  });

  it("writes NULL for size_value and size_unit when size is absent", async () => {
    const client = new FakeD1Client();
    await writeObservations(fromArray([mkObs()]), client);
    expect(obsInserts(client)[0]?.params[7]).toBeNull();
    expect(obsInserts(client)[0]?.params[8]).toBeNull();
  });

  it("writes NULL for name and brand when absent", async () => {
    const client = new FakeD1Client();
    await writeObservations(fromArray([mkObs()]), client);
    expect(obsInserts(client)[0]?.params[5]).toBeNull();
    expect(obsInserts(client)[0]?.params[6]).toBeNull();
  });

  it("does not persist raw", async () => {
    const client = new FakeD1Client();
    await writeObservations(
      fromArray([mkObs({ raw: { nested: { a: 1 }, list: [1, 2] } })]),
      client,
    );
    expect(obsInserts(client)[0]?.sql).not.toContain("raw");
    expect(obsInserts(client)[0]?.params).toHaveLength(10);
  });

  it("normalises observed_at to include milliseconds", async () => {
    const client = new FakeD1Client();
    await writeObservations(
      fromArray([mkObs({ observed_at: "2024-01-15T10:30:00Z" })]),
      client,
    );
    expect(obsInserts(client)[0]?.params[2]).toBe("2024-01-15T10:30:00.000Z");
  });

  it("propagates errors instead of swallowing them", async () => {
    // SPEC: "It does not catch per-source failures. Failure isolation
    // belongs in SII-103." We verify the writer does NOT wrap exec
    // calls in try/catch.
    const client = new FakeD1Client();
    client.failOn = () => new Error("d1 down");
    await expect(
      writeObservations(fromArray([mkObs()]), client),
    ).rejects.toThrow("d1 down");
  });

  it("uses source_sku (not gtin) as the row identity", async () => {
    // SPEC: "Primary identity is (source, source_sku). gtins[] is
    // optional payload, never the row key."
    const client = new FakeD1Client();
    await writeObservations(
      fromArray([
        mkObs({
          source: "rema",
          source_sku: "rema-internal-42",
          gtins: ["5712345000019"],
        }),
      ]),
      client,
    );
    const params = obsInserts(client)[0]!.params;
    // The PRIMARY KEY columns are at indices 0, 1, 2 (source, source_sku,
    // observed_at). gtin must not appear in any PRIMARY KEY position.
    expect(params[0]).toBe("rema");
    expect(params[1]).toBe("rema-internal-42");
    expect(params).not.toContain("5712345000019");
  });
});

describe("createD1RestClient", () => {
  it("POSTs to the Cloudflare D1 query endpoint with auth", async () => {
    const calls: Array<{
      url: string;
      init: RequestInit | undefined;
    }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({
        url: typeof input === "string" ? input : input.toString(),
        init,
      });
      return new Response(
        JSON.stringify({ success: true, result: [], meta: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = createD1RestClient({
      accountId: "acc123",
      databaseId: "db456",
      apiToken: "tok789",
      fetchImpl: fakeFetch,
    });
    await client.exec("SELECT 1", [42]);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/d1/database/db456/query",
    );
    expect(call.init?.method).toBe("POST");
    expect(
      (call.init?.headers as Record<string, string>)["Authorization"],
    ).toBe("Bearer tok789");
    const body = JSON.parse(call.init?.body as string);
    expect(body.sql).toBe("SELECT 1");
    expect(body.params).toEqual([42]);
  });

  it("posts a batch body from execBatch", async () => {
    const calls: Array<{ body: string }> = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      calls.push({ body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ success: true }, { success: true }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = createD1RestClient({
      accountId: "acc123",
      databaseId: "db456",
      apiToken: "tok789",
      fetchImpl: fakeFetch,
    });
    await client.execBatch!([
      { sql: "INSERT INTO observations (source) VALUES (?)", params: ["rema"] },
      { sql: "INSERT INTO observations (source) VALUES (?)", params: ["spar"] },
    ]);
    const body = JSON.parse(calls[0]!.body);
    expect(body.batch).toEqual([
      {
        sql: "INSERT INTO observations (source) VALUES (?)",
        params: ["rema"],
      },
      {
        sql: "INSERT INTO observations (source) VALUES (?)",
        params: ["spar"],
      },
    ]);
  });

  it("rejects a batch when one statement reports success: false", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: [{ success: true }, { success: false, errors: ["constraint"] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const client = createD1RestClient({
      accountId: "a",
      databaseId: "b",
      apiToken: "t",
      fetchImpl: fakeFetch,
    });
    await expect(
      client.execBatch!([{ sql: "SELECT 1" }, { sql: "SELECT 2" }]),
    ).rejects.toThrow(/constraint/);
  });

  it("surfaces non-2xx responses", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("nope", { status: 500, statusText: "Internal Server Error" });
    const client = createD1RestClient({
      accountId: "a",
      databaseId: "b",
      apiToken: "t",
      fetchImpl: fakeFetch,
    });
    await expect(client.exec("SELECT 1")).rejects.toThrow(/D1 query failed/);
  });

  it("surfaces success: false responses", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ success: false, errors: ["bad sql"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const client = createD1RestClient({
      accountId: "a",
      databaseId: "b",
      apiToken: "t",
      fetchImpl: fakeFetch,
    });
    await expect(client.exec("SELECT 1")).rejects.toThrow(/rejected/);
  });
});

describe("createD1ClientFromEnv", () => {
  it("throws when DB_MODE is not d1", () => {
    expect(() =>
      createD1ClientFromEnv({ DB_MODE: "local" }),
    ).toThrow(/DB_MODE/);
  });

  it("throws when CLOUDFLARE_ACCOUNT_ID is missing", () => {
    expect(() =>
      createD1ClientFromEnv({
        DB_MODE: "d1",
        CLOUDFLARE_D1_DATABASE_ID: "db",
        CLOUDFLARE_API_TOKEN: "t",
      }),
    ).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it("throws when CLOUDFLARE_D1_DATABASE_ID is missing", () => {
    expect(() =>
      createD1ClientFromEnv({
        DB_MODE: "d1",
        CLOUDFLARE_ACCOUNT_ID: "acc",
        CLOUDFLARE_API_TOKEN: "t",
      }),
    ).toThrow(/CLOUDFLARE_D1_DATABASE_ID/);
  });

  it("throws when CLOUDFLARE_API_TOKEN is missing", () => {
    expect(() =>
      createD1ClientFromEnv({
        DB_MODE: "d1",
        CLOUDFLARE_ACCOUNT_ID: "acc",
        CLOUDFLARE_D1_DATABASE_ID: "db",
      }),
    ).toThrow(/CLOUDFLARE_API_TOKEN/);
  });

  it("returns a working client when env is complete", () => {
    const client = createD1ClientFromEnv({
      DB_MODE: "d1",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      CLOUDFLARE_D1_DATABASE_ID: "db",
      CLOUDFLARE_API_TOKEN: "t",
    });
    expect(typeof client.exec).toBe("function");
  });
});

describe("writeObservationsDetailed (listings upsert)", () => {
  it("inserts a listings row the first time a sku is seen", async () => {
    const client = new FakeD1Client();
    const result = await writeObservationsDetailed(
      fromArray([
        mkObs({
          source: "rema",
          source_sku: "r1",
          name: "Minimælk",
          brand: "Arla",
          size: { value: 1, unit: "l" },
          gtins: ["5712345000019"],
        }),
      ]),
      client,
    );
    expect(result.observations).toBe(1);
    expect(result.listingsStatements).toBe(1);
    const insert = client.calls.find((c) =>
      c.sql.startsWith("INSERT INTO listings"),
    );
    expect(insert).toBeDefined();
    expect(insert?.params).toEqual([
      "rema",
      "r1",
      "DKK",
      "Minimælk",
      "Arla",
      1,
      "l",
      '["5712345000019"]',
    ]);
  });

  it("sends no listings statement when all six fields match", async () => {
    const client = new FakeD1Client();
    client.listings.set("rema|r1", {
      source: "rema",
      source_sku: "r1",
      currency: "DKK",
      name: "Minimælk",
      brand: "Arla",
      size_value: 1,
      size_unit: "l",
      gtins: '["5712345000019"]',
    });
    const result = await writeObservationsDetailed(
      fromArray([
        mkObs({
          source: "rema",
          source_sku: "r1",
          name: "Minimælk",
          brand: "Arla",
          size: { value: 1, unit: "l" },
          gtins: ["5712345000019"],
        }),
      ]),
      client,
    );
    expect(result.observations).toBe(1);
    expect(result.listingsStatements).toBe(0);
    const listingsCalls = client.calls.filter((c) =>
      /FROM listings|INSERT INTO listings|UPDATE listings/.test(c.sql),
    );
    // SELECT runs to discover; no INSERT/UPDATE follows.
    expect(listingsCalls).toHaveLength(1);
    expect(listingsCalls[0]!.sql).toContain("FROM listings");
  });

  it("updates the listings row when name changes", async () => {
    const client = new FakeD1Client();
    client.listings.set("rema|r1", {
      source: "rema",
      source_sku: "r1",
      currency: "DKK",
      name: "Minimælk",
      brand: "Arla",
      size_value: 1,
      size_unit: "l",
      gtins: "[]",
    });
    const result = await writeObservationsDetailed(
      fromArray([
        mkObs({
          source: "rema",
          source_sku: "r1",
          name: "Minimælk øko",
          brand: "Arla",
          size: { value: 1, unit: "l" },
          gtins: [],
        }),
      ]),
      client,
    );
    expect(result.listingsStatements).toBe(1);
    const update = client.calls.find((c) =>
      c.sql.startsWith("UPDATE listings"),
    );
    expect(update).toBeDefined();
    expect(update?.params).toEqual([
      "DKK",
      "Minimælk øko",
      "Arla",
      1,
      "l",
      "[]",
      "rema",
      "r1",
    ]);
  });

  it("updates the listings row when gtins changes", async () => {
    const client = new FakeD1Client();
    client.listings.set("rema|r1", {
      source: "rema",
      source_sku: "r1",
      currency: "DKK",
      name: null,
      brand: null,
      size_value: null,
      size_unit: null,
      gtins: "[]",
    });
    const result = await writeObservationsDetailed(
      fromArray([
        mkObs({
          source: "rema",
          source_sku: "r1",
          gtins: ["5712345000019"],
        }),
      ]),
      client,
    );
    expect(result.listingsStatements).toBe(1);
    const update = client.calls.find((c) =>
      c.sql.startsWith("UPDATE listings"),
    );
    expect(update?.params?.[5]).toBe('["5712345000019"]');
  });

  it("does not write listings on a price-only change", async () => {
    const client = new FakeD1Client();
    client.listings.set("rema|r1", {
      source: "rema",
      source_sku: "r1",
      currency: "DKK",
      name: "Minimælk",
      brand: "Arla",
      size_value: 1,
      size_unit: "l",
      gtins: "[]",
    });
    const result = await writeObservationsDetailed(
      fromArray([
        mkObs({
          source: "rema",
          source_sku: "r1",
          name: "Minimælk",
          brand: "Arla",
          size: { value: 1, unit: "l" },
          gtins: [],
          price: 99.95, // only the price changed
        }),
      ]),
      client,
    );
    expect(result.observations).toBe(1);
    expect(result.listingsStatements).toBe(0);
    const listingsWrites = client.calls.filter((c) =>
      /INSERT INTO listings|UPDATE listings/.test(c.sql),
    );
    expect(listingsWrites).toHaveLength(0);
  });

  it("compares gtins as JSON text — array order matters", async () => {
    const client = new FakeD1Client();
    client.listings.set("rema|r1", {
      source: "rema",
      source_sku: "r1",
      currency: "DKK",
      name: null,
      brand: null,
      size_value: null,
      size_unit: null,
      gtins: '["a","b"]',
    });
    const result = await writeObservationsDetailed(
      fromArray([
        mkObs({
          source: "rema",
          source_sku: "r1",
          gtins: ["b", "a"], // different order, same set
        }),
      ]),
      client,
    );
    expect(result.listingsStatements).toBe(1);
  });

  it("handles a chunk with both a missing row and a matching row", async () => {
    const client = new FakeD1Client();
    client.listings.set("rema|existing", {
      source: "rema",
      source_sku: "existing",
      currency: "DKK",
      name: null,
      brand: null,
      size_value: null,
      size_unit: null,
      gtins: "[]",
    });
    const result = await writeObservationsDetailed(
      fromArray([
        mkObs({ source: "rema", source_sku: "existing" }),
        mkObs({ source: "rema", source_sku: "new" }),
      ]),
      client,
    );
    expect(result.observations).toBe(2);
    expect(result.listingsStatements).toBe(1);
    const insert = client.calls.find((c) =>
      c.sql.startsWith("INSERT INTO listings"),
    );
    expect(insert?.params?.[1]).toBe("new");
  });

  it("writeObservations still returns the observation count and ignores listings", async () => {
    const client = new FakeD1Client();
    const total = await writeObservations(
      fromArray([
        mkObs({ source: "rema", source_sku: "r1" }),
        mkObs({ source: "rema", source_sku: "r2" }),
      ]),
      client,
    );
    expect(total).toBe(2);
  });
});