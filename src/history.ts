/**
 * /v1/history, /v1/products, /v1/listings Cloudflare Worker handler.
 *
 * Public read endpoints, bearer-protected write endpoints. Cloudflare
 * Worker in front of D1.
 *
 *   GET  /v1/history?source=rema&sku=21464
 *   GET  /v1/history?source=rema&sku=21464&sort=newest-first
 *
 *   GET  /v1/products?q=
 *   GET  /v1/products/:id
 *   POST /v1/products           { "label": "..." }            — auth
 *   POST /v1/products/:id/slots { "source": "...", "source_sku": "..." }  — auth
 *   DELETE /v1/products/:id/slots/:source                      — auth
 *
 *   GET  /v1/listings?source=&q=
 *
 * Behaviour (SII-99 + SII-129):
 *   - `sku` query param maps to the `source_sku` column.
 *   - Default sort: oldest first (ascending `observed_at`).
 *   - `sort=newest-first` reverses the array.
 *   - Any other `sort` value: ignored, default order is returned.
 *   - 404 if `(source, source_sku)` is unknown. No fuzzy matching, no
 *     cross-source joins.
 *   - JSON responses are UTF-8 and `cache-control: no-store`.
 *   - `POST` and `DELETE` require `Authorization: Bearer <token>` and
 *     a matching `PRISKURVEN_API_TOKEN` Worker env var. Missing env,
 *     missing header, or mismatch returns 401.
 *   - `GET` routes stay public.
 *
 * The D1 binding is `env.DB`. The Worker is named `priskurven` and the
 * bound database is `priskurven` (see `wrangler.toml`). No migrations
 * directory is declared here — migrations live in homelab (SII-109).
 *
 * SII-118: the table is now the single `observations` table. The
 * legacy `observations_v2` union was removed. `source` and
 * `source_sku` are bound once each.
 *
 * SII-129: products, product_slots, and listings come from migration
 * `0004_listings_products_slots.sql` (homelab). This Worker is the
 * only consumer of `products` and `product_slots`; `src/fill-slots.ts`
 * (SII-131) writes into `product_slots`; the collector (SII-130)
 * writes into `listings`. The Worker does not import those modules.
 *
 * Auth uses a manual constant-time string compare. Cloudflare Workers
 * do not expose `node:crypto` (no `nodejs_compat` flag in
 * `wrangler.toml`) and Web Crypto does not ship a constant-time
 * helper. The compare iterates the full length, OR-ing the xor of
 * each byte, so the time taken does not depend on the position of
 * the first mismatch.
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

/** Row shape returned by `D1PreparedStatement.all<T>()` for the
 *  `observations` SELECT in SII-99. */
type D1Row = {
  observed_at: string;
  price: number;
};

/** Worker environment contract. `DB` is required for read routes;
 *  `PRISKURVEN_API_TOKEN` is optional so tests can omit it; in
 *  production it is set via `wrangler secret put` (SII-132). It must
 *  never be committed in a file (SII-129 + SII-132). */
export interface Env {
  DB: D1Database;
  PRISKURVEN_API_TOKEN?: string;
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

/** 404 body shape (pinned by SII-99 + SII-129). */
function notFound(source?: string, sku?: string): Response {
  if (source !== undefined && sku !== undefined) {
    return jsonResponse(404, { error: 'not_found', source, sku });
  }
  return jsonResponse(404, { error: 'not_found' });
}

/** 400 body shape for malformed queries. */
function badRequest(message: string): Response {
  return jsonResponse(400, { error: 'bad_request', message });
}

/** 401 body shape for unauthenticated writes. */
function unauthorized(): Response {
  return jsonResponse(401, { error: 'unauthorized' });
}

/** 409 body shape for slot conflicts. */
function conflict(message: string): Response {
  return jsonResponse(409, { error: 'conflict', message });
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

/** Constant-time compare two equal-length strings. Returns `false`
 *  when lengths differ so we do not leak length information. */
function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Read `Authorization: Bearer <token>` and compare with the env
 *  secret. Returns true on match. A missing env, a missing header, or
 *  a mismatch returns false. */
function authorize(request: Request, env: Env): boolean {
  const expected = env.PRISKURVEN_API_TOKEN;
  if (!expected || expected.length === 0) return false;
  const header = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length).trim();
  if (presented.length === 0) return false;
  return safeStringEqual(presented, expected);
}

/** Fixed store list, in the order SII-129 pins. */
const STORES: readonly string[] = [
  'rema',
  'minkobmand',
  'spar',
  'netto',
  'bilkatogo',
  'fotex',
  'lidl',
  'nemlig',
];

/** A store entry in the `GET /v1/products/:id` response. */
type StoreEntry =
  | {
      source: string;
      source_sku: null;
      matched_by: null;
      prices: [];
    }
  | {
      source: string;
      source_sku: string;
      matched_by: 'manual' | 'ean';
      prices: Observation[];
    };

/** Product row from the `products` table. */
type ProductRow = { id: number; label: string };

/** Slot row joined with the listing fields the API returns. */
type SlotRow = {
  source: string;
  source_sku: string;
  matched_by: 'manual' | 'ean';
};

/** Listings row used by `GET /v1/listings`. */
type ListingRow = {
  source_sku: string;
  name: string | null;
  brand: string | null;
  size_value: number | null;
  size_unit: string | null;
  gtins: string;
};

/** Trim and require non-empty. */
function trimLabel(raw: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const value = raw.trim();
  if (value.length === 0) return { ok: false };
  return { ok: true, value };
}

/** Parse a JSON body. Returns `{ ok: true, value }` or a 400 Response. */
async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; res: Response }> {
  const text = await request.text();
  if (text.length === 0) {
    return { ok: false, res: badRequest('body is required') };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, res: badRequest('body must be a JSON object') };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, res: badRequest('body is not valid JSON') };
  }
}

