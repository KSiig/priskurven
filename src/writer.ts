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
 * DDL columns (copy of SII-109, so this file stands alone):
 *   source TEXT, source_sku TEXT, observed_at TEXT
 *   price REAL, currency TEXT
 *   name TEXT, brand TEXT, size_value REAL, size_unit TEXT
 *   gtins TEXT  -- JSON array, may be []
 *   raw TEXT    -- JSON
 *   PRIMARY KEY (source, source_sku, observed_at)
 */

import type { D1Client } from "./d1";
import type { Observation } from "./types";

const INSERT_SQL =
  "INSERT INTO observations (" +
  "source, source_sku, observed_at, " +
  "price, currency, " +
  "name, brand, size_value, size_unit, " +
  "gtins, raw" +
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

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
export async function writeObservations(
  stream: AsyncIterable<Observation>,
  client: D1Client,
): Promise<number> {
  let n = 0;
  for await (const obs of stream) {
    const observed_at = normalizeObservedAt(obs.observed_at);
    const params: readonly unknown[] = [
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
      JSON.stringify(obs.raw ?? null),
    ];
    await client.exec(INSERT_SQL, params);
    n += 1;
  }
  return n;
}