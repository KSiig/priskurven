/**
 * Unit tests for the Nemlig shelf-price source.
 *
 * These tests do NOT hit the live Nemlig endpoint.  The fetcher is
 * driven through `globalThis.fetch` stubs that return the committed
 * fixtures under `test/fixtures/nemlig-*.json`.  Each per-group
 * fetch URL is captured so the suite can assert it embeds the
 * timestamp + timeslot values from the frontpage fixture (NOT the
 * Sitecore defaults `/webapi/s/0/1/0/...`).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  CURRENCY,
  FRONTPAGE_URL,
  SOURCE,
  fetchNemligFrontpage,
  fetchNemligGroup,
  groupUrl,
  isValidEan13,
  nemlig,
  observationsFromGroup,
  type NemligFrontpage,
  type NemligGroupResponse,
} from '../../src/sources/nemlig.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX_FRONT = resolve(here, '..', 'fixtures', 'nemlig-frontpage.json');
const FIX_GRP1 = resolve(here, '..', 'fixtures', 'nemlig-product-group-1.json');
const FIX_GRP2 = resolve(here, '..', 'fixtures', 'nemlig-product-group-2.json');

const ISO_8601_WITH_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Build a fetch stub that returns a different JSON body per URL.
 * Captures every URL it is called with so tests can assert the
 * fetcher issued exactly the calls we expected and used the
 * frontpage-derived ts/slot in the per-group URLs.
 */
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
function makeRecordingFetch(
  bodies: Record<string, unknown>,
  defaultStatus = 200,
): { fetch: FetchLike; urls: string[]; accepts: (string | null)[] } {
  const urls: string[] = [];
  const accepts: (string | null)[] = [];
  const fetchMock: FetchLike = async (input, init) => {
    const url = String(input);
    urls.push(url);
    const accept =
      init && init.headers
        ? (init.headers as Record<string, string>)['Accept'] ?? null
        : null;
    accepts.push(accept);
    if (url in bodies) {
      return new Response(JSON.stringify(bodies[url]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: defaultStatus });
  };
  return { fetch: fetchMock, urls, accepts };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('isValidEan13', () => {
  it('accepts known-good EAN-13 codes', () => {
    expect(isValidEan13('4009097035793')).toBe(true);
    expect(isValidEan13('5701194611724')).toBe(true);
    expect(isValidEan13('5012345678900')).toBe(true);
  });

  it('rejects 13-digit strings with a bad checksum', () => {
    expect(isValidEan13('4009097035794')).toBe(false);
    expect(isValidEan13('5010029231520')).toBe(false);
  });

  it('rejects malformed inputs', () => {
    expect(isValidEan13('1234')).toBe(false);
    expect(isValidEan13('abcdefghijklm')).toBe(false);
    expect(isValidEan13('')).toBe(false);
    expect(isValidEan13(null)).toBe(false);
    expect(isValidEan13(undefined)).toBe(false);
    expect(isValidEan13(4009097035793)).toBe(false);
  });
});

describe('groupUrl', () => {
  it('embeds the timestamp and timeslot in the path', () => {
    const url = groupUrl('AAAAAAAA-YPPrpgsX', '2026092103-120-780', '34112834-6209-46aa-adec-b0ee7be19351');
    expect(url).toContain('/webapi/AAAAAAAA-YPPrpgsX/2026092103-120-780/1/0/Products/GetByProductGroupId');
    expect(url).toContain('productGroupId=34112834-6209-46aa-adec-b0ee7be19351');
  });

  it('does not emit a hardcoded /webapi/s/0/1/0/ prefix', () => {
    const url = groupUrl('foo', 'bar', 'baz');
    expect(url).not.toMatch(/\/webapi\/s\/0\/1\/0\//);
  });

  it('URL-encodes the productGroupId', () => {
    const url = groupUrl('ts', 'slot', 'a/b c');
    expect(url).toContain('productGroupId=a%2Fb%20c');
  });
});

describe('fetchNemligFrontpage', () => {
  it('rejects non-2xx responses', async () => {
    const fakeFetch = async () =>
      new Response('nope', { status: 503, statusText: 'Service Unavailable' });
    await expect(
      fetchNemligFrontpage(fakeFetch as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('sends Accept: application/json and parses 2xx JSON', async () => {
    const body = JSON.stringify({ content: [], Settings: {} });
    let capturedAccept: string | null = null;
    const fakeFetch = async (_url: string | URL, init?: RequestInit) => {
      capturedAccept = (init?.headers as Record<string, string> | undefined)?.Accept ?? null;
      return new Response(body, { status: 200 });
    };
    const fp = await fetchNemligFrontpage(fakeFetch as unknown as typeof fetch);
    expect(capturedAccept).toBe('application/json');
    expect(fp.Settings).toEqual({});
  });
});

describe('fetchNemligGroup', () => {
  it('rejects non-2xx responses', async () => {
    const fakeFetch = async () =>
      new Response('nope', { status: 500 });
    await expect(
      fetchNemligGroup(
        fakeFetch as unknown as typeof fetch,
        'ts',
        'slot',
        'pgid',
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('observationsFromGroup', () => {
  it('yields one observation per product in the payload', () => {
    const group = JSON.parse(readFileSync(FIX_GRP1, 'utf8')) as NemligGroupResponse;
    const obs = observationsFromGroup(group, '2026-09-20T13:45:01.123Z');
    expect(obs).toHaveLength(2);
    expect(obs[0]!.source_sku).toBe('5041620');
    expect(obs[1]!.source_sku).toBe('5602181');
  });

  it('maps Name, Brand, Price, currency, and raw', () => {
    const group = JSON.parse(readFileSync(FIX_GRP1, 'utf8')) as NemligGroupResponse;
    const obs = observationsFromGroup(group, '2026-09-20T13:45:01.123Z');
    const first = obs[0]!;
    expect(first.source).toBe(SOURCE);
    expect(first.currency).toBe(CURRENCY);
    expect(first.name).toBe('Druer Autumncrisp øko.');
    expect(first.brand).toBe('Gasa Odense');
    expect(first.price).toBe(32.0);
    expect(first.raw).toEqual(group.Products![0]);
    // Second product has Brand === null → no brand field.
    expect('brand' in obs[1]!).toBe(false);
  });

  it('leaves gtins empty when no EAN-13 is present', () => {
    const group = JSON.parse(readFileSync(FIX_GRP1, 'utf8')) as NemligGroupResponse;
    const obs = observationsFromGroup(group, '2026-09-20T13:45:01.123Z');
    for (const o of obs) expect(o.gtins).toEqual([]);
  });

  it('preserves the supplied observed_at verbatim', () => {
    const group = JSON.parse(readFileSync(FIX_GRP1, 'utf8')) as NemligGroupResponse;
    const obs = observationsFromGroup(group, '2026-09-20T13:45:01.123Z');
    for (const o of obs) expect(o.observed_at).toBe('2026-09-20T13:45:01.123Z');
  });

  it('tolerates a string-typed Price by coercing to number', () => {
    const obs = observationsFromGroup(
      { Products: [{ Id: '1', Name: 'X', Price: '12.50' }] },
      '2026-09-20T13:45:01.123Z',
    );
    expect(obs[0]!.price).toBe(12.5);
  });

  it('falls back to price 0 when Price is missing or non-numeric', () => {
    const obs = observationsFromGroup(
      { Products: [{ Id: '1', Name: 'X' }, { Id: '2', Name: 'Y', Price: 'abc' as unknown as number }] },
      '2026-09-20T13:45:01.123Z',
    );
    expect(obs[0]!.price).toBe(0);
    expect(obs[1]!.price).toBe(0);
  });

  it('skips null products and products with a missing Id', () => {
    const obs = observationsFromGroup(
      {
        Products: [
          null as unknown as never,
          { Id: '1', Name: 'A' },
          { Name: 'no id' },
        ],
      },
      '2026-09-20T13:45:01.123Z',
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]!.source_sku).toBe('1');
  });
});

describe('nemlig() source', () => {
  it('hits the frontpage first with Accept: application/json', async () => {
    const frontpage = JSON.parse(readFileSync(FIX_FRONT, 'utf8')) as NemligFrontpage;
    const group1 = JSON.parse(readFileSync(FIX_GRP1, 'utf8')) as NemligGroupResponse;
    const group2 = JSON.parse(readFileSync(FIX_GRP2, 'utf8')) as NemligGroupResponse;
    const bodies: Record<string, unknown> = {
      [FRONTPAGE_URL]: frontpage,
      [groupUrl(
        frontpage.Settings!.CombinedProductsAndSitecoreTimestamp!,
        frontpage.Settings!.TimeslotUtc!,
        '34112834-6209-46aa-adec-b0ee7be19351',
      )]: group1,
      [groupUrl(
        frontpage.Settings!.CombinedProductsAndSitecoreTimestamp!,
        frontpage.Settings!.TimeslotUtc!,
        '96336d6d-85c1-440f-9f57-dfcb6f1f1f91',
      )]: group2,
    };
    const { fetch: stub, urls, accepts } = makeRecordingFetch(bodies);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const rows = await collect(nemlig());
      expect(rows.length).toBeGreaterThan(0);
      expect(urls[0]).toBe(FRONTPAGE_URL);
      expect(accepts[0]).toBe('application/json');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the frontpage timestamp and timeslot in the per-group URL', async () => {
    const frontpage = JSON.parse(readFileSync(FIX_FRONT, 'utf8')) as NemligFrontpage;
    const group1 = JSON.parse(readFileSync(FIX_GRP1, 'utf8')) as NemligGroupResponse;
    const group2 = JSON.parse(readFileSync(FIX_GRP2, 'utf8')) as NemligGroupResponse;
    const ts = frontpage.Settings!.CombinedProductsAndSitecoreTimestamp!;
    const slot = frontpage.Settings!.TimeslotUtc!;
    const bodies: Record<string, unknown> = {
      [FRONTPAGE_URL]: frontpage,
      [groupUrl(ts, slot, '34112834-6209-46aa-adec-b0ee7be19351')]: group1,
      [groupUrl(ts, slot, '96336d6d-85c1-440f-9f57-dfcb6f1f1f91')]: group2,
    };
    const { fetch: stub, urls } = makeRecordingFetch(bodies);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      await collect(nemlig());
      // Two non-trivial timestamp values: the frontpage ts (AAAAAAAA-YPPrpgsX)
      // and the timeslot (2026092103-120-780).  Both must appear in the
      // per-group URL.  A hardcoded /webapi/s/0/1/0/... would fail both
      // contains assertions.
      const groupUrls = urls.slice(1);
      expect(groupUrls).toHaveLength(2);
      for (const u of groupUrls) {
        expect(u).toContain('/webapi/AAAAAAAA-YPPrpgsX/2026092103-120-780/1/0/');
        expect(u).not.toMatch(/\/webapi\/s\/0\/1\/0\//);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('yields one observation per product across all groups', async () => {
    const frontpage = JSON.parse(readFileSync(FIX_FRONT, 'utf8')) as NemligFrontpage;
    const group1 = JSON.parse(readFileSync(FIX_GRP1, 'utf8')) as NemligGroupResponse;
    const group2 = JSON.parse(readFileSync(FIX_GRP2, 'utf8')) as NemligGroupResponse;
    const bodies: Record<string, unknown> = {
      [FRONTPAGE_URL]: frontpage,
      [groupUrl(
        frontpage.Settings!.CombinedProductsAndSitecoreTimestamp!,
        frontpage.Settings!.TimeslotUtc!,
        '34112834-6209-46aa-adec-b0ee7be19351',
      )]: group1,
      [groupUrl(
        frontpage.Settings!.CombinedProductsAndSitecoreTimestamp!,
        frontpage.Settings!.TimeslotUtc!,
        '96336d6d-85c1-440f-9f57-dfcb6f1f1f91',
      )]: group2,
    };
    const { fetch: stub } = makeRecordingFetch(bodies);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const rows = await collect(nemlig());
      expect(rows).toHaveLength(4);
      const skus = rows.map((r) => r.source_sku).sort();
      expect(skus).toEqual(['5001751', '5041620', '5602181', '5606040']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('every observation carries the nemlig source identifier and DKK currency', async () => {
    const frontpage = JSON.parse(readFileSync(FIX_FRONT, 'utf8')) as NemligFrontpage;
    const group1 = JSON.parse(readFileSync(FIX_GRP1, 'utf8')) as NemligGroupResponse;
    const group2 = JSON.parse(readFileSync(FIX_GRP2, 'utf8')) as NemligGroupResponse;
    const bodies: Record<string, unknown> = {
      [FRONTPAGE_URL]: frontpage,
      [groupUrl(
        frontpage.Settings!.CombinedProductsAndSitecoreTimestamp!,
        frontpage.Settings!.TimeslotUtc!,
        '34112834-6209-46aa-adec-b0ee7be19351',
      )]: group1,
      [groupUrl(
        frontpage.Settings!.CombinedProductsAndSitecoreTimestamp!,
        frontpage.Settings!.TimeslotUtc!,
        '96336d6d-85c1-440f-9f57-dfcb6f1f1f91',
      )]: group2,
    };
    const { fetch: stub } = makeRecordingFetch(bodies);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const rows = await collect(nemlig());
      for (const o of rows) {
        expect(o.source).toBe('nemlig');
        expect(o.currency).toBe('DKK');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('observed_at is ISO 8601 UTC with milliseconds and identical within one run', async () => {
    const frontpage = JSON.parse(readFileSync(FIX_FRONT, 'utf8')) as NemligFrontpage;
    const group1 = JSON.parse(readFileSync(FIX_GRP1, 'utf8')) as NemligGroupResponse;
    const group2 = JSON.parse(readFileSync(FIX_GRP2, 'utf8')) as NemligGroupResponse;
    const bodies: Record<string, unknown> = {
      [FRONTPAGE_URL]: frontpage,
      [groupUrl(
        frontpage.Settings!.CombinedProductsAndSitecoreTimestamp!,
        frontpage.Settings!.TimeslotUtc!,
        '34112834-6209-46aa-adec-b0ee7be19351',
      )]: group1,
      [groupUrl(
        frontpage.Settings!.CombinedProductsAndSitecoreTimestamp!,
        frontpage.Settings!.TimeslotUtc!,
        '96336d6d-85c1-440f-9f57-dfcb6f1f1f91',
      )]: group2,
    };
    const { fetch: stub } = makeRecordingFetch(bodies);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const rows = await collect(nemlig());
      const stamps = new Set(rows.map((r) => r.observed_at));
      expect(stamps.size).toBe(1);
      for (const o of rows) {
        expect(o.observed_at).toMatch(ISO_8601_WITH_MS);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves the original product node in raw', async () => {
    const frontpage = JSON.parse(readFileSync(FIX_FRONT, 'utf8')) as NemligFrontpage;
    const group1 = JSON.parse(readFileSync(FIX_GRP1, 'utf8')) as NemligGroupResponse;
    const group2 = JSON.parse(readFileSync(FIX_GRP2, 'utf8')) as NemligGroupResponse;
    const bodies: Record<string, unknown> = {
      [FRONTPAGE_URL]: frontpage,
      [groupUrl(
        frontpage.Settings!.CombinedProductsAndSitecoreTimestamp!,
        frontpage.Settings!.TimeslotUtc!,
        '34112834-6209-46aa-adec-b0ee7be19351',
      )]: group1,
      [groupUrl(
        frontpage.Settings!.CombinedProductsAndSitecoreTimestamp!,
        frontpage.Settings!.TimeslotUtc!,
        '96336d6d-85c1-440f-9f57-dfcb6f1f1f91',
      )]: group2,
    };
    const { fetch: stub } = makeRecordingFetch(bodies);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const rows = await collect(nemlig());
      for (const o of rows) {
        expect(o.raw && typeof o.raw === 'object').toBe(true);
        expect(String((o.raw as { Id?: unknown }).Id)).toBe(o.source_sku);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when the frontpage is missing Settings', async () => {
    const bodies: Record<string, unknown> = {
      [FRONTPAGE_URL]: { content: [{ ProductGroupId: 'x' }] },
    };
    const { fetch: stub } = makeRecordingFetch(bodies);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      await expect(collect(nemlig())).rejects.toThrow(/Settings\.CombinedProductsAndSitecoreTimestamp/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});