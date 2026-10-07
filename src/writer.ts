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
 * DDL columns of observations (homelab migration 0003, SII-118):
 *   source TEXT, source_sku TEXT, observed_at TEXT
 *   price REAL, currency TEXT
 *   name TEXT, brand TEXT, size_value REAL, size_unit TEXT
 *   gtins TEXT  -- JSON array, may be []
 *   PRIMARY KEY (source, source_sku, observed_at) WITHOUT ROWID
 * There is no `raw` column. Sources may still put `raw` on the
 * in-memory Observation; the writer does not persist it.
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
  "INSERT INTO observations (" +
  "source, source_sku, observed_at, " +
  "price, currency, " +
  "name, brand, size_value, size_unit, " +
  "gtins" +
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * Listing row returned by {@link D1Client.query}. The shape is fixed
 * by the `listings` DDL in homelab migration `0004`. `gtins` is the
 * JSON text the DB stored — compare it as text.
 */
type ListingRow = {
  source: string;
  source_sku: string;
  currency: string;
  name: string | null;
  brand: string | null;
  size_value: number | null;
  size_unit: string | null;
  gtins: string;
};

const SELECT_LISTINGS_SQL =
  "SELECT source, source_sku, currency, name, brand, " +
  "size_value, size_unit, gtins " +
  "FROM listings " +
  "WHERE source = ? AND source_sku IN (";

const INSERT_LISTINGS_SQL =
  "INSERT INTO listings (" +
  "source, source_sku, currency, name, brand, " +
  "size_value, size_unit, gtins" +
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

const UPDATE_LISTINGS_SQL =
  "UPDATE listings SET " +
  "currency = ?, name = ?, brand = ?, " +
  "size_value = ?, size_unit = ?, gtins = ? " +
  "WHERE source = ? AND source_sku = ?";

/**
 * The six listing columns the writer tracks. `price` and `observed_at`
 * are intentionally absent — a price-only change must not write the
 * `listings` row.
 */
function listingFromObservation(obs: Observation): {
  currency: string;
  name: string | null;
  brand: string | null;
  size_value: number | null;
  size_unit: string | null;
  gtins: string;
} {
  return {
    currency: obs.currency,
    name: obs.name ?? null,
    brand: obs.brand ?? null,
    size_value: obs.size?.value ?? null,
    size_unit: obs.size?.unit ?? null,
    gtins: JSON.stringify(obs.gtins ?? []),
  };
}

/** True when every column matches. Null matches null. */
function listingsMatch(row: ListingRow, candidate: ReturnType<typeof listingFromObservation>): boolean {
  return (
    row.currency === candidate.currency &&
    row.name === candidate.name &&
    row.brand === candidate.brand &&
    row.size_value === candidate.size_value &&
    row.size_unit === candidate.size_unit &&
    row.gtins === candidate.gtins
  );
}

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

/**
 * Result of {@link writeObservations}. The observations row count is
 * what SII-93 used to return; `listings` statements are returned so
 * tests can count them and the orchestrator can surface them.
 */
export type WriteResult = {
  observations: number;
  listingsStatements: number;
};

export async function writeObservations(
  stream: AsyncIterable<Observation>,
  client: D1Client,
): Promise<number> {
  const result = await writeObservationsDetailed(stream, client);
  return result.observations;
}

/**
 * Like {@link writeObservations}, but also returns the number of
 * `listings` statements the writer sent. SII-130 keeps the observation
 * insert intact and adds a per-chunk upsert against `listings`:
 *   - one SELECT per chunk (max 50 SKUs) to fetch current rows
 *   - compare in memory; emit INSERT for missing rows and UPDATE only
 *     when at least one of the six tracked columns changed
 *   - skip entirely on a price-only change (it is not in those six)
 *   - batch the resulting statements through `execBatch`
 *
 * A failed `listings` write fails the whole collect — `runOrchestrator`
 * already isolates per-source failures.
 */
