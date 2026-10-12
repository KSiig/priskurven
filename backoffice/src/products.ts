/**
 * Backoffice product page.
 *
 * Owns three pages under `/products/...`:
 *   - `GET  /products`                 — search box + list of products
 *   - `GET  /products/:id`             — one product, eight store slots,
 *                                        and the listing-search form
 *                                        for each empty slot
 *   - `POST /products/:id/slots`       — attach a listing
 *   - `POST /products/:id/slots/clear` — clear a filled slot
 *
 * Reads of products go through `listProducts` / `getProduct` in
 * `./api.ts`. Writes go through `setSlot` / `clearSlot` in the same
 * file. The listing-search result does NOT call `GET /v1/listings`
 * on the public Worker — that route returns at most 50 rows; this
 * page needs the full set for the source, so it reads D1 directly
 * through `env.DB`.
 *
 * Listing-search rules (per the SII-138 spec):
 *   - Reject a `source` that is not in `STORE_ORDER`.
 *   - A blank `q` yields no matches.
 *   - SQL has no name filter: `SELECT source_sku, name, brand,
 *     size_value, size_unit FROM listings WHERE source = ?`. The
 *     filter is applied in JavaScript so `toLowerCase()` folds
 *     `Æ` → `æ` (D1's `lower('MINIMÆLK')` returns `minimÆlk`).
 *   - Sort by name (nulls last via `?? ''` collating to the empty
 *     string), then `source_sku` as a stable tiebreak. Cap at 50
 *     after the sort.
 *   - For each match, the price is the latest observation:
 *     `SELECT price FROM observations WHERE source = ? AND
 *     source_sku = ? ORDER BY observed_at DESC LIMIT 1`. No row
 *     means no price.
 *
 * This file does NOT import `./approval.ts`; that import lives in
 * `index.ts` and is owned by SII-141.
 */

import type { D1Database } from "@cloudflare/workers-types";

import {
  clearSlot,
  getProduct,
  listProducts,
  setSlot,
  type StoreSlot,
} from "./api";
import { escapeHtml } from "./html";

/**
 * Fixed store order, pinned by the SII-138 spec. Used both for
 * rendering the product page (eight blocks in this order) and for
 * validating the `source` query parameter on the listing-search
 * form.
 */
const STORE_ORDER: readonly string[] = [
  "rema",
  "minkobmand",
  "spar",
  "netto",
  "bilkatogo",
  "fotex",
  "lidl",
  "nemlig",
];

/**
 * Env shape this module needs. The D1 binding is read directly for
 * listing search; the API client (`./api.ts`) is read for products
 * and slots. `PRISKURVEN_API_TOKEN` is forwarded into the API client
 * by way of `env` — it is optional and the client short-circuits to
 * `missing_token` when it is absent.
 *
 * Larger `Env` shapes in other modules (`index.ts`, `approval.ts`)
 * extend this with the Access identity or the secret store; we only
 * need what we touch.
 */
export type Env = {
  DB: D1Database;
  PRISKURVEN_API_TOKEN?: string;
};

/** Row from `listings` for one source. `name` and `brand` can be
 *  null because the public API allows nulls on those columns. */
type ListingRow = {
  source_sku: string;
  name: string | null;
  brand: string | null;
  size_value: number | null;
  size_unit: string | null;
};

/** Listing-search result: a listing row joined with the latest
 *  observation's `price`. `price` is null when no observation
 *  exists for the (source, source_sku) pair. */
type ListingMatch = ListingRow & { price: number | null };

/**
 * Worker fetch handler for `/products/...`. Dispatch is by method
 * and pathname. Any unmatched subpath returns 404 `not_found`; the
 * index.ts gate only sends `/products` and `/products/...` here, so
 * this 404 covers paths like `/products/abc` and
 * `/products/1/slots/other`.
 *
 * The signature is `(request, env)` because the Access check runs
 * in `index.ts` before this handler is reached, so this surface
 * never needs the `ctx` (no `waitUntil`, no Access identity, no
 * background work).
 */
export async function handleProducts(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/products") {
    return renderProductsList(request, env);
  }

  const productMatch = pathname.match(/^\/products\/(\d+)$/);
  if (productMatch && method === "GET") {
    return renderProductDetail(request, env, parseInt(productMatch[1]!, 10), url);
  }

  const slotsMatch = pathname.match(/^\/products\/(\d+)\/slots$/);
  if (slotsMatch && method === "POST") {
    return postSlot(request, env, parseInt(slotsMatch[1]!, 10));
  }

  const clearMatch = pathname.match(/^\/products\/(\d+)\/slots\/clear$/);
  if (clearMatch && method === "POST") {
    return postClear(request, env, parseInt(clearMatch[1]!, 10));
  }

  return new Response("not_found", { status: 404 });
}

