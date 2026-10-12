/**
 * priskurven-backoffice Worker entry point.
 *
 * Lives in front of the public `priskurven` API Worker and behind a
 * Cloudflare Access application on `backoffice.priskurven.siig.tech`.
 *
 * The shape of `ctx` is augmented here rather than via the
 * `@cloudflare/workers-types` release on `main` (which is older than
 * the August 2026 `ctx.access` field). The cast keeps this Worker
 * portable: if a future release renames the field, this file is the
 * only one that has to change.
 *
 * Routing on this layer:
 *   - `/` — the shell, rendered after the Access check passes.
 *   - everything else — 404.
 *
 * SII-138 (PR #35) adds the `/products` and `/products/...`
 * dispatch as an additional `else if` branch during cascade rebase.
 * SII-141 (PR #34) adds the `/approval` and `/approval/...`
 * dispatch as another additional `else if` branch during cascade
 * rebase. The chain below is shaped so each cascade commit's diff
 * is exactly one extra `else if` plus its corresponding import.
 */

import type {
  D1Database,
  ExecutionContext,
} from "@cloudflare/workers-types";

import { escapeHtml } from "./html";

/**
 * Minimal shape of the identity Cloudflare Access returns for a
 * signed-in user. The real shape lives in
 * `@cloudflare/workers-types`, but we declare a local copy so the
 * Worker does not depend on a particular release of that package.
 */
type AccessIdentity = { email?: string };

/**
 * Augmentation of the Workers `ExecutionContext` for deployments
 * that expose Cloudflare Access via `ctx.access`. Per SII-137 we
 * do not depend on this field existing in the bundled type
 * definitions; the cast at the call site is the only place that
 * touches `ctx.access`.
 */
type AccessOnContext = {
  access?: {
    getIdentity(): Promise<AccessIdentity | null>;
  };
};

/**
 * Env contract for this Worker:
 *   - `DB`         — D1 binding (mirror of the public Worker).
 *   - `PRISKURVEN_API_TOKEN` — bearer token for the public API,
 *     configured via `wrangler secret put`. Optional from this file's
 *     perspective: when missing, the API client returns
 *     `missing_token`.
 */
export type Env = {
  DB: D1Database;
  PRISKURVEN_API_TOKEN?: string;
};

/**
 * Read the Access identity for the current request.
 *
 * Returns the identity on success, `null` when access is missing,
 * `getIdentity()` rejects, or the result itself is `null`. Every
 * null case is treated identically — the caller maps it to a 403
 * `access_required` response.
 */
async function readAccessIdentity(
  ctx: ExecutionContext,
): Promise<AccessIdentity | null> {
  const augmented = ctx as unknown as ExecutionContext & AccessOnContext;
  if (!augmented.access) {
    return null;
  }
  try {
    const identity = await augmented.access.getIdentity();
    return identity ?? null;
  } catch {
    return null;
  }
}

/**
 * Render the shell HTML. The only user-controlled field is the
 * email from Access, which is escaped before insertion.
 */
function htmlShell(_env: Env, identity: AccessIdentity): string {
  const email = typeof identity.email === "string" ? identity.email : "";
  const safeEmail = escapeHtml(email);
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<title>Priskurven backoffice</title>",
    "</head>",
    "<body>",
    "<h1>Priskurven backoffice</h1>",
    safeEmail.length > 0
      ? `<p>Signed in as ${safeEmail}.</p>`
      : "<p>Signed in.</p>",
    "<nav>",
    "<a href=\"/products\">Products</a>",
    "<a href=\"/approval\">Approval</a>",
    "</nav>",
    "</body>",
    "</html>",
  ].join("");
}

/**
 * Worker fetch handler.
 *
 * On this layer the routing is `/` and the 404 default. SII-138
 * adds `/products` and SII-141 adds `/approval` in cascade
 * rebases; each lands as one additional `else if` branch.
 */
export async function fetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const identity = await readAccessIdentity(ctx);
  if (identity === null) {
    return new Response("access_required", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const url = new URL(request.url);
  if (url.pathname === "/") {
    return new Response(htmlShell(env, identity), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } else {
    return new Response("not_found", { status: 404 });
  }
}

export default { fetch };