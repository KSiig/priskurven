import { describe, it, expect, vi } from "vitest";

import {
  runOrchestrator,
  type Observation,
  type Source,
  type Writer,
} from "../src/orchestrator.js";

/** Yield observations one tick apart so we exercise the AsyncIterable path. */
async function* fromArray(items: Observation[]): AsyncIterable<Observation> {
  for (const item of items) yield item;
}

const baseObs = (overrides: Partial<Observation> = {}): Observation => ({
  source: "rema",
  source_sku: "rema-1",
  observed_at: "2024-01-15T10:30:00.000Z",
  price: 10,
  currency: "DKK",
  gtins: [],
  raw: null,
  ...overrides,
});

describe("runOrchestrator", () => {
  it("continues when one source throws — other sources still write", async () => {
    // SPEC: "Stub source A so it throws. Confirm source B still writes."
    // The fake writer drains the stream and returns the count, matching
    // SII-93's `writeObservations` contract.
    const writeSpy = vi
      .fn()
      .mockImplementation(async (stream: AsyncIterable<Observation>) => {
        let n = 0;
        for await (const _obs of stream) n += 1;
        return n;
      });

    const sources: Source[] = [
      // source_0: succeeds, two observations
      () => fromArray([baseObs({ source_sku: "a1" }), baseObs({ source_sku: "a2" })]),
      // source_1: throws synchronously when called
      () => {
        throw new Error("boom from B");
      },
      // source_2: succeeds, one observation
      () => fromArray([baseObs({ source: "lidl", source_sku: "c1" })]),
    ];

    const writer: Writer = { write: writeSpy };

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await runOrchestrator(sources, writer);

      // source_0 wrote 2 rows
      expect(result.perSource["source_0"]).toEqual({ ok: true, written: 2 });
      // source_1 failed with the original error message
      expect(result.perSource["source_1"]).toMatchObject({
        ok: false,
        written: 0,
        error: expect.stringContaining("boom from B"),
      });
      // source_2 still ran and wrote 1 row
      expect(result.perSource["source_2"]).toEqual({ ok: true, written: 1 });

      // writer.write was called exactly for the two non-throwing sources
      expect(writeSpy).toHaveBeenCalledTimes(2);

      // failure was logged with a structured payload
      expect(errSpy).toHaveBeenCalledWith(
        "priskurven source failed",
        expect.objectContaining({
          source: "source_1",
          index: 1,
          error: expect.stringContaining("boom from B"),
        }),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("isolates failures thrown during iteration (not just at source() call time)", async () => {
    // SPEC: failures anywhere in the source pipeline must not abort others.
    // source_1 throws while its async iterable is being consumed by the writer.
    const writer: Writer = {
      async write(stream) {
        let n = 0;
        for await (const _obs of stream) n += 1;
        return n;
      },
    };

    const sources: Source[] = [
      () => fromArray([baseObs({ source_sku: "a1" })]),
      async function* (): AsyncIterable<Observation> {
        yield baseObs({ source: "lidl", source_sku: "b1" });
        // Throw mid-stream — mimics a real source whose parser blows up
        // after the first row.
        throw new Error("source 2 mid-stream");
      },
      () => fromArray([baseObs({ source: "netto", source_sku: "c1" })]),
    ];

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await runOrchestrator(sources, writer);

      expect(result.perSource["source_0"]).toEqual({ ok: true, written: 1 });
      expect(result.perSource["source_1"]).toMatchObject({
        ok: false,
        written: 0,
        error: expect.stringContaining("source 2 mid-stream"),
      });
      expect(result.perSource["source_2"]).toEqual({ ok: true, written: 1 });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("writes every fetch — including rows that match the previous observation", async () => {
    // SPEC: "every fetch inserts a row. Include rows that match the
    // previous observation for (price, name, gtins)." No skip-unchanged
    // logic in M1.
    const writeSpy = vi.fn().mockResolvedValue(1);

    const sources: Source[] = [
      () =>
        fromArray([
          baseObs({
            source: "rema",
            source_sku: "r1",
            price: 12.5,
            name: "Mælk 1L",
            gtins: ["5712345000019"],
          }),
        ]),
    ];

    const writer: Writer = { write: writeSpy };

    // Run twice with the same observation — both must produce a write.
    await runOrchestrator(sources, writer);
    await runOrchestrator(sources, writer);

    // writer.write called for every run, not deduplicated.
    expect(writeSpy).toHaveBeenCalledTimes(2);
    // Each call received the full stream — no skip-unchanged behaviour.
    const firstStream = writeSpy.mock.calls[0]?.[0] as AsyncIterable<Observation>;
    const secondStream = writeSpy.mock.calls[1]?.[0] as AsyncIterable<Observation>;
    expect(firstStream).toBeDefined();
    expect(secondStream).toBeDefined();

    // Drain both streams and confirm the duplicate was forwarded in full.
    const drain = async (s: AsyncIterable<Observation>): Promise<Observation[]> => {
      const out: Observation[] = [];
      for await (const o of s) out.push(o);
      return out;
    };
    const a = await drain(firstStream);
    const b = await drain(secondStream);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toEqual(b[0]); // exact same observation, including price/name/gtins
  });

  it("returns an empty perSource map when no sources are registered", async () => {
    const writer: Writer = { write: vi.fn().mockResolvedValue(0) };
    const result = await runOrchestrator([], writer);
    expect(result.perSource).toEqual({});
  });

  it("does not use Promise.all (verifies Promise.allSettled via mixed outcome)", async () => {
    // If the orchestrator used Promise.all, the second source's
    // rejection would propagate and `runOrchestrator` itself would
    // throw. With Promise.allSettled, the function returns a
    // perSource map covering every source.
    const writer: Writer = { write: vi.fn().mockResolvedValue(0) };
    const sources: Source[] = [
      () => fromArray([baseObs({ source_sku: "a1" })]),
      () => {
        throw new Error("nope");
      },
    ];

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // Must NOT throw — failure is captured per-source.
      const result = await runOrchestrator(sources, writer);
      expect(Object.keys(result.perSource)).toHaveLength(2);
      expect(result.perSource["source_1"]?.ok).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});