/** Run one parameterised statement and return its rows. */
async function queryAll<T>(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const stmt: D1PreparedStatement = db.prepare(sql).bind(...params);
  const result = await stmt.all<T>();
  return result.results ?? [];
}

/** Run one parameterised write (INSERT/DELETE). The D1 REST API does
 *  not return a meaningful `meta` for `run()` from the Worker's
 *  binding, but the call still has to happen so the SQL reaches D1. */
async function execWrite(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<void> {
  await db.prepare(sql).bind(...params).run();
}

/** `POST /v1/products` — create a product. */
async function handleCreateProduct(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!authorize(request, env)) return unauthorized();
  const body = await readJsonBody(request);
  if (!body.ok) return body.res;
  const trimmed = trimLabel(body.value.label);
  if (!trimmed.ok) return badRequest('label is required');
  const row = await queryAll<ProductRow>(
    env.DB,
    'INSERT INTO products (label) VALUES (?) RETURNING id, label',
    [trimmed.value],
  );
  const created = row[0];
  if (!created) return badRequest('insert failed');
  return jsonResponse(201, { id: created.id, label: created.label });
}

/** `GET /v1/products?q=` — list products. */
async function handleListProducts(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') ?? '';
  if (q.length === 0) {
    const rows = await queryAll<ProductRow>(
      env.DB,
      'SELECT id, label FROM products ORDER BY id ASC',
    );
    return jsonResponse(200, { products: rows });
  }
  // SQL `lower()` folds `Æ` to `Æ` on D1 (the issue spec calls this
  // out). Pull every product and filter in JavaScript so the fold is
  // consistent with `GET /v1/listings` and with `Æ` → `æ`.
  const rows = await queryAll<ProductRow>(
    env.DB,
    'SELECT id, label FROM products',
  );
  const needle = q.toLowerCase();
  const filtered = rows.filter((r) => r.label.toLowerCase().includes(needle));
  return jsonResponse(200, { products: filtered });
}

/** Build one store entry. `slot` is null when the slot is empty. */
function emptyStoreEntry(source: string): StoreEntry {
  return { source, source_sku: null, matched_by: null, prices: [] };
}

/** `GET /v1/products/:id` — read one product with eight store entries. */
async function handleGetProduct(
  id: number,
  env: Env,
): Promise<Response> {
  const rows = await queryAll<ProductRow>(
    env.DB,
    'SELECT id, label FROM products WHERE id = ?',
    [id],
  );
  const product = rows[0];
  if (!product) return notFound();

  const slotRows = await queryAll<SlotRow>(
    env.DB,
    'SELECT source, source_sku, matched_by ' +
      'FROM product_slots WHERE product_id = ?',
    [id],
  );

  const filled: Record<string, SlotRow> = {};
  for (const s of slotRows) filled[s.source] = s;

  const stores: StoreEntry[] = [];
  for (const source of STORES) {
    const slot = filled[source];
    if (!slot) {
      stores.push(emptyStoreEntry(source));
      continue;
    }
    const priceRows = await fetchObservations(env.DB, slot.source, slot.source_sku);
    const prices: Observation[] = priceRows.map((r) => ({
      observed_at: r.observed_at,
      price: r.price,
    }));
    stores.push({
      source,
      source_sku: slot.source_sku,
      matched_by: slot.matched_by,
      prices,
    });
  }
  return jsonResponse(200, { id: product.id, label: product.label, stores });
}