/* ------------------------------------------------------------------ *
 * GET /products
 * ------------------------------------------------------------------ */

/**
 * Render the product search page. The form is GET on `/products`
 * with a `q` input. The same handler handles both the bare page
 * (empty `q`, lists all products) and the searched page (`q=...`,
 * lists the filtered set).
 *
 * `listProducts` returns `ok: true` with `{ products: ... }` on a
 * 200 and `ok: false` with `{ status, error, message }` on anything
 * else (including 401/500). On the failure path the page renders
 * the status and the message so the operator can see what went
 * wrong (no upstream 401, no D1 connect failure, etc.).
 */
async function renderProductsList(
  request: Request,
  env: Env,
): Promise<Response> {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const result = await listProducts(env, q);
  const body = result.ok
    ? renderProductsListOk(q, result.body.products)
    : renderProductsListErr(result.status, result.message);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Render the success page: search form + anchor list. */
function renderProductsListOk(
  q: string,
  products: ReadonlyArray<{ id: number; label: string }>,
): string {
  const safeQ = escapeHtml(q);
  const rows = products.length === 0
    ? "<p>No products.</p>"
    : "<ul>" +
      products
        .map(
          (p) =>
            `<li><a href="/products/${p.id}">${p.id} — ${escapeHtml(p.label)}</a></li>`,
        )
        .join("") +
      "</ul>";
  return pageShell(
    "Products",
    `
<form method="get" action="/products">
  <input name="q" value="${safeQ}">
  <button type="submit">Search</button>
</form>
${rows}
`,
  );
}

/** Render the failure page: search form + the status and message. */
function renderProductsListErr(status: number, message: string): string {
  const safeMessage = escapeHtml(message);
  return pageShell(
    "Products",
    `
<form method="get" action="/products">
  <input name="q">
  <button type="submit">Search</button>
</form>
<p>Error: ${status} ${safeMessage}</p>
`,
  );
}

/* ------------------------------------------------------------------ *
 * GET /products/:id
 * ------------------------------------------------------------------ */

/**
 * Render the product detail page. The handler reads `getProduct` and
 * either renders the eight store blocks (in `STORE_ORDER`) or shows
 * the 404 body.
 *
 * The same URL also doubles as the listing-search submit target:
 * each empty slot's form is `method="get" action="/products/<id>"`
 * with a hidden `source` and a text `q`. When the request URL has
 * `?source=<store>&q=<term>` we run `searchListings` and inject the
 * matches under the matching store block.
 */
async function renderProductDetail(
  _request: Request,
  env: Env,
  id: number,
  url: URL,
): Promise<Response> {
  const result = await getProduct(env, id);
  if (!result.ok) {
    if (result.error === "not_found") {
      return new Response("not_found", { status: 404 });
    }
    // Non-404 failure: render the error page so the operator can see
    // what went wrong (401, 500, network).
    return new Response(
      pageShell(
        "Product",
        `<p>Error: ${result.status} ${escapeHtml(result.message)}</p>`,
      ),
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }

  const { label, stores } = result.body;

  // Listing search query: ?source=<store>&q=<term>. Validate source
  // against STORE_ORDER; blank q → empty matches.
  const searchSource = url.searchParams.get("source") ?? "";
  const searchQ = url.searchParams.get("q") ?? "";
  let matches: ListingMatch[] = [];
  if (searchSource.length > 0 && searchQ.length > 0) {
    if (STORE_ORDER.includes(searchSource)) {
      matches = await searchListings(env, searchSource, searchQ);
    }
    // Unknown source or blank q → no matches (the spec is explicit
    // about both cases). We deliberately do not call D1 in that
    // case.
  }

  const body = pageShell(
    `Product ${id}`,
    renderProductBlocks(id, label, stores, searchSource, searchQ, matches),
  );
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Render the product detail body: the label, a back link, and one
 *  block per store in `STORE_ORDER`. */
function renderProductBlocks(
  id: number,
  label: string,
  stores: ReadonlyArray<StoreSlot>,
  searchSource: string,
  searchQ: string,
  matches: ReadonlyArray<ListingMatch>,
): string {
  const safeLabel = escapeHtml(label);
  const blocks = STORE_ORDER.map((source) => {
    const slot = stores.find((s) => s.source === source);
    return renderStoreBlock(id, source, slot, searchSource, searchQ, matches);
  }).join("");

  return `
<p><a href="/products">Back</a></p>
<h2>${safeLabel}</h2>
${blocks}
`;
}

/** Render one store block. The shape depends on whether the slot is
 *  filled or empty. When the listing search is active for this
 *  source, the matches are injected under the block. */
function renderStoreBlock(
  id: number,
  source: string,
  slot: StoreSlot | undefined,
  searchSource: string,
  searchQ: string,
  matches: ReadonlyArray<ListingMatch>,
): string {
  const isFilled = slot !== undefined && slot.source_sku !== null;
  const heading = `<h3>${source}</h3>`;

  if (isFilled) {
    // `slot.source_sku`, `slot.matched_by`, and the latest price are
    // guaranteed by the API shape (StoreSlot). The public API
    // returns prices in ascending `observed_at` order so the last
    // element is the latest. An empty `prices` array (which the API
    // does not produce for a filled slot, but defensively) shows no
    // price line.
    const safeSku = escapeHtml(slot!.source_sku ?? "");
    const matchedBy = slot!.matched_by ?? "";
    const prices = slot!.prices ?? [];
    const last = prices.length > 0 ? prices[prices.length - 1] : undefined;
    const priceLine =
      last !== undefined
        ? `<p>Price: ${escapeHtml(String(last.price))}</p>`
        : "";
    return `
<section>
${heading}
<p>Source SKU: ${safeSku}</p>
<p>Matched by: ${escapeHtml(matchedBy)}</p>
${priceLine}
<form method="post" action="/products/${id}/slots/clear">
  <input type="hidden" name="source" value="${source}">
  <button type="submit">Clear</button>
</form>
</section>
`;
  }

  // Empty slot: the form is GET on /products/<id> so submitting it
  // re-renders this same page with ?source=<store>&q=<term>.
  const safeQ = escapeHtml(searchQ);
  const searchMatches =
    searchSource === source
      ? renderListingMatches(id, source, searchQ, matches)
      : "";
  return `
<section>
${heading}
<form method="get" action="/products/${id}">
  <input type="hidden" name="source" value="${source}">
  <input name="q" value="${safeQ}">
  <button type="submit">Search</button>
</form>
${searchMatches}
</section>
`;
}

/** Render the listing matches for one store. Null fields are
 *  omitted. Each match gets an Attach form whose hidden inputs
 *  carry the source and source_sku. */
function renderListingMatches(
  id: number,
  source: string,
  q: string,
  matches: ReadonlyArray<ListingMatch>,
): string {
  if (q.length === 0) return "";
  if (matches.length === 0) {
    return `<p>No matches for ${escapeHtml(q)}.</p>`;
  }
  const items = matches
    .map((m) => {
      const fields: string[] = [`SKU: ${escapeHtml(m.source_sku)}`];
      if (m.name !== null) fields.push(`Name: ${escapeHtml(m.name)}`);
      if (m.brand !== null) fields.push(`Brand: ${escapeHtml(m.brand)}`);
      if (m.size_value !== null) {
        const sizeUnit = m.size_unit ?? "";
        fields.push(`Size: ${m.size_value}${sizeUnit.length > 0 ? " " + escapeHtml(sizeUnit) : ""}`);
      }
      if (m.price !== null) fields.push(`Price: ${m.price}`);
      return `
<form method="post" action="/products/${id}/slots">
  <input type="hidden" name="source" value="${source}">
  <input type="hidden" name="source_sku" value="${escapeHtml(m.source_sku)}">
  <p>${fields.join(" | ")}</p>
  <button type="submit">Attach</button>
  <span>This writes matched_by manual. The GTIN filler will not replace a manual slot.</span>
</form>
`;
    })
    .join("");
  return items;
}

/* ------------------------------------------------------------------ *
 * Listing search (D1 read-through)
 * ------------------------------------------------------------------ */

/**
 * Read every listing for `source` from D1, filter by `q` in
 * JavaScript, sort by `(name, source_sku)`, cap at 50, and join the
 * latest observation's price. The D1 read uses no SQL-level
 * name filter (the spec is explicit about that) so `toLowerCase()`
 * folds `Æ` → `æ` consistently with the public API.
 */
async function searchListings(
  env: Env,
  source: string,
  q: string,
): Promise<ListingMatch[]> {
  const needle = q.toLowerCase();
  const listingsStmt = env.DB
    .prepare(
      "SELECT source_sku, name, brand, size_value, size_unit " +
        "FROM listings WHERE source = ?",
    )
    .bind(source);
  const listingsResult = await listingsStmt.all<ListingRow>();
  const rows = listingsResult.results ?? [];

  const filtered = rows
    .filter((r) => String(r.name ?? "").toLowerCase().includes(needle))
    .sort((a, b) => {
      const an = a.name ?? "";
      const bn = b.name ?? "";
      if (an < bn) return -1;
      if (an > bn) return 1;
      if (a.source_sku < b.source_sku) return -1;
      if (a.source_sku > b.source_sku) return 1;
      return 0;
    })
    .slice(0, 50);

  const matches: ListingMatch[] = [];
  for (const row of filtered) {
    const priceStmt = env.DB
      .prepare(
        "SELECT price FROM observations " +
          "WHERE source = ? AND source_sku = ? " +
          "ORDER BY observed_at DESC LIMIT 1",
      )
      .bind(source, row.source_sku);
    const priceResult = await priceStmt.all<{ price: number }>();
    const first = priceResult.results?.[0];
    matches.push({
      source_sku: row.source_sku,
      name: row.name,
      brand: row.brand,
      size_value: row.size_value,
      size_unit: row.size_unit,
      price: first ? first.price : null,
    });
  }
  return matches;
}

/* ------------------------------------------------------------------ *
 * POST /products/:id/slots
 * ------------------------------------------------------------------ */

/**
 * Read `source` and `source_sku` from the form, call `setSlot`, and
 * redirect on 201. Anything else (including 409 conflicts and a
 * `missing_token` short-circuit) renders an HTML page that contains
 * the upstream message. The 303 redirect uses the standard
 * `Location` header; the body is empty per HTTP semantics.
 */
async function postSlot(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  const form = await readForm(request);
  if (!form.ok) {
    return htmlErrorPage(id, 400, form.message);
  }
  const source = form.value.source;
  const sourceSku = form.value.source_sku;
  if (source.length === 0) {
    return htmlErrorPage(id, 400, "source is required");
  }
  if (sourceSku.length === 0) {
    return htmlErrorPage(id, 400, "source_sku is required");
  }
  if (!STORE_ORDER.includes(source)) {
    return htmlErrorPage(id, 400, "source must be one of: " + STORE_ORDER.join(", "));
  }

  const result = await setSlot(env, id, source, sourceSku);
  if (result.ok) {
    return new Response(null, {
      status: 303,
      headers: { location: `/products/${id}` },
    });
  }
  return htmlErrorPage(id, result.status, result.message);
}

/* ------------------------------------------------------------------ *
 * POST /products/:id/slots/clear
 * ------------------------------------------------------------------ */

/**
 * Read `source` from the form, call `clearSlot`, and redirect on
 * 204. Anything else renders an HTML page that contains the
 * upstream message. The clear endpoint only carries `source` (not
 * `source_sku`); the API extracts the source from the URL.
 */
async function postClear(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  const form = await readForm(request);
  if (!form.ok) {
    return htmlErrorPage(id, 400, form.message);
  }
  const source = form.value.source;
  if (source.length === 0) {
    return htmlErrorPage(id, 400, "source is required");
  }
  if (!STORE_ORDER.includes(source)) {
    return htmlErrorPage(id, 400, "source must be one of: " + STORE_ORDER.join(", "));
  }

  const result = await clearSlot(env, id, source);
  if (result.ok) {
    return new Response(null, {
      status: 303,
      headers: { location: `/products/${id}` },
    });
  }
  return htmlErrorPage(id, result.status, result.message);
}

/* ------------------------------------------------------------------ *
 * Form parsing + error page helpers
 * ------------------------------------------------------------------ */

/** Result of reading a URL-encoded form body. */
type FormFields = { source: string; source_sku: string };

/** Try to read the request body as `application/x-www-form-urlencoded`
 *  and pull out the two fields we need. Any other content type or a
 *  body that is not a string is a 400. */
async function readForm(
  request: Request,
): Promise<{ ok: true; value: FormFields } | { ok: false; message: string }> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, message: "could not read body" };
  }
  const params = new URLSearchParams(text);
  const source = params.get("source") ?? "";
  const sourceSku = params.get("source_sku") ?? "";
  return { ok: true, value: { source, source_sku: sourceSku } };
}

/** Render a plain 200 HTML page with the error message inline so
 *  the operator can read what went wrong without leaving the
 *  product context. The status field is for display only — the
 *  HTTP status is 200 because the request itself was well-formed;
 *  the API just returned a non-2xx. */
function htmlErrorPage(id: number, status: number, message: string): Response {
  const safeMessage = escapeHtml(message);
  const body = pageShell(
    `Product ${id}`,
    `<p><a href="/products/${id}">Back</a></p>
<p>Error: ${status} ${safeMessage}</p>`,
  );
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/* ------------------------------------------------------------------ *
 * HTML shell
 * ------------------------------------------------------------------ */

/** Minimal page wrapper. The SII-137 shell on `/` has its own
 *  layout; per-page shells here keep the templates self-contained. */
function pageShell(title: string, body: string): string {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    `<h1>${escapeHtml(title)}</h1>`,
    body,
    "</body>",
    "</html>",
  ].join("");
}
