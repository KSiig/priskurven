/**
 * Backoffice → priskurven public API client.
 *
 * The public Worker (`priskurven`, see the root `wrangler.toml`)
 * exposes the read/write surface the backoffice shell needs. This
 * file is the ONLY place that talks to that API from the backoffice.
 * SII-138 (`products.ts`) and SII-141 (`approval.ts`) import from
 * here; nothing else in `backoffice/src/` should issue a `fetch` of
 * its own.
 *
 * Auth: every call sends `Authorization: Bearer <token>` where the
 * token is `env.PRISKURVEN_API_TOKEN`. The token is configured on the
 * backoffice Worker via `wrangler secret put`, NOT committed to the
 * repo, and NOT present in any CI `--set-secrets` line.
 *
 * Error model:
 *   - `ok: true`  carries `status` and `body` (the parsed JSON or
 *     `null` for a 204).
 *   - `ok: false` carries `status`, `error`, and `message`. `error`
 *     comes from the JSON body when present, otherwise from
 *     `http_<status>`. `message` comes from the JSON body when
 *     present, otherwise from `error`.
 *
 * The `missing_token` short-circuit never touches `fetch` — that's
 * what the test pins down, and it's also the right thing for a Worker
 * that boots before its secrets are configured.
 */

const BASE_URL = "https://priskurven.siig.tech";

/** Successful API response with parsed body. */
export type ApiOk<T> = { ok: true; status: number; body: T };

/** Failed API response (network, HTTP, or auth-config issue). */
export type ApiErr = {
  ok: false;
  status: number;
  error: string;
  message: string;
};

/** Discriminated result for every backoffice → public API call. */
export type ApiResult<T> = ApiOk<T> | ApiErr;

/** Minimal env shape this client depends on. Larger `Env` shapes in
 *  `products.ts` / `approval.ts` extend this via `&`. */
export type ApiEnv = {
  PRISKURVEN_API_TOKEN?: string;
};

/** Public-API product row. */
export type Product = { id: number; label: string };

/** One observation point inside a store slot. */
export type PricePoint = { observed_at: string; price: number };

/**
 * A slot can be either filled (a real listing matched by `manual`
 * override or an `ean` lookup, with at least one `PricePoint`) or
 * empty (no listing matched, `matched_by: null`, no prices).
 */
export type StoreSlot =
  | {
      source: string;
      source_sku: string;
      matched_by: "manual" | "ean";
      prices: PricePoint[];
    }
  | {
      source: string;
      source_sku: null;
      matched_by: null;
      prices: [];
    };

/**
 * Read the bearer token off the env. Treats empty strings as missing
 * so a misconfigured `wrangler secret put` of an empty value cannot
 * accidentally send `Authorization: Bearer ` (which the public
 * Worker rejects, but the resulting 401 would still look like a real
 * auth failure to the caller).
 */
function getToken(env: ApiEnv): string | undefined {
  const token = env.PRISKURVEN_API_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    return undefined;
  }
  return token;
}

/**
 * Read a non-2xx response body as JSON when possible and pull out
 * the `{ error, message }` shape the public Worker uses. When the
 * body is not JSON, fall back to `http_<status>` for the error code
 * and the raw text for the message. The function is async because
 * `response.text()` is async on Workers.
 */
async function readError(
  response: Response,
): Promise<{ error: string; message: string }> {
  const status = response.status;
  let text = "";
  try {
    text = await response.text();
  } catch {
    // Network-level read failure. Fall through to the synthesized
    // error below; `text` stays empty.
  }
  if (text.length > 0) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const rawError = obj["error"];
        const rawMessage = obj["message"];
        const error =
          typeof rawError === "string" && rawError.length > 0
            ? rawError
            : `http_${status}`;
        const message =
          typeof rawMessage === "string" && rawMessage.length > 0
            ? rawMessage
            : error;
        return { error, message };
      }
    } catch {
      // Body was not JSON. Fall through.
    }
    return { error: `http_${status}`, message: text };
  }
  return { error: `http_${status}`, message: `http_${status}` };
}

/**
 * Issue a single request and shape the result. The caller decides
 * which HTTP status counts as success; this helper only normalises
 * the failure shape and the 204 → `body: null` mapping.
 */
async function send<T>(
  env: ApiEnv,
  path: string,
  init: RequestInit,
  successStatus: number,
): Promise<ApiResult<T>> {
  const token = getToken(env);
  if (token === undefined) {
    return {
      ok: false,
      status: 500,
      error: "missing_token",
      message: "PRISKURVEN_API_TOKEN is not set",
    };
  }
  const url = `${BASE_URL}${path}`;
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, { ...init, headers });
  if (response.status === successStatus) {
    if (response.status === 204) {
      return { ok: true, status: 204, body: null as T };
    }
    const body = (await response.json()) as T;
    return { ok: true, status: response.status, body };
  }
  const { error, message } = await readError(response);
  return { ok: false, status: response.status, error, message };
}

/**
 * `GET /v1/products?q=`. Omit the `?q=` when the search box is
 * empty so we don't hand the public Worker an empty filter.
 */
export function listProducts(
  env: ApiEnv,
  q: string,
): Promise<ApiResult<{ products: Product[] }>> {
  const trimmed = q.trim();
  const path = trimmed.length > 0
    ? `/v1/products?q=${encodeURIComponent(trimmed)}`
    : "/v1/products";
  return send(env, path, { method: "GET" }, 200);
}

/**
 * `GET /v1/products/:id`. 200 only — anything else (including a 404)
 * becomes an `ok: false` result with the upstream error/message.
 */
export function getProduct(
  env: ApiEnv,
  id: number,
): Promise<ApiResult<{ id: number; label: string; stores: StoreSlot[] }>> {
  return send(env, `/v1/products/${id}`, { method: "GET" }, 200);
}

/**
 * `POST /v1/products` with `{ "label": "<label>" }`. Only 201 counts
 * as success — the public Worker returns 201 on a fresh product.
 */
export function createProduct(
  env: ApiEnv,
  label: string,
): Promise<ApiResult<Product>> {
  return send(
    env,
    "/v1/products",
    {
      method: "POST",
      body: JSON.stringify({ label }),
    },
    201,
  );
}

/**
 * `POST /v1/products/:id/slots` with
 * `{ "source": "<source>", "source_sku": "<sourceSku>" }`. Only 201
 * counts as success.
 */
export function setSlot(
  env: ApiEnv,
  id: number,
  source: string,
  sourceSku: string,
): Promise<ApiResult<{ source: string; source_sku: string; matched_by: "manual" }>> {
  return send(
    env,
    `/v1/products/${id}/slots`,
    {
      method: "POST",
      body: JSON.stringify({ source, source_sku: sourceSku }),
    },
    201,
  );
}

/**
 * `DELETE /v1/products/:id/slots/:source`. 204 is the documented
 * success status with an empty body — the helper returns
 * `{ ok: true, status: 204, body: null }` for that case so the
 * caller never has to special-case a JSON parse.
 */
export function clearSlot(
  env: ApiEnv,
  id: number,
  source: string,
): Promise<ApiResult<null>> {
  return send(env, `/v1/products/${id}/slots/${source}`, { method: "DELETE" }, 204);
}