export async function writeObservationsDetailed(
  stream: AsyncIterable<Observation>,
  client: D1Client,
): Promise<WriteResult> {
  let observationsCount = 0;
  let listingsCount = 0;
  let pendingObs: D1Statement[] = [];
  let pendingListings: D1Statement[] = [];

  const flush = async (): Promise<void> => {
    const obsBatch = pendingObs;
    const listingsBatch = pendingListings;
    pendingObs = [];
    pendingListings = [];
    if (obsBatch.length > 0) {
      await flushStatements(client, obsBatch);
      observationsCount += obsBatch.length;
    }
    if (listingsBatch.length > 0) {
      await flushStatements(client, listingsBatch);
      listingsCount += listingsBatch.length;
    }
  };

  let chunk: Observation[] = [];

  const processChunk = async (ready: readonly Observation[]): Promise<void> => {
    // Flush pending observations first so their INSERT statements reach
    // the wire before the listings SELECT/UPDATE round trip.
    if (pendingObs.length > 0) {
      const obsBatch = pendingObs;
      pendingObs = [];
      await flushStatements(client, obsBatch);
      observationsCount += obsBatch.length;
    }
    const chunkStatements = await listingsStatementsForChunk(client, ready);
    for (const stmt of chunkStatements) {
      pendingListings.push(stmt);
      if (pendingListings.length >= ROWS_PER_REQUEST) {
        const listingsBatch = pendingListings;
        pendingListings = [];
        await flushStatements(client, listingsBatch);
        listingsCount += listingsBatch.length;
      }
    }
  };

  for await (const obs of stream) {
    const observed_at = normalizeObservedAt(obs.observed_at);
    pendingObs.push({
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
    chunk.push(obs);

    if (chunk.length >= ROWS_PER_REQUEST) {
      const ready = chunk;
      chunk = [];
      await processChunk(ready);
    }
  }

  // Tail chunk.
  if (chunk.length > 0) {
    await processChunk(chunk);
  }

  if (pendingObs.length > 0 || pendingListings.length > 0) {
    await flush();
  }
  return { observations: observationsCount, listingsStatements: listingsCount };
}

/**
 * Build the listings INSERT/UPDATE statements for one chunk. Reads
 * the current `listings` rows for the chunk's `(source, source_sku)`
 * pairs and emits:
 *   - one INSERT for each pair that has no row
 *   - one UPDATE for each pair whose six tracked columns differ
 *   - nothing for a matching pair, or for a price-only change
 */
async function listingsStatementsForChunk(
  client: D1Client,
  chunk: readonly Observation[],
): Promise<D1Statement[]> {
  if (chunk.length === 0) return [];
  // All observations in one chunk share the same `source` (the writer
  // is called once per source by the orchestrator). We still pass the
  // source explicitly so the SQL is correct even if a future caller
  // mixes sources.
  const source = chunk[0]!.source;
  const placeholders = chunk.map(() => "?").join(", ");
  const sql = SELECT_LISTINGS_SQL + placeholders + ")";
  const params = [source, ...chunk.map((o) => o.source_sku)];
  const rows = await client.query<ListingRow>(sql, params);
  const bySku = new Map<string, ListingRow>();
  for (const row of rows) {
    bySku.set(row.source_sku, row);
  }

  const statements: D1Statement[] = [];
  for (const obs of chunk) {
    const candidate = listingFromObservation(obs);
    const existing = bySku.get(obs.source_sku);
    if (!existing) {
      statements.push({
        sql: INSERT_LISTINGS_SQL,
        params: [
          obs.source,
          obs.source_sku,
          candidate.currency,
          candidate.name,
          candidate.brand,
          candidate.size_value,
          candidate.size_unit,
          candidate.gtins,
        ],
      });
      continue;
    }
    if (listingsMatch(existing, candidate)) continue;
    statements.push({
      sql: UPDATE_LISTINGS_SQL,
      params: [
        candidate.currency,
        candidate.name,
        candidate.brand,
        candidate.size_value,
        candidate.size_unit,
        candidate.gtins,
        obs.source,
        obs.source_sku,
      ],
    });
  }
  return statements;
}