/** `GET /v1/listings?source=&q=` — search listings in one source. */
async function handleListListings(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const source = url.searchParams.get('source') ?? '';
  const q = url.searchParams.get('q') ?? '';
  if (source.length === 0) return badRequest('source is required');
  if (!STORES.includes(source)) {
    return badRequest('source must be one of: ' + STORES.join(', '));
  }
  if (q.length === 0) return badRequest('q is required');

  const rows = await queryAll<ListingRow>(
    env.DB,
    'SELECT source_sku, name, brand, size_value, size_unit, gtins ' +
      'FROM listings WHERE source = ?',
    [source],
  );
  const needle = q.toLowerCase();
  const matches = rows
    .filter((r) => (r.name ?? '').toLowerCase().includes(needle))
    .sort((a, b) => {
      const an = a.name ?? '';
      const bn = b.name ?? '';
      if (an < bn) return -1;
      if (an > bn) return 1;
      if (a.source_sku < b.source_sku) return -1;
      if (a.source_sku > b.source_sku) return 1;
      return 0;
    })
    .slice(0, 50);

  // For each match, fetch the latest observation's `price`.
  const listings: Array<{
    source_sku: string;
    name: string | null;
    brand: string | null;
    size_value: number | null;
    size_unit: string | null;
    price: number | null;
  }> = [];
  for (const row of matches) {
    const obs = await queryAll<{ price: number }>(
      env.DB,
      'SELECT price FROM observations ' +
        'WHERE source = ? AND source_sku = ? ' +
        'ORDER BY observed_at DESC LIMIT 1',
      [source, row.source_sku],
    );
    const first = obs[0];
    listings.push({
      source_sku: row.source_sku,
      name: row.name,
      brand: row.brand,
      size_value: row.size_value,
      size_unit: row.size_unit,
      price: first ? first.price : null,
    });
  }
  return jsonResponse(200, { listings });
}

/** `POST /v1/products/:id/slots` — set an empty slot manually. */
async function handleSetSlot(
  id: number,
  request: Request,
  env: Env,
): Promise<Response> {
  if (!authorize(request, env)) return unauthorized();
  const body = await readJsonBody(request);
  if (!body.ok) return body.res;
  const source = body.value.source;
  const sourceSku = body.value.source_sku;
  if (typeof source !== 'string' || source.length === 0) {
    return badRequest('source is required');
  }
  if (typeof sourceSku !== 'string' || sourceSku.length === 0) {
    return badRequest('source_sku is required');
  }
  if (!STORES.includes(source)) {
    return badRequest('source must be one of: ' + STORES.join(', '));
  }

  // 1. product must exist
  const products = await queryAll<{ id: number }>(
    env.DB,
    'SELECT id FROM products WHERE id = ?',
    [id],
  );
  if (products.length === 0) return notFound();

  // 2. listing must exist for that (source, source_sku)
  const listings = await queryAll<{ source_sku: string }>(
    env.DB,
    'SELECT source_sku FROM listings WHERE source = ? AND source_sku = ?',
    [source, sourceSku],
  );
  if (listings.length === 0) return notFound();

  // 3. slot must not be filled
  const existingSlots = await queryAll<{ source: string }>(
    env.DB,
    'SELECT source FROM product_slots WHERE product_id = ? AND source = ?',
    [id, source],
  );
  if (existingSlots.length > 0) return conflict('slot is filled');

  // 4. the (source, source_sku) must not be on another product
  const otherSlot = await queryAll<{ product_id: number }>(
    env.DB,
    'SELECT product_id FROM product_slots WHERE source = ? AND source_sku = ?',
    [source, sourceSku],
  );
  if (otherSlot.length > 0) {
    return conflict('listing is on another product');
  }

  await execWrite(
    env.DB,
    'INSERT INTO product_slots (product_id, source, source_sku, matched_by) ' +
      'VALUES (?, ?, ?, ?)',
    [id, source, sourceSku, 'manual'],
  );
  return jsonResponse(201, { source, source_sku: sourceSku, matched_by: 'manual' });
}

