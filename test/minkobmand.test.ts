import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isValidEan13, minkobmand } from '../src/sources/minkobmand.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, 'fixtures/minkobmand-page0.json');

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeFetchStub(body: unknown): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('isValidEan13', () => {
  it('accepts a known-good EAN-13', () => {
    // Marvel Chokolate Stars 5010029231526 — checksum 50 mod 10 = 0
    expect(isValidEan13('5010029231526')).toBe(true);
    // Nestle Multigrain 5011476102957 — checksum 80 mod 10 = 0
    expect(isValidEan13('5011476102957')).toBe(true);
    // Synthesised 5012345678900 — checksum 90 mod 10 = 0
    expect(isValidEan13('5012345678900')).toBe(true);
  });

  it('rejects a known-bad-checksum EAN-13', () => {
    // 5010029231526 is valid; mutating the last digit → invalid.
    expect(isValidEan13('5010029231520')).toBe(false);
    expect(isValidEan13('5010029231527')).toBe(false);
  });

  it('rejects malformed strings', () => {
    expect(isValidEan13('1234')).toBe(false);
    expect(isValidEan13('abcdefghijklm')).toBe(false);
    expect(isValidEan13('50100292315260')).toBe(false);
    expect(isValidEan13('')).toBe(false);
  });
});

describe('minkobmand source', () => {
  it('yields one Observation per product in the fixture', async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetchStub(fixture) as typeof fetch;
    try {
      const rows = await collect(minkobmand());
      expect(rows).toHaveLength(fixture.products.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps source_sku, currency, name, observed_at, and raw', async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetchStub(fixture) as typeof fetch;
    try {
      const rows = await collect(minkobmand());
      const first = rows[0]!;
      expect(first.source).toBe('minkobmand');
      expect(first.source_sku).toBe(fixture.products[0].sku);
      expect(first.currency).toBe('DKK');
      expect(first.name).toBe(fixture.products[0].productDisplayName);
      // ISO 8601 UTC with milliseconds, e.g. 2025-09-20T12:34:56.789Z
      expect(first.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(first.raw).toEqual(fixture.products[0]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('adds sku to gtins only when it is a valid EAN-13', async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetchStub(fixture) as typeof fetch;
    try {
      const rows = await collect(minkobmand());
      // products[0..2] are real-world Longjohn SKUs that pass the checksum.
      expect(rows[0]!.gtins).toEqual(['5010029231526']);
      expect(rows[1]!.gtins).toEqual(['5011476102957']);
      expect(rows[2]!.gtins).toEqual(['5011476103053']);
      // products[3] sku 5012345678900 — synthesised valid → in gtins
      expect(rows[3]!.gtins).toEqual(['5012345678900']);
      // products[4] sku 5010029231520 — mutated check digit → empty gtins
      expect(rows[4]!.gtins).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('prefers discountPrice when > 0, else falls back to price', async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetchStub(fixture) as typeof fetch;
    try {
      const rows = await collect(minkobmand());
      // products[0..2] no discount → price
      expect(rows[0]!.price).toBe(39.79);
      expect(rows[1]!.price).toBe(39.95);
      expect(rows[2]!.price).toBe(39.95);
      // products[3] discount 19.95 < price 29.95 → discountPrice
      expect(rows[3]!.price).toBe(19.95);
      // products[4] discount 9.95 < price 12.5 → discountPrice
      expect(rows[4]!.price).toBe(9.95);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves both price and discountPrice inside raw', async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetchStub(fixture) as typeof fetch;
    try {
      const rows = await collect(minkobmand());
      expect((rows[3]!.raw as { price: number; discountPrice: number }).price).toBe(29.95);
      expect((rows[3]!.raw as { price: number; discountPrice: number }).discountPrice).toBe(19.95);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws on a non-2xx response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('upstream down', { status: 503 })) as typeof fetch;
    try {
      await expect(collect(minkobmand())).rejects.toThrow(/HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});