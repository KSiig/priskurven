import { describe, it, expect } from "vitest";

import {
  createD1ClientFromEnv,
  createD1RestClient,
  type D1Client,
} from "../src/d1";
import type { Observation, Source } from "../src/types";
import { normalizeObservedAt, writeObservations } from "../src/writer";

/**
 * In-memory D1 client. Records every (sql, params) pair so tests can
 * assert what the writer produced. Implements only what the writer
 * needs (`exec`). Reset between tests via `reset()`.
 */
class FakeD1Client implements D1Client {
  calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  failOn?: (sql: string) => Error;

  async exec(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.calls.push({ sql, params });
    if (this.failOn && this.failOn(sql)) {
      const err = this.failOn(sql);
      if (err) throw err;
    }
  }

  reset(): void {
    this.calls = [];
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
    expect(client.calls).toHaveLength(5);
    // Every call targets the same INSERT, same table — per spec.
    for (const call of client.calls) {
      expect(call.sql).toBe(
        "INSERT INTO observations (source, source_sku, observed_at, price, currency, name, brand, size_value, size_unit, gtins, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
    }
  });

  it("writes empty gtins as the literal JSON array []", async () => {
    // SPEC: "Cover empty gtins." DDL says `gtins TEXT` may be []; the
    // writer must encode `[]` — not NULL, not omitted.
    const client = new FakeD1Client();
    await writeObservations(
      fromArray([mkObs({ gtins: [] })]),
      client,
    );
    expect(client.calls).toHaveLength(1);
    // Index 9 is gtins (0: source, 1: source_sku, 2: observed_at,
    // 3: price, 4: currency, 5: name, 6: brand, 7: size_value,
    // 8: size_unit, 9: gtins, 10: raw).
    expect(client.calls[0]?.params[9]).toBe("[]");
  });

  it("writes non-empty gtins as JSON", async () => {
    const client = new FakeD1Client();
    await writeObservations(
      fromArray([mkObs({ gtins: ["5712345000019", "5712345000026"] })]),
      client,
    );
    expect(client.calls[0]?.params[9]).toBe(
      '["5712345000019","5712345000026"]',
    );
  });

  it("writes currency DKK", async () => {
    const client = new FakeD1Client();
    await writeObservations(fromArray([mkObs({ currency: "DKK" })]), client);
    expect(client.calls[0]?.params[4]).toBe("DKK");
  });

  it("flattens size to size_value and size_unit columns", async () => {
    const client = new FakeD1Client();
    await writeObservations(
      fromArray([mkObs({ size: { value: 1.5, unit: "l" } })]),
      client,
    );
    expect(client.calls[0]?.params[7]).toBe(1.5);
    expect(client.calls[0]?.params[8]).toBe("l");
  });

  it("writes NULL for size_value and size_unit when size is absent", async () => {
    const client = new FakeD1Client();
    await writeObservations(fromArray([mkObs()]), client);
    expect(client.calls[0]?.params[7]).toBeNull();
    expect(client.calls[0]?.params[8]).toBeNull();
  });

  it("writes NULL for name and brand when absent", async () => {
    const client = new FakeD1Client();
    await writeObservations(fromArray([mkObs()]), client);
    expect(client.calls[0]?.params[5]).toBeNull();
    expect(client.calls[0]?.params[6]).toBeNull();
  });

  it("JSON-stringifies raw", async () => {
    const client = new FakeD1Client();
    await writeObservations(
      fromArray([mkObs({ raw: { nested: { a: 1 }, list: [1, 2] } })]),
      client,
    );
    expect(client.calls[0]?.params[10]).toBe(
      JSON.stringify({ nested: { a: 1 }, list: [1, 2] }),
    );
  });

  it("JSON-stringifies raw null as the literal string 'null'", async () => {
    // The DDL column is TEXT, so `raw` being undefined serialises to
    // JSON `null` -> the string "null". Documented behaviour, not
    // SQL NULL — if you want SQL NULL for raw, drop it from the
    // Observation (this issue doesn't add that affordance).
    const client = new FakeD1Client();
    await writeObservations(fromArray([mkObs({ raw: null })]), client);
    expect(client.calls[0]?.params[10]).toBe("null");
  });

  it("normalises observed_at to include milliseconds", async () => {
    const client = new FakeD1Client();
    await writeObservations(
      fromArray([mkObs({ observed_at: "2024-01-15T10:30:00Z" })]),
      client,
    );
    expect(client.calls[0]?.params[2]).toBe("2024-01-15T10:30:00.000Z");
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
    const params = client.calls[0]!.params;
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