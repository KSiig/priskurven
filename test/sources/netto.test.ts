/**
 * Unit tests for the Netto (Salling) source.
 *
 * These tests do NOT hit the live Algolia endpoint.  The fetcher is
 * driven through `globalThis.fetch` stubs that return the committed
 * fixtures under `test/fixtures/algolia-*.json`.  Env vars are
 * toggled in `beforeEach`/`afterEach` so the tests do not depend on
 * SII-102's key store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { netto } from '../../src/sources/netto.js';
import {
  algoliaSearchUrl,
  type AlgoliaHit,
} from '../../src/sources/algolia.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, '..', 'fixtures');

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8'));
}

const ISO_8601_WITH_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const APP_ID = 'TESTNETTO';
const PATH = 'netto';
const KEY = 'test-key-netto';

describe('netto source', () => {
  let originalFetch: typeof fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    // Clean slate so a CI machine with stray env vars doesn't change behavior.
    delete process.env.NETTO_PATH;
    delete process.env.NETTO_APP_ID;
    delete process.env.NETTO_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('yields nothing when all three env vars are unset', async () => {
    const stub: FetchLike = async () => {
      throw new Error('fetch should not be called when env is unset');
    };
    globalThis.fetch = stub as typeof fetch;
    const rows = await collect(netto());
    expect(rows).toEqual([]);
  });

  it('yields nothing when only some env vars are set', async () => {
    process.env.NETTO_PATH = PATH;
    process.env.NETTO_APP_ID = APP_ID;
    // NETTO_KEY still unset
    const stub: FetchLike = async () => {
      throw new Error('fetch should not be called when env is partial');
    };
    globalThis.fetch = stub as typeof fetch;
    const rows = await collect(netto());
    expect(rows).toEqual([]);
  });

  it('hits the documented Algolia URL with the right headers', async () => {
    process.env.NETTO_PATH = PATH;
    process.env.NETTO_APP_ID = APP_ID;
    process.env.NETTO_KEY = KEY;
    const single = readFixture('algolia-single-page.json');
    let captured: {
      url: string;
      method: string | null;
      headers: Record<string, string> | null;
      body: string | null;
    } | null = null;
    const stub: FetchLike = async (input, init) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      captured = {
        url: u,
        method: (init?.method as string | undefined) ?? null,
        headers: (init?.headers as Record<string, string> | undefined) ?? null,
        body: typeof init?.body === 'string' ? init.body : null,
      };
      return new Response(JSON.stringify(single), { status: 200 });
    };
    globalThis.fetch = stub as typeof fetch;
    await collect(netto());
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(algoliaSearchUrl(APP_ID, PATH));
    expect(captured!.method).toBe('POST');
    expect(captured!.headers!['X-Algolia-Application-Id']).toBe(APP_ID);
    expect(captured!.headers!['X-Algolia-Api-Key']).toBe(KEY);
    const parsed = JSON.parse(captured!.body!);
    expect(parsed.query).toBe('');
    expect(parsed.hitsPerPage).toBe(1000);
  });

  it('emits one Observation per priced product on a single-page response', async () => {
    process.env.NETTO_PATH = PATH;
    process.env.NETTO_APP_ID = APP_ID;
    process.env.NETTO_KEY = KEY;
    const single = readFixture('algolia-single-page.json');
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(single), { status: 200 })) as typeof fetch;
    const rows = await collect(netto());
    expect(rows).toHaveLength(3);
    expect(rows[0]!.source).toBe('netto');
    expect(rows[0]!.source_sku).toBe('netto-prod-001');
    expect(rows[0]!.price).toBe(8.95);
    expect(rows[0]!.currency).toBe('DKK');
    expect(rows[0]!.name).toBe('Letmælk 0,5% 1L');
    expect(rows[0]!.brand).toBe('Netto, Egne Mærker');
    expect(rows[0]!.size).toEqual({ value: 1, unit: 'ltr' });
    expect(rows[0]!.gtins).toEqual([]);
    expect(rows[0]!.observed_at).toMatch(ISO_8601_WITH_MS);
    expect(rows[0]!.raw).toEqual((single as { hits: AlgoliaHit[] }).hits[0]);
  });

  it('walks pages 0..nbPages-1 and concatenates the observations', async () => {
    process.env.NETTO_PATH = PATH;
    process.env.NETTO_APP_ID = APP_ID;
    process.env.NETTO_KEY = KEY;
    const p0 = readFixture('algolia-multi-page0.json');
    const p1 = readFixture('algolia-multi-page1.json');
    const p2 = readFixture('algolia-multi-page2-last.json');
    const bodies: Record<number, unknown> = { 0: p0, 1: p1, 2: p2 };
    const seenPages: number[] = [];
    const stub: FetchLike = async (_input, init) => {
      const body = JSON.parse((init?.body as string | undefined) ?? '{}');
      seenPages.push(body.page as number);
      return new Response(JSON.stringify(bodies[body.page as number] ?? { hits: [], nbHits: 0, page: body.page, nbPages: 3 }), {
        status: 200,
      });
    };
    globalThis.fetch = stub as typeof fetch;
    const rows = await collect(netto());
    expect(rows).toHaveLength(6);
    expect(seenPages).toEqual([0, 1, 2]);
    const skus = rows.map((r) => r.source_sku).sort();
    expect(skus).toEqual([
      'netto-prod-100',
      'netto-prod-101',
      'netto-prod-102',
      'netto-prod-103',
      'netto-prod-104',
      'netto-prod-105',
    ]);
    for (const r of rows) {
      expect(r.source).toBe('netto');
      expect(r.currency).toBe('DKK');
    }
  });

  it('skips hits without a priced storeData entry', async () => {
    process.env.NETTO_PATH = PATH;
    process.env.NETTO_APP_ID = APP_ID;
    process.env.NETTO_KEY = KEY;
    const noPrice = readFixture('algolia-no-price.json');
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(noPrice), { status: 200 })) as typeof fetch;
    const rows = await collect(netto());
    expect(rows).toEqual([]);
  });

  it('throws on a non-2xx response from Algolia', async () => {
    process.env.NETTO_PATH = PATH;
    process.env.NETTO_APP_ID = APP_ID;
    process.env.NETTO_KEY = KEY;
    globalThis.fetch = (async () =>
      new Response('upstream down', { status: 503 })) as typeof fetch;
    await expect(collect(netto())).rejects.toThrow(/HTTP 503/);
  });
});