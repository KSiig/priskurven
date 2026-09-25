import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  fetchLidlPage,
  isValidEan13,
  lidl,
  observationFromItem,
  parseLidlResponse,
} from '../../src/sources/lidl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, '../fixtures');

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

/**
 * Build a fetch stub that dispatches by `offset` query param. Each
 * fixture maps an offset value to its parsed JSON body; offsets not in
 * the map return 404.
 */
function makePagedFetchStub(fixtures: Record<number, unknown>): FetchLike {
  return async (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
    const body = fixtures[offset];
    if (body === undefined) {
      return new Response(`no fixture for offset=${offset}`, { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8'));
}

describe('isValidEan13', () => {
  it('accepts a known-good EAN-13', () => {
    // Marvel Chokolate Stars 5010029231526 — checksum 50 mod 10 = 0
    expect(isValidEan13('5010029231526')).toBe(true);
    // Reese's Peanutbutter 0034000462728 — checksum 50 mod 10 = 0
    expect(isValidEan13('0034000462728')).toBe(true);
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
    // Lidl-style 8-digit internal numbers are not 13-digit EANs.
    expect(isValidEan13('20316655')).toBe(false);
    // 6-digit ians-style internal numbers are not 13-digit EANs.
    expect(isValidEan13('6511056')).toBe(false);
  });
});

describe('observationFromItem', () => {
  it('returns null when gridbox.data has no price.price', () => {
    const item = {
      gridbox: {
        data: { productId: 42, fullTitle: 'Free sample', price: { price: null } },
      },
    };
    expect(observationFromItem(item, '2026-09-20T00:00:00.000Z')).toBeNull();
  });

  it('returns null when gridbox.data is missing', () => {
    const item = { gridbox: {} };
    expect(
      observationFromItem(item, '2026-09-20T00:00:00.000Z'),
    ).toBeNull();
  });

  it('populates name, source_sku, currency, observed_at, and gtins', () => {
    const item = {
      gridbox: {
        data: {
          productId: 10037226,
          fullTitle: 'Sondey Kammerjunkere',
          price: { price: 6.95, currencyCode: 'DKK' },
        },
        meta: { ean: '20316655' }, // short EAN — should be rejected
      },
    };
    const obs = observationFromItem(item, '2026-09-20T00:00:00.000Z')!;
    expect(obs).not.toBeNull();
    expect(obs.source).toBe('lidl');
    expect(obs.source_sku).toBe('10037226');
    expect(obs.currency).toBe('DKK');
    expect(obs.name).toBe('Sondey Kammerjunkere');
    expect(obs.price).toBe(6.95);
    expect(obs.observed_at).toBe('2026-09-20T00:00:00.000Z');
    expect(obs.gtins).toEqual([]); // short EAN rejected
    expect(obs.raw).toEqual(item);
  });

  it('accepts ean when it is a checksum-valid EAN-13', () => {
    const item = {
      gridbox: {
        data: {
          productId: 11000003,
          fullTitle: "Reese's Peanutbutter i hvid chokolade",
          price: { price: 20.0, currencyCode: 'DKK' },
        },
        meta: { ean: '0034000462728' }, // valid EAN-13
      },
    };
    const obs = observationFromItem(item, '2026-09-20T00:00:00.000Z')!;
    expect(obs.gtins).toEqual(['0034000462728']);
  });

  it('omits name when fullTitle is missing', () => {
    const item = {
      gridbox: {
        data: {
          productId: 1,
          price: { price: 1.0, currencyCode: 'DKK' },
        },
      },
    };
    const obs = observationFromItem(item, '2026-09-20T00:00:00.000Z')!;
    expect(obs.name).toBeUndefined();
    expect(obs.source_sku).toBe('1');
  });

  it('includes brand when gridbox.data.brand.name is present', () => {
    const item = {
      gridbox: {
        data: {
          productId: 1,
          fullTitle: 'Sondey Kammerjunkere',
          price: { price: 6.95, currencyCode: 'DKK' },
          brand: { name: 'Sondey' },
        },
      },
    };
    const obs = observationFromItem(item, '2026-09-20T00:00:00.000Z')!;
    expect(obs.brand).toBe('Sondey');
  });

  it('omits brand when gridbox.data.brand is absent', () => {
    const item = {
      gridbox: {
        data: {
          productId: 1,
          fullTitle: 'No-brand item',
          price: { price: 1.0, currencyCode: 'DKK' },
        },
      },
    };
    const obs = observationFromItem(item, '2026-09-20T00:00:00.000Z')!;
    expect(obs.brand).toBeUndefined();
  });

  it('ignores ians (Lidl internal article numbers — not EAN-13)', () => {
    const item = {
      gridbox: {
        data: {
          productId: 10037226,
          fullTitle: 'Sondey Kammerjunkere',
          price: { price: 6.95, currencyCode: 'DKK' },
          ians: ['6511056'],
        },
      },
    };
    const obs = observationFromItem(item, '2026-09-20T00:00:00.000Z')!;
    expect(obs.gtins).toEqual([]);
  });
});

describe('parseLidlResponse', () => {
  it('extracts numFound, fetchsize, maxfetchsize, items', () => {
    const fixture = readFixture('lidl-page0.json');
    const parsed = parseLidlResponse(fixture);
    expect(parsed.numFound).toBe(9);
    expect(parsed.fetchsize).toBe(4);
    expect(parsed.maxfetchsize).toBe(1000);
    expect(parsed.items).toHaveLength(4);
  });

  it('throws when numFound is missing', () => {
    expect(() => parseLidlResponse({ fetchsize: 1, items: [] })).toThrow(
      /numFound/,
    );
  });

  it('throws when items[] is missing', () => {
    expect(() =>
      parseLidlResponse({ numFound: 0, fetchsize: 1 }),
    ).toThrow(/items/);
  });
});

describe('fetchLidlPage', () => {
  it('returns parsed response and hits offset=0 by default', async () => {
    const fixture = readFixture('lidl-page0.json');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makePagedFetchStub({ 0: fixture }) as typeof fetch;
    try {
      const page = await fetchLidlPage(0);
      expect(page.numFound).toBe(9);
      expect(page.items).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws on a non-2xx response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('upstream down', { status: 503 })) as typeof fetch;
    try {
      await expect(fetchLidlPage(0)).rejects.toThrow(/HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('lidl source', () => {
  it('yields one Observation per priced item across all pages', async () => {
    const fixtureP0 = readFixture('lidl-page0.json');
    const fixtureP1 = readFixture('lidl-page1.json');
    const fixturePlast = readFixture('lidl-page2-last.json');
    const stub = makePagedFetchStub({
      0: fixtureP0,
      4: fixtureP1,
      7: fixturePlast,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const rows = await collect(lidl());
      // page0 has 4 items, 2 have no price (skipped) → 3 yielded
      // page1 has 3 items, all priced → 3 yielded
      // plast has 2 items, all priced → 2 yielded
      // Total: 3 + 3 + 2 = 8 observations from 9 numFound items
      expect(rows).toHaveLength(8);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps source_sku=productId, currency=DKK, name=fullTitle', async () => {
    // Single-shot fixture: numFound=3, fetchsize=10 → only one page hit.
    const singleShot = {
      numFound: 3,
      fetchsize: 10,
      maxfetchsize: 1000,
      offset: 0,
      items: [
        {
          gridbox: {
            data: {
              productId: 10037226,
              fullTitle: 'Sondey Kammerjunkere',
              price: { price: 6.95, currencyCode: 'DKK' },
            },
          },
        },
      ],
    };
    const stub = makePagedFetchStub({ 0: singleShot });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const rows = await collect(lidl());
      const first = rows[0]!;
      expect(first.source).toBe('lidl');
      expect(first.source_sku).toBe('10037226');
      expect(first.currency).toBe('DKK');
      expect(first.name).toBe('Sondey Kammerjunkere');
      expect(first.observed_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(first.price).toBe(6.95);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('walks pages: offset += fetchsize until offset >= numFound', async () => {
    const fixtureP0 = readFixture('lidl-page0.json');
    const fixtureP1 = readFixture('lidl-page1.json');
    const fixturePlast = readFixture('lidl-page2-last.json');
    const stub = makePagedFetchStub({
      0: fixtureP0,
      4: fixtureP1,
      7: fixturePlast,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    const seenOffsets: number[] = [];
    const trackedStub: FetchLike = async (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      seenOffsets.push(Number(new URL(url).searchParams.get('offset') ?? '0'));
      return stub(input);
    };
    globalThis.fetch = trackedStub as typeof fetch;
    try {
      await collect(lidl());
      // Pages hit: offset=0 (p0, fetchsize=4), offset=4 (p1, fetchsize=3),
      // offset=7 (plast, fetchsize=2), then offset 7+2=9 >= numFound 9 → stop
      expect(seenOffsets).toEqual([0, 4, 7]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips items without price.price (the spec rule)', async () => {
    // Single-shot fixture with one priced item, one item missing price.
    const singleShot = {
      numFound: 2,
      fetchsize: 10,
      maxfetchsize: 1000,
      offset: 0,
      items: [
        {
          gridbox: {
            data: {
              productId: 11000152,
              fullTitle: 'Ritter SPORT ritter',
              price: { price: null }, // missing price
            },
          },
        },
        {
          gridbox: {
            data: {
              productId: 11000615,
              fullTitle: 'Item with short EAN',
              price: { price: 29.0, currencyCode: 'DKK' },
            },
            meta: { ean: '20439668' }, // short — rejected
          },
        },
      ],
    };
    const stub = makePagedFetchStub({ 0: singleShot });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const rows = await collect(lidl());
      const skipped = rows.find((r) => r.source_sku === '11000152');
      expect(skipped).toBeUndefined();
      const priced = rows.find((r) => r.source_sku === '11000615');
      expect(priced).toBeDefined();
      expect(priced!.price).toBe(29.0);
      expect(priced!.gtins).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('adds ean to gtins only when it is a checksum-valid EAN-13', async () => {
    const fixtureP0 = readFixture('lidl-page0.json');
    const fixturePlast = readFixture('lidl-page2-last.json');
    const stub = makePagedFetchStub({
      0: fixtureP0,
      4: readFixture('lidl-page1.json'),
      7: fixturePlast,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const rows = await collect(lidl());
      const reese = rows.find(
        (r) => r.source_sku === '11000003',
      )!; // ean=0034000462728 (valid)
      expect(reese.gtins).toEqual(['0034000462728']);

      const opvask = rows.find(
        (r) => r.source_sku === '11775363',
      )!; // ean=8714789740454 (valid)
      expect(opvask.gtins).toEqual(['8714789740454']);

      // Sondey Kammerjunkere has no EAN → empty gtins
      const sondey = rows.find((r) => r.source_sku === '10037226')!;
      expect(sondey.gtins).toEqual([]);

      // Item with short EAN 20439668 (8 digits) → empty gtins
      const short = rows.find((r) => r.source_sku === '11000615')!;
      expect(short.gtins).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves the original item inside raw', async () => {
    const singleShot = {
      numFound: 1,
      fetchsize: 10,
      maxfetchsize: 1000,
      offset: 0,
      items: [
        {
          gridbox: {
            data: {
              productId: 10037226,
              fullTitle: 'Sondey Kammerjunkere',
              price: { price: 6.95, currencyCode: 'DKK' },
            },
          },
        },
      ],
    };
    const stub = makePagedFetchStub({ 0: singleShot });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const rows = await collect(lidl());
      const first = rows[0]!;
      const raw = first.raw as { gridbox: { data: { productId: number } } };
      expect(raw.gridbox.data.productId).toBe(10037226);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sends Accept: */*', async () => {
    const fixtureP0 = readFixture('lidl-page0.json');
    let capturedAccept: string | null = null;
    const stub: FetchLike = async (input, init) => {
      capturedAccept =
        (init?.headers as Record<string, string> | undefined)?.['Accept'] ??
        (init?.headers as Record<string, string> | undefined)?.['accept'] ??
        null;
      return new Response(JSON.stringify(fixtureP0), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      await collect(lidl());
      expect(capturedAccept).toBe('*/*');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws on a non-2xx response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('upstream down', { status: 503 })) as typeof fetch;
    try {
      await expect(collect(lidl())).rejects.toThrow(/HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('terminates cleanly when a single page covers everything', async () => {
    // Single-shot fixture: numFound=2, fetchsize=10 → only one page hit.
    const fixture = {
      numFound: 2,
      fetchsize: 10,
      maxfetchsize: 1000,
      offset: 0,
      items: [
        {
          gridbox: {
            data: {
              productId: 1,
              fullTitle: 'A',
              price: { price: 1.0, currencyCode: 'DKK' },
            },
            meta: { ean: '0034000462728' },
          },
        },
        {
          gridbox: {
            data: {
              productId: 2,
              fullTitle: 'B',
              price: { price: 2.0, currencyCode: 'DKK' },
            },
          },
        },
      ],
    };
    let calls = 0;
    const stub: FetchLike = async (input) => {
      calls += 1;
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
      if (offset !== 0) {
        return new Response('not used', { status: 404 });
      }
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const rows = await collect(lidl());
      expect(rows).toHaveLength(2);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});