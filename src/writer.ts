/**
 * Writer — SII-93.
 *
 * One writer. Accepts an `AsyncIterable<Observation>` and inserts each
 * row into the `observations` table via the injected {@link D1Client}.
 *
 * Scope (SII-93):
 *   - Maps `Observation` -> DDL columns verbatim (see SII-109).
 *   - Inserts. Does NOT skip unchanged rows (skip-unchanged is deferred).
 *   - Does NOT swallow per-source failures. Failure isolation lives in
 *     SII-103 (orchestrator). Errors here propagate to the caller.
 *
 * DDL columns of observations_v2 (homelab migration 0002):
 *   source TEXT, source_sku TEXT, observed_at TEXT
 *   price REAL, currency TEXT
 *   name TEXT, brand TEXT, size_value REAL, size_unit TEXT
 *   gtins TEXT  -- JSON array, may be []
 *   PRIMARY KEY (source, source_sku, observed_at) WITHOUT ROWID
 * `raw` stays on the in-memory Observation and is not inserted.
 * One btree means one D1 row written per product.
 */

import type { D1Client, D1Statement } from "./d1";
import type { Observation } from "./types";

/**
 * Inserts per D1 HTTP call. One round trip per row cannot finish the
 * larger catalogs inside the 300s Cloud Run request timeout: a live
 * run on 2026-10-01 wrote about 4 rows/sec per source and was killed
 * with Min Købmand at 1326 of 4434 and SPAR at 1325 of 5042. Fifty
 * statements per call is the batch the REST API accepts as one POST.
 */
const ROWS_PER_REQUEST = 50;

const INSERT_SQL =
  "INSERT INTO observations_v2 (" +
  "source, source_sku, observed_at, " +
  "price, currency, " +
  "name, brand, size_value, size_unit, " +
  "gtins" +
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * Normalise an ISO 8601 timestamp so it always has a `Z` suffix and
 * always carries milliseconds. Validates that the input is a real date.
 *
 * Examples:
 *   "2024-01-15T10:30:00Z"             -> "2024-01-15T10:30:00.000Z"
 *   "2024-01-15T10:30:00.123Z"         -> "2024-01-15T10:30:00.123Z"
 *   "2024-01-15T10:30:00+00:00"        -> "2024-01-15T10:30:00.000Z"
 *   "2024-01-15T10:30:00.123+02:00"    -> Error (must be UTC)
 */
export function normalizeObservedAt(input: string): string {
  if (typeof input !== "string") {
    throw new Error(`observed_at must be a string, got ${typeof input}`);
  }
  // Reject anything that doesn't end with Z (UTC). DDL contract is UTC.
  if (!input.endsWith("Z")) {
    throw new Error(
      `observed_at must be UTC with Z suffix, got ${JSON.stringify(input)}`,
    );
  }
  // Date.parse accepts both "...Z" and "...123Z"; round-trip through Date
  // so we catch invalid dates like "2024-13-99T...".
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) {
    throw new Error(`observed_at is not a valid date: ${JSON.stringify(input)}`);
  }
  // Re-emit with explicit milliseconds. Use UTC components, not local.
  const d = new Date(ms);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  const mss = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `${Y}-${M}-${D}T${h}:${m}:${s}.${mss}Z`;
}

/**
 * Consume a stream of observations and insert each row. Returns the
 * number of rows inserted.
 *
 * Throws on the first malformed observation or write failure; the
 * caller (SII-103) decides how to isolate per-source failures.
 */
async function flushStatements(
  client: D1Client,
  statements: D1Statement[],
): Promise<void> {
  if (statements.length === 0) return;
  if (client.execBatch) {
    await client.execBatch(statements);
    return;
  }
  for (const statement of statements) {
    await client.exec(statement.sql, statement.params);
  }
}

export async function writeObservations(
  stream: AsyncIterable<Observation>,
  client: D1Client,
): Promise<number> {
  let n = 0;
  let pending: D1Statement[] = [];
  for await (const obs of stream) {
    const observed_at = normalizeObservedAt(obs.observed_at);
    pending.push({
      sql: INSERT_SQL,
      params: [
        obs.source,
        obs.source_sku,
        observed_at,
        obs.price,
        obs.currency,
        obs.name ?? null,
        obs.brand ?? null,
        obs.size?.value ?? null,
        obs.size?.unit ?? null,
        JSON.stringify(obs.gtins ?? []),
      ],
    });
    if (pending.length >= ROWS_PER_REQUEST) {
      const batch = pending;
      pending = [];
      await flushStatements(client, batch);
      n += batch.length;
    }
  }
  await flushStatements(client, pending);
  n += pending.length;
  return n;
}