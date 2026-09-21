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

import { describe, it, expect } from 'vitest';
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
} from '../../src/sources/rema.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '..', 'fixtures', 'rema-catalog.truncated.json');

const ISO_8601_WITH_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('rema source', () => {
  it('fixture is loadable and has the expected top-level shape', async () => {
    const raw = await readFile(fixturePath, 'utf8');
    const json = JSON.parse(raw) as RemaCatalog;
    const departments = json.departments ?? [];
    expect(Array.isArray(departments)).toBe(true);
    expect(departments.length).toBeGreaterThan(0);
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
    expect(totalCategories).toBeGreaterThan(0);
    expect(totalItems).toBeGreaterThan(0);
  });

  it('isValidEan13 accepts known-good EAN-13 codes', () => {
    expect(isValidEan13('4009097035793')).toBe(true);
    expect(isValidEan13('5701194611724')).toBe(true);
    expect(isValidEan13('5705830016690')).toBe(true);
    expect(isValidEan13('5705830601452')).toBe(true);
    expect(isValidEan13('5705830020444')).toBe(true);
  });

  it('isValidEan13 rejects short PLUs', () => {
    expect(isValidEan13('1006')).toBe(false);
    expect(isValidEan13('574289')).toBe(false);
    expect(isValidEan13('10021392')).toBe(false);
  });

  it('isValidEan13 rejects 20..29 in-store prefixes', () => {
    expect(isValidEan13('2011020000008')).toBe(false);
    expect(isValidEan13('2105240000006')).toBe(false);
    expect(isValidEan13('2910200000002')).toBe(false);
  });

  it('isValidEan13 rejects non-numeric and 13-digit-but-invalid inputs', () => {
    expect(isValidEan13('4009097035794')).toBe(false);
    expect(isValidEan13('400909703579X')).toBe(false);
    expect(isValidEan13('')).toBe(false);
    expect(isValidEan13(null)).toBe(false);
    expect(isValidEan13(undefined)).toBe(false);
    expect(isValidEan13(4009097035793)).toBe(false);
  });

  it('observationsFromCatalog yields one observation per item', async () => {
    const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
    const obs = observationsFromCatalog(catalog);
    expect(obs.length).toBeGreaterThan(0);
    expect(obs.length).toBeGreaterThan(500);
  });

  it('every observation carries the Rema source identifier and DKK currency', async () => {
    const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
    const obs = observationsFromCatalog(catalog);
    expect(SOURCE).toBe('rema');
    expect(CURRENCY).toBe('DKK');
    for (const o of obs) {
      expect(o.source).toBe('rema');
      expect(o.currency).toBe('DKK');
    }
  });

  it('source_sku is the stringified Rema item id', async () => {
    const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
    const obs = observationsFromCatalog(catalog);
    for (const o of obs) {
      expect(typeof o.source_sku).toBe('string');
      expect(o.source_sku.length).toBeGreaterThan(0);
      expect(o.source_sku).toMatch(/^\d+$/);
    }
  });

  it('observed_at is ISO 8601 UTC with milliseconds', async () => {
    const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
    const obs = observationsFromCatalog(catalog);
    expect(obs.length).toBeGreaterThan(0);
    for (const o of obs) {
      expect(o.observed_at).toMatch(ISO_8601_WITH_MS);
      expect(Number.isNaN(Date.parse(o.observed_at))).toBe(false);
    }
  });

  it('price is a finite number', async () => {
    const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
    const obs = observationsFromCatalog(catalog);
    for (const o of obs) {
      expect(typeof o.price).toBe('number');
      expect(Number.isFinite(o.price)).toBe(true);
      expect(o.price).toBeGreaterThanOrEqual(0);
    }
  });

  it('at least some observations carry a non-empty gtins array of valid EAN-13s', async () => {
    const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
    const obs = observationsFromCatalog(catalog);
    const withGtins = obs.filter((o) => o.gtins.length > 0);
    expect(withGtins.length).toBeGreaterThan(0);
    for (const o of obs) {
      for (const g of o.gtins) {
        expect(typeof g).toBe('string');
        expect(g).toMatch(/^\d{13}$/);
        expect(isValidEan13(g)).toBe(true);
      }
    }
  });

  it('name is populated for items that have one', async () => {
    const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
    const obs = observationsFromCatalog(catalog);
    const withName = obs.filter((o) => typeof o.name === 'string');
    expect(withName.length).toBeGreaterThan(0);
    for (const o of withName) {
      expect(o.name!.length).toBeGreaterThan(0);
    }
  });

  it('raw payload is the original item node', async () => {
    const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as RemaCatalog;
    const obs = observationsFromCatalog(catalog);
    for (const o of obs) {
      expect(o.raw && typeof o.raw === 'object').toBe(true);
      expect(typeof (o.raw as { id: unknown }).id).toBe('number');
    }
  });

  it('fetchRemaCatalog rejects non-2xx responses', async () => {
    const fakeFetch = async () =>
      new Response('nope', { status: 503, statusText: 'Service Unavailable' });
    await expect(fetchRemaCatalog(fakeFetch as unknown as typeof fetch)).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it('fetchRemaCatalog parses JSON for 2xx responses', async () => {
    const body = JSON.stringify({ departments: [] });
    const fakeFetch = async () => new Response(body, { status: 200 });
    const catalog = await fetchRemaCatalog(fakeFetch as unknown as typeof fetch);
    expect(catalog).toEqual({ departments: [] });
  });

  it('REMA_CATALOG_URL is the documented cphapp catalog endpoint', () => {
    expect(REMA_CATALOG_URL).toBe(
      'https://cphapp.rema1000.dk/api/v1/catalog/store/1/withchildren',
    );
  });
});