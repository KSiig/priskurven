/**
 * SII-137 backoffice shell tests.
 *
 * The shell is `backoffice/src/index.ts`. These tests drive its
 * public surface: `fetch(request, env, ctx)` with three flavours of
 * `ctx`:
 *
 *   1. No `access` field at all → 403 / `access_required`.
 *   2. `access.getIdentity()` resolving to `{ email: "..." }` → 200
 *      HTML containing the email and the two nav anchors.
 *   3. Access present, but an unknown path → 404 / `not_found`.
 *
 * The D1 stand-in is built inside this file. We deliberately do not
 * import the mocks from `test/history.test.ts` or
 * `test/products.test.ts` — every test file owns its own fixtures.
 */

import { describe, expect, it } from "vitest";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

import { fetch } from "../../backoffice/src/index";

/**
 * Minimal D1 binding shape: only `.prepare(...)` is on the interface
 * the backoffice Worker exercises in these tests, and none of the
 * routes under test actually hit D1 — the stand-in is here so the
 * Worker's `env.DB` access typechecks without a real driver.
 */
interface FakeD1 {
  prepare(query: string): { bind(): { all<T>(): Promise<{ results?: T[] }> } };
}

/** Build a no-op D1 stand-in. */
function makeD1(): FakeD1 {
  const stmt = {
    bind() {
      return this;
    },
    async all<T>(): Promise<{ results?: T[] }> {
      return { results: [] as T[] };
    },
  };
  return {
    prepare() {
      return stmt;
    },
  };
}

/**
 * Augment a real Workers `ExecutionContext` with an optional Access
 * identity resolver. Mirrors the cast the Worker itself performs.
 */
type AccessCtx = ExecutionContext & {
  access?: { getIdentity(): Promise<{ email?: string } | null> };
};

/** Test helper that wires a Request → Response call through the
 *  backoffice Worker entry. */
function callShell(
  path: string,
  ctx: AccessCtx,
  init: RequestInit = {},
): Promise<Response> {
  const url = `https://backoffice.priskurven.example${path}`;
  const request = new Request(url, init);
  const env = { DB: makeD1() as unknown as D1Database };
  return fetch(request, env, ctx);
}

describe("backoffice shell", () => {
  it("returns 403 access_required when ctx has no access", async () => {
    const ctx = {} as AccessCtx;
    const res = await callShell("/", ctx);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("access_required");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("returns 200 HTML with the email and both nav links when access resolves", async () => {
    const ctx = {
      access: {
        async getIdentity(): Promise<{ email?: string } | null> {
          return { email: "kasper@siig.tech" };
        },
      },
    } as unknown as AccessCtx;
    const res = await callShell("/", ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("Priskurven backoffice");
    expect(body).toContain("kasper@siig.tech");
    expect(body).toContain('href="/products"');
    expect(body).toContain('href="/approval"');
  });

  it("returns 404 not_found for any other path", async () => {
    const ctx = {
      access: {
        async getIdentity(): Promise<{ email?: string } | null> {
          return { email: "kasper@siig.tech" };
        },
      },
    } as unknown as AccessCtx;
    const res = await callShell("/nope", ctx);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not_found");
  });
});