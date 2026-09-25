/**
 * /v1/history Cloudflare Worker handler.
 *
 * Public, no auth. Cloudflare Worker in front of D1.
 *
 *   GET /v1/history?source=rema&sku=21464
 *   GET /v1/history?source=rema&sku=21464&sort=newest-first
 *
 * Behaviour (SII-99 spec):
 *   - `sku` query param maps to the `source_sku` column.
 *   - Default sort: oldest first (ascending `observed_at`).
 *   - `sort=newest-first` reverses the array.
 *   - Any other `sort` value: ignored, default order is returned.
 *   - 404 if `(source, source_sku)` is unknown. No fuzzy matching, no
 *     cross-source joins.
 *   - JSON responses are UTF-8 and `cache-control: no-store`.
 *
 * The D1 binding is `env.DB`. The Worker is named `priskurven` and the
 * bound database is `priskurven` (see `wrangler.toml`). No migrations
 * directory is declared here — migrations live in homelab (SII-109).
 *
 * The {@link Observation} / {@link D1Row} / {@link Env} shapes are
 * inlined in this module because `src/types.ts` from SII-92 has not
 * landed on `main` yet. Once the parent assembles the M1 stack onto
 * `src/types.ts`, the duplicated definitions can be removed and
 * imported from there.
 */

import type {
  D1Database,
  D1PreparedStatement,
  ExecutionContext,
} from '@cloudflare/workers-types';

/** A single observation in the JSON response. */
export type Observation = {
  observed_at: string;
  price: number;
};

/** Row shape returned by `D1PreparedStatement.all<T>()` for this query. */
type D1Row = {
  observed_at: string;
  price: number;
};

/** Worker environment contract — only `DB` is required for SII-99. */
export interface Env {
  DB: D1Database;
}

/** Fixed response headers. JSON, no cache, CORS-open for the public API. */
const RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
});

/** Build a JSON response with the standard headers. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...RESPONSE_HEADERS },
  });
}

/** 404 body shape (pinned by SII-99). */
function notFound(source: string, sku: string): Response {
  return jsonResponse(404, { error: 'not_found', source, sku });
}

/** 400 body shape for malformed queries. The spec does not pin 400; we
 *  return it so a missing param never silently 200s with junk rows. */
function badRequest(message: string): Response {
  return jsonResponse(400, { error: 'bad_request', message });
}

/**
 * Fetch the rows for one (source, source_sku) pair, oldest first.
 * Empty result means the pair is unknown — the caller maps that to 404.
 */
async function fetchObservations(
  db: D1Database,
  source: string,
  sku: string,
): Promise<D1Row[]> {
  const stmt: D1PreparedStatement = db
    .prepare(
      'SELECT observed_at, price FROM observations ' +
        'WHERE source = ? AND source_sku = ? ' +
        'ORDER BY observed_at ASC',
    )
    .bind(source, sku);
  const result = await stmt.all<D1Row>();
  return result.results ?? [];
}

/**
 * Route guard + handler. Any non-`/v1/history` path returns 404; any
 * non-GET method returns 405. `ctx` is unused in M1 but kept in the
 * signature for future waitUntil use (e.g. SII-103 logging).
 */
export async function fetch(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/history') {
    return jsonResponse(404, { error: 'not_found' });
  }
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  const source = url.searchParams.get('source') ?? '';
  const sku = url.searchParams.get('sku') ?? '';
  if (source.length === 0) return badRequest('source is required');
  if (sku.length === 0) return badRequest('sku is required');

  const sort = url.searchParams.get('sort');
  const newestFirst = sort === 'newest-first';

  const rows = await fetchObservations(env.DB, source, sku);
  if (rows.length === 0) {
    return notFound(source, sku);
  }

  const observations: Observation[] = rows.map((row) => ({
    observed_at: row.observed_at,
    price: row.price,
  }));
  if (newestFirst) observations.reverse();

  return jsonResponse(200, { source, sku, observations });
}

export default { fetch };