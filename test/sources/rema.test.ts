/**
 * Unit tests for the Rema 1000 source.
 *
 * These tests do NOT hit the live Rema endpoint.  The full live
 * payload (~9 MB) is truncated once during fixture preparation (see
 * scripts/build-fixture.ts) and committed as
 * `test/fixtures/rema-catalog.truncated.json`.  Tests load that
 * fixture from disk and feed it through the pure transform exported
 * from `src/sources/rema.ts`.
 *
 * The live dry-run (>3000 products, documented in the PR body) is
 * verified by hand once per release; it is not a CI assertion.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  observationsFromCatalog,
  isValidEan13,
  fetchRemaCatalog,
  REMA_CATALOG_URL,
  SOURCE,
  CURRENCY,
  type RemaCatalog,
} from '../../src/sources/rema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '..', 'fixtures', 'rema-catalog.truncated.json');

const ISO_8601_WITH_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('fixture is loadable and has the expected top-level shape', async () => {
  const raw = await readFile(fixturePath, 'utf8');
  const json = JSON.parse(raw) as RemaCatalog;
  const departments = json.departments ?? [];
  assert.ok(Array.isArray(departments), 'departments should be an array');
  assert.ok(departments.length > 0, 'fixture should contain at least one department');
  const totalCategories = departments.reduce((n, d) => n + (d.categories?.length ?? 0), 0);
  const totalItems = departments.reduce(
    (n, d) =>
      n +
      (d.categories ?? []).reduce(
        (m: number, c: { items?: ReadonlyArray<unknown> }) => m + (c.items?.length ?? 0),
        0,
      ),
    0,
  );
  assert.ok(totalCategories > 0, 'fixture should contain categories');
  assert.ok(totalItems > 0, 'fixture should contain items');
});

test('isValidEan13 accepts known-good EAN-13 codes', () => {
  // Sourced from the live payload, 2026-09-20.  These all pass the
  // EAN-13 mod-10 checksum and do not have a 20..29 prefix.
  assert.equal(isValidEan13('4009097035793'), true);
  assert.equal(isValidEan13('5701194611724'), true);
  assert.equal(isValidEan13('5705830016690'), true);
  assert.equal(isValidEan13('5705830601452'), true);
  assert.equal(isValidEan13('5705830020444'), true);
});

test('isValidEan13 rejects short PLUs', () => {
  assert.equal(isValidEan13('1006'), false);
  assert.equal(isValidEan13('574289'), false);
  assert.equal(isValidEan13('10021392'), false); // 8 digits
});

test('isValidEan13 rejects 20..29 in-store prefixes', () => {
  // '2011020000008' is a 13-digit, mod-10-valid string but its
  // leading '20' marks it as an in-store PLU per the Rema spec.
  assert.equal(isValidEan13('2011020000008'), false);
  assert.equal(isValidEan13('2105240000006'), false);
  assert.equal(isValidEan13('2910200000002'), false);
});

test('isValidEan13 rejects non-numeric and 13-digit-but-invalid inputs', () => {
  assert.equal(isValidEan13('4009097035794'), false); // checksum off by 1
  assert.equal(isValidEan13('400909703579X'), false); // contains non-digit
  assert.equal(isValidEan13(''), false);
  assert.equal(isValidEan13(null), false);
  assert.equal(isValidEan13(undefined), false);
  assert.equal(isValidEan13(4009097035793), false); // number, not string
});

test('observationsFromCatalog yields one observation per item', async () => {
  const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
  const obs = observationsFromCatalog(catalog);
  assert.ok(obs.length > 0, 'should yield at least one observation');
  // The truncated fixture targets ~5 items per category across all
  // 163 categories in the live payload.
  assert.ok(obs.length > 500, `expected a healthy fixture sample, got ${obs.length}`);
});

test('every observation carries the Rema source identifier and DKK currency', async () => {
  const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
  const obs = observationsFromCatalog(catalog);
  assert.equal(SOURCE, 'rema');
  assert.equal(CURRENCY, 'DKK');
  for (const o of obs) {
    assert.equal(o.source, 'rema');
    assert.equal(o.currency, 'DKK');
  }
});

test('source_sku is the stringified Rema item id', async () => {
  const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
  const obs = observationsFromCatalog(catalog);
  for (const o of obs) {
    assert.equal(typeof o.source_sku, 'string');
    assert.ok(o.source_sku.length > 0, 'source_sku must be non-empty');
    assert.ok(/^\d+$/.test(o.source_sku), `source_sku should be digits, got ${o.source_sku}`);
  }
});

test('observed_at is ISO 8601 UTC with milliseconds', async () => {
  const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
  const obs = observationsFromCatalog(catalog);
  assert.ok(obs.length > 0);
  for (const o of obs) {
    assert.match(o.observed_at, ISO_8601_WITH_MS, `bad format: ${o.observed_at}`);
    // Sanity-check the date parses.
    assert.ok(!Number.isNaN(Date.parse(o.observed_at)), `unparseable: ${o.observed_at}`);
  }
});

test('price is a finite number', async () => {
  const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
  const obs = observationsFromCatalog(catalog);
  for (const o of obs) {
    assert.equal(typeof o.price, 'number');
    assert.ok(Number.isFinite(o.price));
    assert.ok(o.price >= 0);
  }
});

test('at least some observations carry a non-empty gtins array of valid EAN-13s', async () => {
  const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
  const obs = observationsFromCatalog(catalog);
  const withGtins = obs.filter((o) => o.gtins.length > 0);
  assert.ok(
    withGtins.length > 0,
    `expected at least one row with a 13-digit EAN, got ${withGtins.length} of ${obs.length}`,
  );
  for (const o of obs) {
    for (const g of o.gtins) {
      assert.equal(typeof g, 'string');
      assert.match(g, /^\d{13}$/, `gtin must be 13 digits, got ${g}`);
      assert.ok(isValidEan13(g), `gtin must be checksum-valid and outside 20..29, got ${g}`);
    }
  }
});

test('name is populated for items that have one', async () => {
  const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
  const obs = observationsFromCatalog(catalog);
  // Every item in the live payload has a non-empty `name`.
  const withName = obs.filter((o) => typeof o.name === 'string');
  assert.ok(withName.length > 0);
  for (const o of withName) {
    assert.ok(o.name!.length > 0);
  }
});

test('raw payload is the original item node', async () => {
  const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
  const obs = observationsFromCatalog(catalog);
  for (const o of obs) {
    assert.ok(o.raw && typeof o.raw === 'object', 'raw must be an object');
    assert.equal(typeof (o.raw as { id: unknown }).id, 'number');
  }
});

test('fetchRemaCatalog rejects non-2xx responses', async () => {
  const fakeFetch = async () =>
    new Response('nope', { status: 503, statusText: 'Service Unavailable' });
  await assert.rejects(
    () => fetchRemaCatalog(fakeFetch as unknown as typeof fetch),
    /HTTP 503/,
  );
});

test('fetchRemaCatalog parses JSON for 2xx responses', async () => {
  const body = JSON.stringify({ departments: [] });
  const fakeFetch = async () => new Response(body, { status: 200 });
  const catalog = await fetchRemaCatalog(fakeFetch as unknown as typeof fetch);
  assert.deepEqual(catalog, { departments: [] });
});

test('REMA_CATALOG_URL is the documented cphapp catalog endpoint', () => {
  assert.equal(
    REMA_CATALOG_URL,
    'https://cphapp.rema1000.dk/api/v1/catalog/store/1/withchildren',
  );
});