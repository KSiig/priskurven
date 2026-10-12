/**
 * SII-137 backoffice → public API client tests.
 *
 * The client is `backoffice/src/api.ts`. It speaks to the public
 * Worker at `https://priskurven.siig.tech`. We mock `globalThis.fetch`
 * per test (no shared fixture file) so each case inspects the
 * request the client issued and shapes the response independently.
 *
 * Coverage (per SII-137):
 *   1. `listProducts` does not call `fetch` when
 *      `PRISKURVEN_API_TOKEN` is missing — the result is the
 *      `missing_token` error envelope.
 *   2. `createProduct` sends `Authorization: Bearer <token>` and
 *      parses a 201 body.
 *   3. `setSlot` on a 409 body returns `ok: false` with the upstream
 *      error and message.
 *   4. `clearSlot` on 204 returns `{ ok: true, status: 204, body: null }`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearSlot,
  createProduct,
  listProducts,
  setSlot,
  type ApiEnv,
} from "../../backoffice/src/api";

import type { RequestInfo } from "@cloudflare/workers-types";

/** Snapshot of the inputs handed to `globalThis.fetch`. */
interface CapturedFetch {
  url: string;
  init: RequestInit;
}

/**
 * Install a fresh `globalThis.fetch` mock for one test. Returns a
 * handle the test can use to assert on the captured call and to
 * program the response. `restore()` undoes the mock so each test
 * starts clean.
 */
function mockFetch(
  responder: (url: string, init: RequestInit) => Promise<Response>,
): { read: () => CapturedFetch | null; restore: () => void } {
  const handle: { captured: CapturedFetch | null } = { captured: null };
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

/** Convenience: an env with a token. */
function envWithToken(token = "test-token-abc"): ApiEnv {
  return { PRISKURVEN_API_TOKEN: token };
}

/** Build a minimal `Response` for the mock to return. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backoffice api client", () => {
  it("listProducts returns missing_token without calling fetch when the token is absent", async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const result = await listProducts({}, "mælk");
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected ok=false");
      }
      expect(result.status).toBe(500);
      expect(result.error).toBe("missing_token");
      expect(result.message).toBe("PRISKURVEN_API_TOKEN is not set");
      // Critically: no `fetch` was issued. The client short-circuited.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("createProduct sends the bearer header and parses a 201 body", async () => {
    const { read, restore } = mockFetch(async () =>
      jsonResponse(201, { id: 7, label: "Mælk 1L" }),
    );
    try {
      const result = await createProduct(envWithToken(), "Mælk 1L");
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(`expected ok=true, got error ${result.error}`);
      }
      expect(result.status).toBe(201);
      expect(result.body).toEqual({ id: 7, label: "Mælk 1L" });
      const captured = read();
      expect(captured).not.toBeNull();
      const { url, init } = captured as CapturedFetch;
      expect(url).toBe("https://priskurven.siig.tech/v1/products");
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers ?? {});
      expect(headers.get("authorization")).toBe("Bearer test-token-abc");
      expect(init.body).toBe(JSON.stringify({ label: "Mælk 1L" }));
    } finally {
      restore();
    }
  });

  it("setSlot returns ok=false with the upstream 409 error and message", async () => {
    const { read, restore } = mockFetch(async () =>
      jsonResponse(409, {
        error: "conflict",
        message: "listing is on another product",
      }),
    );
    try {
      const result = await setSlot(envWithToken(), 42, "rema", "21464");
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected ok=false");
      }
      expect(result.status).toBe(409);
      expect(result.error).toBe("conflict");
      expect(result.message).toBe("listing is on another product");
      const captured = read();
      expect(captured).not.toBeNull();
      const { url, init } = captured as CapturedFetch;
      expect(url).toBe("https://priskurven.siig.tech/v1/products/42/slots");
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers ?? {});
      expect(headers.get("authorization")).toBe("Bearer test-token-abc");
      expect(init.body).toBe(
        JSON.stringify({ source: "rema", source_sku: "21464" }),
      );
    } finally {
      restore();
    }
  });

  it("clearSlot on 204 returns ok=true with body null", async () => {
    const { read, restore } = mockFetch(async () =>
      new Response(null, { status: 204 }),
    );
    try {
      const result = await clearSlot(envWithToken(), 42, "rema");
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected ok=true");
      }
      expect(result.status).toBe(204);
      expect(result.body).toBeNull();
      const captured = read();
      expect(captured).not.toBeNull();
      const { url, init } = captured as CapturedFetch;
      expect(url).toBe(
        "https://priskurven.siig.tech/v1/products/42/slots/rema",
      );
      expect(init.method).toBe("DELETE");
    } finally {
      restore();
    }
  });
});