/** `DELETE /v1/products/:id/slots/:source` — clear a slot. */
async function handleClearSlot(
  id: number,
  source: string,
  request: Request,
  env: Env,
): Promise<Response> {
  if (!authorize(request, env)) return unauthorized();
  if (!STORES.includes(source)) {
    return badRequest('source must be one of: ' + STORES.join(', '));
  }
  const products = await queryAll<{ id: number }>(
    env.DB,
    'SELECT id FROM products WHERE id = ?',
    [id],
  );
  if (products.length === 0) return notFound();
  const slots = await queryAll<{ source: string }>(
    env.DB,
    'SELECT source FROM product_slots WHERE product_id = ? AND source = ?',
    [id, source],
  );
  if (slots.length === 0) return notFound();
  await execWrite(
    env.DB,
    'DELETE FROM product_slots WHERE product_id = ? AND source = ?',
    [id, source],
  );
  return new Response(null, { status: 204, headers: { ...RESPONSE_HEADERS } });
}

/** Match `/v1/products/:id` with a numeric id. Returns the parsed id
 *  or null when the path is malformed. */
function matchProductId(path: string): number | null {
  const prefix = '/v1/products/';
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.length === 0) return null;
  // Reject anything that is not a bare positive integer — guards
  // against `/v1/products/123/slots` being mis-routed here.
  if (rest.includes('/')) return null;
  if (!/^[0-9]+$/.test(rest)) return null;
  const n = Number.parseInt(rest, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Match `/v1/products/:id/slots`. Returns `{ id }` or null. */
function matchProductIdSlots(path: string): { id: number } | null {
  const prefix = '/v1/products/';
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!rest.endsWith('/slots')) return null;
  const idText = rest.slice(0, rest.length - '/slots'.length);
  if (idText.length === 0 || idText.includes('/')) return null;
  if (!/^[0-9]+$/.test(idText)) return null;
  const n = Number.parseInt(idText, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { id: n };
}

/** Match `/v1/products/:id/slots/:source`. */
function matchProductIdSlotSource(
  path: string,
): { id: number; source: string } | null {
  const prefix = '/v1/products/';
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const slotMarker = '/slots/';
  const idx = rest.indexOf(slotMarker);
  if (idx < 0) return null;
  const idText = rest.slice(0, idx);
  const source = rest.slice(idx + slotMarker.length);
  if (idText.length === 0 || source.length === 0) return null;
  if (source.includes('/')) return null;
  if (!/^[0-9]+$/.test(idText)) return null;
  const n = Number.parseInt(idText, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { id: n, source };
}

/**
 * Route guard + handler. Public GET routes:
 *   GET  /v1/history
 *   GET  /v1/products
 *   GET  /v1/products/:id
 *   GET  /v1/listings
 * Authenticated write routes:
 *   POST   /v1/products
 *   POST   /v1/products/:id/slots
 *   DELETE /v1/products/:id/slots/:source
 * Other paths: 404. Wrong method on a known path: 405.
 * `ctx` is unused in M1/M2 but kept in the signature for future
 * `waitUntil` use (e.g. SII-103 logging).
 */
export async function fetch(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // `/v1/history`
  if (path === '/v1/history') {
    if (method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' });
    const source = url.searchParams.get('source') ?? '';
    const sku = url.searchParams.get('sku') ?? '';
    if (source.length === 0) return badRequest('source is required');
    if (sku.length === 0) return badRequest('sku is required');
    const sort = url.searchParams.get('sort');
    const newestFirst = sort === 'newest-first';
    const rows = await fetchObservations(env.DB, source, sku);
    if (rows.length === 0) return notFound(source, sku);
    const observations: Observation[] = rows.map((row) => ({
      observed_at: row.observed_at,
      price: row.price,
    }));
    if (newestFirst) observations.reverse();
    return jsonResponse(200, { source, sku, observations });
  }

  // `/v1/listings`
  if (path === '/v1/listings') {
    if (method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' });
    return handleListListings(request, env);
  }

  // `/v1/products`
  if (path === '/v1/products') {
    if (method === 'POST') return handleCreateProduct(request, env);
    if (method === 'GET') return handleListProducts(request, env);
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  // `/v1/products/:id` (read-only)
  const productId = matchProductId(path);
  if (productId !== null && path === `/v1/products/${productId}`) {
    if (method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' });
    return handleGetProduct(productId, env);
  }

  // `/v1/products/:id/slots/:source` (DELETE)
  const slotDelete = matchProductIdSlotSource(path);
  if (slotDelete !== null) {
    if (method !== 'DELETE') return jsonResponse(405, { error: 'method_not_allowed' });
    return handleClearSlot(slotDelete.id, slotDelete.source, request, env);
  }

  // `/v1/products/:id/slots` (POST)
  const slotSet = matchProductIdSlots(path);
  if (slotSet !== null) {
    if (method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });
    return handleSetSlot(slotSet.id, request, env);
  }

  return jsonResponse(404, { error: 'not_found' });
}

export default { fetch };