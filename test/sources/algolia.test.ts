/**
 * Unit tests for the shared Algolia helper used by the three Salling
 * sources (netto, fotex, bilkatogo).
 *
 * Tests do NOT hit any live Algolia endpoint.  The fetcher is driven
 * through `globalThis.fetch` stubs that return the committed fixtures
 * under `test/fixtures/algolia-*.json`.  Each test sets up its own
 * stubs and tears them down via `try/finally`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  algoliaHeaders,
  algoliaSearchBody,
  algoliaSearchUrl,
  fetchAlgoliaPage,
  observationFromHit,
  paginateAlgoliaCatalog,
  priceFromHit,
  readAlgoliaEnv,
  type AlgoliaConfig,
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

const OBSERVED_AT = '2026-09-20T13:45:01.123Z';
const ISO_8601_WITH_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('algoliaSearchUrl', () => {
  it('builds the documented Salling URL pattern', () => {
    const url = algoliaSearchUrl('X4D5NJ4Y46', 'netto');
    expect(url).toBe('https://x4d5nj4y46-dsn.algolia.net/1/indexes/prod_netto_PRODUCTS/query');
  });

  it('lowercases the appId', () => {
    const url = algoliaSearchUrl('X4D5NJ4Y46', 'fotex');
    expect(url.startsWith('https://x4d5nj4y46-')).toBe(true);
  });

  it('embeds the path segment in prod_{path}_PRODUCTS', () => {
    expect(algoliaSearchUrl('a', 'netto')).toContain('/prod_netto_PRODUCTS/');
    expect(algoliaSearchUrl('a', 'bilkatogo')).toContain('/prod_bilkatogo_PRODUCTS/');
    expect(algoliaSearchUrl('a', 'fotex')).toContain('/prod_fotex_PRODUCTS/');
  });
});

describe('algoliaSearchBody', () => {
  it('sends empty query and hitsPerPage=1000', () => {
    const body = algoliaSearchBody(0);
    expect(body.query).toBe('');
    expect(body.hitsPerPage).toBe(1000);
    expect(body.page).toBe(0);
    expect(body.analytics).toBe(false);
    expect(body.clickAnalytics).toBe(false);
    expect(body.analyticsTags).toEqual([]);
  });

  it('includes the heissepreise attributesToRetrieve subset', () => {
    const body = algoliaSearchBody(2);
    expect(body.attributesToRetrieve).toContain('objectID');
    expect(body.attributesToRetrieve).toContain('productName');
    expect(body.attributesToRetrieve).toContain('storeData');
    expect(body.attributesToRetrieve).toContain('units');
    expect(body.attributesToRetrieve).toContain('unitsOfMeasure');
    expect(body.page).toBe(2);
  });

  it('does NOT request barcode (Salling index does not carry one)', () => {
    const body = algoliaSearchBody(0);
    expect(body.attributesToRetrieve.some((a) => /barcode|ean|gtin/i.test(a))).toBe(false);
  });
});

describe('algoliaHeaders', () => {
  it('sets the two Algolia auth headers', () => {
    const headers = algoliaHeaders('appid', 'key123');
    expect(headers['X-Algolia-Application-Id']).toBe('appid');
    expect(headers['X-Algolia-Api-Key']).toBe('key123');
  });
});

describe('priceFromHit', () => {
  it('divides øre by 100', () => {
    expect(
      priceFromHit({ objectID: 'x', storeData: { s1: { price: 895 } } }),
    ).toBe(8.95);
  });

  it('reads the first key only', () => {
    expect(
      priceFromHit({
        objectID: 'x',
        storeData: {
          store_a: { price: 1000 },
          store_b: { price: 9999 },
        },
      }),
    ).toBe(10.0);
  });

  it('falls back to 0 when storeData is missing or empty', () => {
    expect(priceFromHit({ objectID: 'x' })).toBe(0);
    expect(priceFromHit({ objectID: 'x', storeData: {} })).toBe(0);
    expect(
      priceFromHit({ objectID: 'x', storeData: { s1: { price: null } } }),
    ).toBe(0);
  });

  it('handles non-finite numeric prices by falling back to 0', () => {
    expect(
      priceFromHit({ objectID: 'x', storeData: { s1: { price: Number.NaN } } }),
    ).toBe(0);
  });
});

describe('observationFromHit', () => {
  it('returns null when objectID is missing or empty', () => {
    expect(
      observationFromHit({} as AlgoliaHit, 'netto', OBSERVED_AT),
    ).toBeNull();
    expect(
      observationFromHit({ objectID: '' }, 'netto', OBSERVED_AT),
    ).toBeNull();
  });

  it('returns null when no priced storeData entry exists', () => {
    expect(
      observationFromHit(
        { objectID: 'x', storeData: { s1: { price: null } } },
        'netto',
        OBSERVED_AT,
      ),
    ).toBeNull();
    expect(
      observationFromHit(
        { objectID: 'x', storeData: {} },
        'netto',
        OBSERVED_AT,
      ),
    ).toBeNull();
    expect(
      observationFromHit({ objectID: 'x' }, 'netto', OBSERVED_AT),
    ).toBeNull();
  });

  it('maps objectID, currency, observed_at, price (÷100), and gtins=[]', () => {
    const obs = observationFromHit(
      {
        objectID: 'sku-1',
        productName: 'Test Product',
        storeData: { s1: { price: 1234 } },
      },
      'netto',
      OBSERVED_AT,
    )!;
    expect(obs).not.toBeNull();
    expect(obs.source).toBe('netto');
    expect(obs.source_sku).toBe('sku-1');
    expect(obs.observed_at).toBe(OBSERVED_AT);
    expect(obs.price).toBe(12.34);
    expect(obs.currency).toBe('DKK');
    expect(obs.gtins).toEqual([]);
    expect(obs.raw).toEqual({
      objectID: 'sku-1',
      productName: 'Test Product',
      storeData: { s1: { price: 1234 } },
    });
  });

  it('combines brand + subBrand into a single brand field', () => {
    const obs = observationFromHit(
      {
        objectID: 'x',
        productName: 'P',
        brand: 'Netto',
        subBrand: 'Egne Mærker',
        storeData: { s1: { price: 100 } },
      },
      'netto',
      OBSERVED_AT,
    )!;
    expect(obs.brand).toBe('Netto, Egne Mærker');
  });

  it('uses brand alone when subBrand is missing', () => {
    const obs = observationFromHit(
      {
        objectID: 'x',
        productName: 'P',
        brand: 'Barilla',
        storeData: { s1: { price: 100 } },
      },
      'netto',
      OBSERVED_AT,
    )!;
    expect(obs.brand).toBe('Barilla');
  });

  it('omits brand when neither field is present', () => {
    const obs = observationFromHit(
      {
        objectID: 'x',
        productName: 'P',
        storeData: { s1: { price: 100 } },
      },
      'netto',
      OBSERVED_AT,
    )!;
    expect('brand' in obs).toBe(false);
  });

  it('prefers productName over name and productType', () => {
    const obs = observationFromHit(
      {
        objectID: 'x',
        productName: 'P1',
        name: 'P2',
        productType: 'P3',
        storeData: { s1: { price: 100 } },
      },
      'netto',
      OBSERVED_AT,
    )!;
    expect(obs.name).toBe('P1');
  });

  it('falls back to name when productName is missing', () => {
    const obs = observationFromHit(
      {
        objectID: 'x',
        name: 'Fallback',
        storeData: { s1: { price: 100 } },
      },
      'netto',
      OBSERVED_AT,
    )!;
    expect(obs.name).toBe('Fallback');
  });

  it('falls back to productType when both productName and name are missing', () => {
    const obs = observationFromHit(
      {
        objectID: 'x',
        productType: 'TypeName',
        storeData: { s1: { price: 100 } },
      },
      'netto',
      OBSERVED_AT,
    )!;
    expect(obs.name).toBe('TypeName');
  });

  it('omits name when all three fields are missing', () => {
    const obs = observationFromHit(
      {
        objectID: 'x',
        storeData: { s1: { price: 100 } },
      },
      'netto',
      OBSERVED_AT,
    )!;
    expect('name' in obs).toBe(false);
  });

  it('packs units + unitsOfMeasure into size', () => {
    const obs = observationFromHit(
      {
        objectID: 'x',
        productName: 'Mælk',
        units: 1,
        unitsOfMeasure: 'ltr',
        storeData: { s1: { price: 100 } },
      },
      'netto',
      OBSERVED_AT,
    )!;
    expect(obs.size).toEqual({ value: 1, unit: 'ltr' });
  });

  it('omits size when units or unitsOfMeasure is missing', () => {
    const a = observationFromHit(
      {
        objectID: 'x',
        units: 1,
        storeData: { s1: { price: 100 } },
      },
      'netto',
      OBSERVED_AT,
    )!;
    expect('size' in a).toBe(false);
    const b = observationFromHit(
      {
        objectID: 'x',
        unitsOfMeasure: 'ltr',
        storeData: { s1: { price: 100 } },
      },
      'netto',
      OBSERVED_AT,
    )!;
    expect('size' in b).toBe(false);
  });
});

describe('fetchAlgoliaPage', () => {
  it('POSTs to the Algolia URL with the right headers and body', async () => {
    const url = algoliaSearchUrl('appid', 'netto');
    let captured: { url: string; method: string | null; headers: Record<string, string> | null; body: string | null } | null = null;
    const stub: FetchLike = async (input, init) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      captured = {
        url: u,
        method: (init?.method as string | undefined) ?? null,
        headers: (init?.headers as Record<string, string> | undefined) ?? null,
        body: typeof init?.body === 'string' ? init.body : null,
      };
      return new Response(JSON.stringify({ hits: [], nbHits: 0, page: 0, nbPages: 1 }), { status: 200 });
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      await fetchAlgoliaPage(url, 'appid', 'key123', 2);
      expect(captured).not.toBeNull();
      expect(captured!.url).toBe(url);
      expect(captured!.method).toBe('POST');
      expect(captured!.headers!['X-Algolia-Application-Id']).toBe('appid');
      expect(captured!.headers!['X-Algolia-Api-Key']).toBe('key123');
      const parsed = JSON.parse(captured!.body!);
      expect(parsed.query).toBe('');
      expect(parsed.hitsPerPage).toBe(1000);
      expect(parsed.page).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws on a non-2xx response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('upstream down', { status: 503 })) as typeof fetch;
    try {
      await expect(
        fetchAlgoliaPage('https://example.invalid/query', 'a', 'k', 0),
      ).rejects.toThrow(/HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('paginateAlgoliaCatalog', () => {
  it('walks pages 0..nbPages-1 and yields one observation per priced hit', async () => {
    const p0 = readFixture('algolia-multi-page0.json');
    const p1 = readFixture('algolia-multi-page1.json');
    const p2 = readFixture('algolia-multi-page2-last.json');
    const bodies: Record<number, unknown> = { 0: p0, 1: p1, 2: p2 };
    const seenPages: number[] = [];
    const stub: FetchLike = async (input, init) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse((init?.body as string | undefined) ?? '{}');
      const page = body.page as number;
      seenPages.push(page);
      expect(u).toBe(algoliaSearchUrl('appid', 'netto'));
      return new Response(JSON.stringify(bodies[page] ?? { hits: [], nbHits: 0, page, nbPages: 3 }), {
        status: 200,
      });
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const rows = await collect(
        paginateAlgoliaCatalog(
          algoliaSearchUrl('appid', 'netto'),
          'appid',
          'key123',
          'netto',
        ),
      );
      // multi-page0: 2 hits, multi-page1: 3 hits, multi-page2-last: 1 hit
      expect(rows).toHaveLength(6);
      expect(seenPages).toEqual([0, 1, 2]);
      expect(rows.map((r) => r.source_sku).sort()).toEqual([
        'netto-prod-100',
        'netto-prod-101',
        'netto-prod-102',
        'netto-prod-103',
        'netto-prod-104',
        'netto-prod-105',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips hits without a priced storeData entry', async () => {
    const noPrice = readFixture('algolia-no-price.json');
    const stub: FetchLike = async () =>
      new Response(JSON.stringify(noPrice), { status: 200 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const rows = await collect(
        paginateAlgoliaCatalog(
          algoliaSearchUrl('appid', 'netto'),
          'appid',
          'key123',
          'netto',
        ),
      );
      expect(rows).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('terminates after the first page when nbPages=1', async () => {
    const single = readFixture('algolia-single-page.json');
    let calls = 0;
    const stub: FetchLike = async () => {
      calls += 1;
      return new Response(JSON.stringify(single), { status: 200 });
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const rows = await collect(
        paginateAlgoliaCatalog(
          algoliaSearchUrl('appid', 'netto'),
          'appid',
          'key123',
          'netto',
        ),
      );
      expect(rows).toHaveLength(3);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('observed_at is ISO 8601 UTC with milliseconds', async () => {
    const single = readFixture('algolia-single-page.json');
    const stub: FetchLike = async () =>
      new Response(JSON.stringify(single), { status: 200 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const rows = await collect(
        paginateAlgoliaCatalog(
          algoliaSearchUrl('appid', 'netto'),
          'appid',
          'key123',
          'netto',
        ),
      );
      for (const o of rows) {
        expect(o.observed_at).toMatch(ISO_8601_WITH_MS);
      }
      const stamps = new Set(rows.map((r) => r.observed_at));
      expect(stamps.size).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('every emitted observation carries the supplied source name', async () => {
    const single = readFixture('algolia-single-page.json');
    const stub: FetchLike = async () =>
      new Response(JSON.stringify(single), { status: 200 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const rows = await collect(
        paginateAlgoliaCatalog(
          algoliaSearchUrl('appid', 'netto'),
          'appid',
          'key123',
          'fotex',
        ),
      );
      for (const o of rows) expect(o.source).toBe('fotex');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('propagates non-2xx errors from fetchAlgoliaPage', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('upstream down', { status: 503 })) as typeof fetch;
    try {
      await expect(
        collect(
          paginateAlgoliaCatalog(
            algoliaSearchUrl('appid', 'netto'),
            'appid',
            'key123',
            'netto',
          ),
        ),
      ).rejects.toThrow(/HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('readAlgoliaEnv', () => {
  const CONFIG: AlgoliaConfig = {
    source: 'netto',
    pathEnv: 'TEST_PATH',
    appIdEnv: 'TEST_APP_ID',
    keyEnv: 'TEST_KEY',
  };

  it('returns trimmed values when all three env vars are set', () => {
    const env: NodeJS.ProcessEnv = {
      TEST_PATH: '  netto  ',
      TEST_APP_ID: 'APP',
      TEST_KEY: 'KEY',
    };
    expect(readAlgoliaEnv(CONFIG, env)).toEqual({
      path: 'netto',
      appId: 'APP',
      key: 'KEY',
    });
  });

  it('returns null when any one env var is missing', () => {
    expect(readAlgoliaEnv(CONFIG, { TEST_PATH: 'a', TEST_APP_ID: 'b' })).toBeNull();
    expect(readAlgoliaEnv(CONFIG, { TEST_PATH: 'a', TEST_KEY: 'c' })).toBeNull();
    expect(readAlgoliaEnv(CONFIG, { TEST_APP_ID: 'b', TEST_KEY: 'c' })).toBeNull();
    expect(readAlgoliaEnv(CONFIG, {})).toBeNull();
  });

  it('returns null when any one env var is whitespace-only', () => {
    expect(
      readAlgoliaEnv(CONFIG, { TEST_PATH: '   ', TEST_APP_ID: 'b', TEST_KEY: 'c' }),
    ).toBeNull();
  });
});