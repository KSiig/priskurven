/**
 * D1 client — minimal interface plus the REST implementation that talks
 * to Cloudflare D1 from the priskurven-collect Cloud Function.
 *
 * Env contract (also SII-91):
 *   DB_MODE=d1
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_D1_DATABASE_ID  -- the priskurven DB, not homelab
 *   CLOUDFLARE_API_TOKEN
 *
 * The writer depends on {@link D1Client} only. Local tests inject a fake
 * client; production wires {@link createD1ClientFromEnv} at the handler
 * boundary (SII-103).
 */

/** Minimal D1 client surface that the writer needs. */
export interface D1Client {
  /** Execute a parameterised statement. The writer does not read rows back. */
  exec(sql: string, params?: readonly unknown[]): Promise<void>;
}

export interface D1RestConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
  /** Override for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override for tests; defaults to the public Cloudflare API host. */
  baseUrl?: string;
}

/**
 * Build a D1 client that POSTs to the Cloudflare D1 query endpoint.
 * Docs: https://developers.cloudflare.com/api/operations/d1-database-query
 */
export function createD1RestClient(config: D1RestConfig): D1Client {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl ?? "https://api.cloudflare.com";
  const url = `${baseUrl}/client/v4/accounts/${encodeURIComponent(
    config.accountId,
  )}/d1/database/${encodeURIComponent(config.databaseId)}/query`;

  return {
    async exec(sql: string, params?: readonly unknown[]): Promise<void> {
      const body = JSON.stringify({ sql, params: params ?? [] });
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `D1 query failed (${res.status} ${res.statusText}): ${text}`,
        );
      }
      // Cloudflare wraps results in { success, result, errors }; the
      // writer only inserts and does not inspect `result`. We still
      // surface a top-level failure flag to fail fast on API errors.
      const payload = (await res.json()) as {
        success?: boolean;
        errors?: unknown;
      };
      if (payload.success === false) {
        throw new Error(`D1 query rejected: ${JSON.stringify(payload.errors)}`);
      }
    },
  };
}

export interface D1Env {
  DB_MODE?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_D1_DATABASE_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

/**
 * Read env vars and return a D1 client. Throws if the contract is not
 * satisfied. The writer itself never reads env directly — this keeps the
 * function easy to test and easy to wire in SII-103.
 */
export function createD1ClientFromEnv(env: D1Env = process.env): D1Client {
  if (env.DB_MODE !== "d1") {
    throw new Error(
      `DB_MODE must be "d1" (got ${JSON.stringify(env.DB_MODE)})`,
    );
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = env.CLOUDFLARE_D1_DATABASE_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  if (!databaseId) throw new Error("CLOUDFLARE_D1_DATABASE_ID is required");
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required");
  return createD1RestClient({ accountId, databaseId, apiToken });
}