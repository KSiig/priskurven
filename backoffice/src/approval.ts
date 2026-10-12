/**
 * Rema approval queue (SII-141).
 *
 * The queue is the list of rema listings that have no slot on any
 * product and are not on the skip list. The user can either:
 *
 *   - Approve a listing by typing a label and submitting the
 *     `/approval/approve` form. The handler calls
 *     `createProduct(env, label)` and then
 *     `setSlot(env, id, "rema", source_sku)` and bounces the user
 *     back to the queue.
 *   - Skip a listing by submitting `/approval/skip`. The handler
 *     `INSERT OR REPLACE`s into `review_skips` and bounces the
 *     user back to the queue.
 *
 * There is also a `/approval/skipped` page that lists the skipped
 * skus with an unskip control, and a `/approval/unskip` POST that
 * removes a skip.
 *
 * Routing:
 *
 *   - `GET  /approval`          — the queue page.
 *   - `POST /approval/approve`  — approve one listing.
 *   - `POST /approval/skip`     — skip one listing.
 *   - `GET  /approval/skipped`  — the skipped-list page.
 *   - `POST /approval/unskip`   — unskip one listing.
 *   - anything else             — 404 not_found.
 *
 * One approval is one product insert and one slot insert. The free
 * plan caps D1 at 100,000 rows written per UTC day; the 06:00
 * Europe/Copenhagen collect already writes on the order of the
 * full catalog. There is deliberately no batched approve-all.
 *
 * Every user-controlled value that flows into HTML — the listing
 * name, the user-typed label, the `source_sku` from the form, and
 * any upstream `message` from the public API — goes through
 * `escapeHtml` from `./html.ts` (SII-137) before it is spliced
 * into a string.
 */

import { createProduct, setSlot } from "./api";
import { escapeHtml } from "./html";

import type { Env } from "./index";

/** Source this queue is fixed to. The spec deliberately omits a
 *  source picker — other stores are attached from the product
 *  page (SII-138). */
const SOURCE = "rema";

/** How many rows the queue page shows at once. The spec's queue
 *  SQL terminates with `LIMIT 20`. */
const QUEUE_LIMIT = 20;

/** Row shape the queue SQL returns. `brand`, `size_value`, and
 *  `size_unit` can be NULL; the price lookup below fills in
 *  `price` separately. */
type ListingRow = {
  source_sku: string;
  name: string | null;
  brand: string | null;
  size_value: number | null;
  size_unit: string | null;
};

/** Same row with a price attached (or null when the observations
 *  table has no row for that sku). */
type QueueRow = ListingRow & { price: number | null };

/** A row on the skipped page. */
type SkippedRow = { source_sku: string; skipped_at: string };

/**
 * Top-level routing entry point. Mirrors the `handleApproval`
 * signature the SII-137 extension-point chain in `index.ts` calls.
 * The Access check is the caller's job; by the time we get here,
 * the request is authenticated.
 */
