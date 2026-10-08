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

/** One parameterised statement. */
export interface D1Statement {
  sql: string;
  params?: readonly unknown[];
}

/** Minimal D1 client surface that the writer needs. */
export interface D1Client {
  /** Execute a parameterised statement. The writer does not read rows back. */
  exec(sql: string, params?: readonly unknown[]): Promise<void>;
  /**
   * Execute a parameterised SELECT and return the result rows. SII-130
   * uses this to read the current `listings` rows before deciding
   * which listings statements to send. SII-131 imports it too — there
   * is no second D1 client.
   */
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * Execute many statements in one HTTP call. The writer uses this so a
   * full catalog does not spend the Cloud Run request budget on one
   * round trip per row. Clients that omit it are called via `exec`.
   */
  execBatch?(statements: readonly D1Statement[]): Promise<void>;
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

  async function post(body: unknown): Promise<void> {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `D1 query failed (${res.status} ${res.statusText}): ${text}`,
      );
    }
    // Cloudflare wraps results in { success, result, errors }; the
    // writer only inserts and does not inspect row data. A batch
    // response is an array of per-statement results, and any one of
    // those can fail while the HTTP status is still 200.
    const payload = (await res.json()) as {
      success?: boolean;
      errors?: unknown;
      result?: unknown;
    };
    if (payload.success === false) {
      throw new Error(`D1 query rejected: ${JSON.stringify(payload.errors)}`);
    }
    if (Array.isArray(payload.result)) {
      for (const item of payload.result) {
        if (
          item &&
          typeof item === "object" &&
          (item as { success?: boolean }).success === false
        ) {
          throw new Error(
            `D1 query rejected: ${JSON.stringify(
              (item as { errors?: unknown }).errors,
            )}`,
          );
        }
      }
    }
  }

  return {
    async exec(sql: string, params?: readonly unknown[]): Promise<void> {
      await post({ sql, params: params ?? [] });
    },
    async query<T>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      const body = { sql, params: params ?? [] };
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `D1 query failed (${res.status} ${res.statusText}): ${text}`,
        );
      }
      const payload = (await res.json()) as {
        success?: boolean;
        errors?: unknown;
        result?: unknown;
      };
      if (payload.success === false) {
        throw new Error(`D1 query rejected: ${JSON.stringify(payload.errors)}`);
      }
      // The D1 query endpoint returns either { result: [...] } for a
      // single statement, or { result: [{ results: [...] }, ...] } for
      // a batch. We only ever call this from `query`, so we look at the
      // first element.
      const outer = Array.isArray(payload.result) ? payload.result : [];
      const first = outer[0];
      if (
        first &&
        typeof first === "object" &&
        "success" in first &&
        (first as { success?: boolean }).success === false
      ) {
        throw new Error(
          `D1 query rejected: ${JSON.stringify(
            (first as { errors?: unknown }).errors,
          )}`,
        );
      }
      const rows = first && typeof first === "object" && "results" in first
        ? (first as { results?: T[] }).results
        : undefined;
      return (rows ?? []) as T[];
    },
    async execBatch(statements: readonly D1Statement[]): Promise<void> {
      if (statements.length === 0) return;
      await post({
        batch: statements.map((statement) => ({
          sql: statement.sql,
          params: statement.params ?? [],
        })),
      });
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