import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/d1.js", () => ({
  createD1ClientFromEnv: () => ({
    async exec() {},
    async query<T>(): Promise<T[]> {
      return [];
    },
    async execBatch() {},
  }),
}));

vi.mock("../src/orchestrator.js", () => ({
  sources: [],
  runOrchestrator: vi.fn(),
}));

import { runOrchestrator } from "../src/orchestrator.js";
import { endHttpResponse, handler } from "../src/index.js";

function fakeRes() {
  const sent: Array<{ code: number; body: unknown }> = [];
  return {
    sent,
    status(code: number) {
      return {
        json(body: unknown) {
          sent.push({ code, body });
        },
      };
    },
  };
}

describe("endHttpResponse", () => {
  it("does nothing when the caller is not an HTTP response", () => {
    expect(endHttpResponse(undefined, 200, { ok: true })).toBe(false);
  });
});

describe("handler", () => {
  beforeEach(() => {
    vi.mocked(runOrchestrator).mockReset();
  });

  it("ends the HTTP response with the orchestrator result", async () => {
    const result = { perSource: { source_0: { ok: true, written: 2 } } };
    vi.mocked(runOrchestrator).mockResolvedValue(result);
    const res = fakeRes();
    await expect(handler(undefined, res)).resolves.toEqual(result);
    expect(res.sent).toEqual([{ code: 200, body: result }]);
  });

  it("answers 500 when the run throws", async () => {
    vi.mocked(runOrchestrator).mockRejectedValue(new Error("d1 down"));
    const res = fakeRes();
    await expect(handler(undefined, res)).resolves.toEqual({ perSource: {} });
    expect(res.sent).toEqual([{ code: 500, body: { error: "d1 down" } }]);
  });
});