export async function handleApproval(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/approval" && method === "GET") {
    return pageQueue(env);
  }
  if (path === "/approval/approve" && method === "POST") {
    return handleApprove(request, env);
  }
  if (path === "/approval/skip" && method === "POST") {
    return handleSkip(request, env);
  }
  if (path === "/approval/skipped" && method === "GET") {
    return pageSkipped(env);
  }
  if (path === "/approval/unskip" && method === "POST") {
    return handleUnskip(request, env);
  }
  return new Response("not_found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Render the queue page.
 *
 * Runs the spec's queue SQL and, per row, the per-row price SQL.
 * No row means no price; the `price` column on the rendered row
 * is simply omitted in that case.
 */
async function pageQueue(env: Env): Promise<Response> {
  const rows = await fetchQueue(env);
  const html = renderQueuePage(rows);
  return htmlResponse(200, html);
}

/**
 * Fetch the queue rows from D1. The shape of the result is fixed
 * by the spec: `source_sku, name, brand, size_value, size_unit`
 * from `listings`, with the most recent price from `observations`
 * attached per row (or null when there is no observation).
 */
async function fetchQueue(env: Env): Promise<QueueRow[]> {
  const queueSql = [
    "SELECT source_sku, name, brand, size_value, size_unit",
    "FROM listings",
    "WHERE source = ?",
    "  AND NOT EXISTS (",
    "    SELECT 1 FROM product_slots AS s",
    "    WHERE s.source = listings.source",
    "      AND s.source_sku = listings.source_sku",
    "  )",
    "  AND NOT EXISTS (",
    "    SELECT 1 FROM review_skips AS k",
    "    WHERE k.source = listings.source",
    "      AND k.source_sku = listings.source_sku",
    "  )",
    "ORDER BY name, source_sku",
    "LIMIT ?",
  ].join(" ");
  const listingResult = await env.DB.prepare(queueSql)
    .bind(SOURCE, QUEUE_LIMIT)
    .all<ListingRow>();
  const listings = listingResult.results ?? [];
  const rows: QueueRow[] = [];
  for (const listing of listings) {
    const price = await fetchLatestPrice(env, listing.source_sku);
    rows.push({ ...listing, price });
  }
  return rows;
}

/**
 * Fetch the most recent observation price for one sku. Returns
 * `null` when there is no observation row at all.
 */
async function fetchLatestPrice(
  env: Env,
  sourceSku: string,
): Promise<number | null> {
  const priceSql = [
    "SELECT price FROM observations",
    "WHERE source = ? AND source_sku = ?",
    "ORDER BY observed_at DESC",
    "LIMIT 1",
  ].join(" ");
  const row = await env.DB.prepare(priceSql)
    .bind(SOURCE, sourceSku)
    .first<{ price: number }>();
  if (row === null) {
    return null;
  }
  return row.price;
}

/**
 * Render the queue page HTML. The shape is one `<section>` per
 * row with two sibling forms (Approve + Skip). Sibling forms are
 * required because HTML forbids nested forms.
 */
function renderQueuePage(rows: QueueRow[]): string {
  const body = rows.length === 0
    ? "<p>No listings to review.</p>"
    : rows.map(renderQueueRow).join("");
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<title>Approval queue — Rema</title>",
    "</head>",
    "<body>",
    "<h1>Approval queue — Rema</h1>",
    "<p>",
    "<a href=\"/approval/skipped\">Skipped</a>",
    "</p>",
    body,
    "</body>",
    "</html>",
  ].join("");
}

/**
 * Render one queue row. The heading is the (escaped) listing
 * name. Brand, size_value, size_unit, and price are shown when
 * they are not null. The two forms submit a hidden `source_sku`
 * each. The label input is a fresh empty text input — the spec
 * says do not prefill it.
 */
function renderQueueRow(row: QueueRow): string {
  const name = row.name === null ? "" : escapeHtml(row.name);
  const safeSku = escapeHtml(row.source_sku);
  const meta: string[] = [];
  if (row.brand !== null) {
    meta.push(`Brand: ${escapeHtml(row.brand)}`);
  }
  if (row.size_value !== null) {
    const unit = row.size_unit === null ? "" : ` ${escapeHtml(row.size_unit)}`;
    meta.push(`Size: ${row.size_value}${unit}`);
  }
  if (row.price !== null) {
    meta.push(`Price: ${row.price}`);
  }
  const metaLine = meta.length === 0
    ? ""
    : `<p>${meta.join(" | ")}</p>`;
  const heading = name.length > 0
    ? `<h2>${name}</h2>`
    : `<h2>${safeSku}</h2>`;
  return [
    "<section>",
    heading,
    metaLine,
    `<form method="post" action="/approval/approve">`,
    `<input type="hidden" name="source_sku" value="${safeSku}">`,
    `<input type="text" name="label" value="">`,
    `<button type="submit">Approve</button>`,
    `</form>`,
    `<form method="post" action="/approval/skip">`,
    `<input type="hidden" name="source_sku" value="${safeSku}">`,
    `<button type="submit">Skip</button>`,
    `</form>`,
    "</section>",
  ].join("");
}

/**
 * Handle the approve POST. Trims the label; an empty label short-
 * circuits to 200 HTML containing "label is required" and never
 * touches the public API. Otherwise it calls `createProduct` and
 * then `setSlot`, and maps the three outcomes (both ok, create
 * fails, slot fails) per the spec.
 */
async function handleApprove(
  request: Request,
  env: Env,
): Promise<Response> {
  const form = await request.formData();
  const rawLabel = form.get("label");
  const rawSku = form.get("source_sku");
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  const sourceSku = typeof rawSku === "string" ? rawSku : "";
  if (label.length === 0) {
    return htmlResponse(200, renderMessagePage("label is required"));
  }
  if (sourceSku.length === 0) {
    return htmlResponse(200, renderMessagePage("source_sku is required"));
  }
  const created = await createProduct(env, label);
  if (!created.ok) {
    return htmlResponse(200, renderMessagePage(created.message));
  }
  const productId = created.body.id;
  const slotted = await setSlot(env, productId, SOURCE, sourceSku);
  if (!slotted.ok) {
    const safeId = String(productId);
    const message = escapeHtml(slotted.message);
    return htmlResponse(200, renderSlotFailurePage(safeId, message));
  }
  return redirect("/approval");
}

