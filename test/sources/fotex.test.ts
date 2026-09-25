/**
 * Unit tests for the Føtex (Salling) source.
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

import { fotex } from '../../src/sources/fotex.js';
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
const APP_ID = 'TESTFOTEX';
const PATH = 'fotex';
const KEY = 'test-key-fotex';

describe('fotex source', () => {
  let originalFetch: typeof fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    delete process.env.FOTEX_PATH;
    delete process.env.FOTEX_APP_ID;
    delete process.env.FOTEX_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('yields nothing when env is unset', async () => {
    const stub: FetchLike = async () => {
      throw new Error('fetch should not be called when env is unset');
    };
    globalThis.fetch = stub as typeof fetch;
    const rows = await collect(fotex());
    expect(rows).toEqual([]);
  });

  it('yields nothing when only some env vars are set', async () => {
    process.env.FOTEX_PATH = PATH;
    process.env.FOTEX_APP_ID = APP_ID;
    const stub: FetchLike = async () => {
      throw new Error('fetch should not be called when env is partial');
    };
    globalThis.fetch = stub as typeof fetch;
    const rows = await collect(fotex());
    expect(rows).toEqual([]);
  });

  it('hits the documented Algolia URL with the right headers and source=fotex', async () => {
    process.env.FOTEX_PATH = PATH;
    process.env.FOTEX_APP_ID = APP_ID;
    process.env.FOTEX_KEY = KEY;
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
    await collect(fotex());
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(algoliaSearchUrl(APP_ID, PATH));
    expect(captured!.url).toContain('/prod_fotex_PRODUCTS/');
    expect(captured!.method).toBe('POST');
    expect(captured!.headers!['X-Algolia-Application-Id']).toBe(APP_ID);
    expect(captured!.headers!['X-Algolia-Api-Key']).toBe(KEY);
  });

  it('emits Observations with source="fotex" and currency="DKK"', async () => {
    process.env.FOTEX_PATH = PATH;
    process.env.FOTEX_APP_ID = APP_ID;
    process.env.FOTEX_KEY = KEY;
    const single = readFixture('algolia-single-page.json');
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(single), { status: 200 })) as typeof fetch;
    const rows = await collect(fotex());
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.source).toBe('fotex');
      expect(r.currency).toBe('DKK');
      expect(r.observed_at).toMatch(ISO_8601_WITH_MS);
    }
    expect(rows[0]!.source_sku).toBe('netto-prod-001');
    expect(rows[0]!.raw).toEqual((single as { hits: AlgoliaHit[] }).hits[0]);
  });

  it('walks pages 0..nbPages-1', async () => {
    process.env.FOTEX_PATH = PATH;
    process.env.FOTEX_APP_ID = APP_ID;
    process.env.FOTEX_KEY = KEY;
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
    const rows = await collect(fotex());
    expect(rows).toHaveLength(6);
    expect(seenPages).toEqual([0, 1, 2]);
  });

  it('throws on a non-2xx response', async () => {
    process.env.FOTEX_PATH = PATH;
    process.env.FOTEX_APP_ID = APP_ID;
    process.env.FOTEX_KEY = KEY;
    globalThis.fetch = (async () =>
      new Response('upstream down', { status: 503 })) as typeof fetch;
    await expect(collect(fotex())).rejects.toThrow(/HTTP 503/);
  });
});