/**
 * Handle the skip POST. The spec's `INSERT OR REPLACE` is
 * idempotent: skipping the same sku twice is a no-op on the
 * second call, and the timestamp is refreshed to the latest
 * skip. The handler always 303s back to `/approval`.
 */
async function handleSkip(
  request: Request,
  env: Env,
): Promise<Response> {
  const form = await request.formData();
  const rawSku = form.get("source_sku");
  const sourceSku = typeof rawSku === "string" ? rawSku : "";
  if (sourceSku.length === 0) {
    return redirect("/approval");
  }
  const skippedAt = new Date().toISOString();
  const sql = [
    "INSERT OR REPLACE INTO review_skips (source, source_sku, skipped_at)",
    "VALUES (?, ?, ?)",
  ].join(" ");
  await env.DB.prepare(sql).bind(SOURCE, sourceSku, skippedAt).run();
  return redirect("/approval");
}

/**
 * Render the skipped-list page. The spec says show `source_sku`
 * and `skipped_at`. Each row has a form to unskip.
 */
async function pageSkipped(env: Env): Promise<Response> {
  const sql = [
    "SELECT source_sku, skipped_at FROM review_skips",
    "WHERE source = ?",
    "ORDER BY source_sku",
  ].join(" ");
  const result = await env.DB.prepare(sql).bind(SOURCE).all<SkippedRow>();
  const rows = result.results ?? [];
  const html = renderSkippedPage(rows);
  return htmlResponse(200, html);
}

/**
 * Render the skipped page HTML. Each row has a single form
 * (unskip) with the source_sku hidden and an Unskip button.
 */
function renderSkippedPage(rows: SkippedRow[]): string {
  const body = rows.length === 0
    ? "<p>No skipped listings.</p>"
    : rows.map((row) => {
      const safeSku = escapeHtml(row.source_sku);
      const safeAt = escapeHtml(row.skipped_at);
      return [
        "<section>",
        `<p>${safeSku} — skipped at ${safeAt}</p>`,
        `<form method="post" action="/approval/unskip">`,
        `<input type="hidden" name="source_sku" value="${safeSku}">`,
        `<button type="submit">Unskip</button>`,
        `</form>`,
        "</section>",
      ].join("");
    }).join("");
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<title>Skipped — Approval</title>",
    "</head>",
    "<body>",
    "<h1>Skipped listings — Rema</h1>",
    "<p>",
    "<a href=\"/approval\">Back to queue</a>",
    "</p>",
    body,
    "</body>",
    "</html>",
  ].join("");
}

/**
 * Handle the unskip POST. The spec's `DELETE FROM review_skips`
 * is unconditional on the matched row. The handler 303s back to
 * `/approval/skipped`.
 */
async function handleUnskip(
  request: Request,
  env: Env,
): Promise<Response> {
  const form = await request.formData();
  const rawSku = form.get("source_sku");
  const sourceSku = typeof rawSku === "string" ? rawSku : "";
  if (sourceSku.length === 0) {
    return redirect("/approval/skipped");
  }
  const sql = "DELETE FROM review_skips WHERE source = ? AND source_sku = ?";
  await env.DB.prepare(sql).bind(SOURCE, sourceSku).run();
  return redirect("/approval/skipped");
}

/**
 * Minimal message page used for the "label is required", create-
 * product failure, and missing-`source_sku` paths. Always 200.
 * `message` is escaped here.
 */
function renderMessagePage(message: string): string {
  const safe = escapeHtml(message);
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<title>Approval</title>",
    "</head>",
    "<body>",
    "<h1>Approval</h1>",
    `<p>${safe}</p>`,
    "<p>",
    "<a href=\"/approval\">Back to queue</a>",
    "</p>",
    "</body>",
    "</html>",
  ].join("");
}

/**
 * The "create ok, slot fail" page. Shows the new product id with
 * an anchor to `/products/<id>` so the user can finish the slot
 * from the product page, plus the upstream `setSlot` message.
 * The product is NOT deleted — the spec is explicit that there is
 * no product DELETE route, and the user has the option to fix the
 * slot by hand from the product page.
 */
function renderSlotFailurePage(productId: string, message: string): string {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<title>Slot conflict</title>",
    "</head>",
    "<body>",
    "<h1>Slot conflict</h1>",
    `<p>Created product <a href="/products/${productId}">${productId}</a> but the slot could not be attached: ${message}</p>`,
    "<p>",
    "<a href=\"/approval\">Back to queue</a>",
    "</p>",
    "</body>",
    "</html>",
  ].join("");
}

/** Helper: build a 200 HTML response. */
function htmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Helper: build a 303 redirect response. */
function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location },
  });
}
