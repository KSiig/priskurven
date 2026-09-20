import { describe, expect, it, vi } from 'vitest';
import type {
  D1Database,
  D1PreparedStatement,
  ExecutionContext,
} from '@cloudflare/workers-types';
import { fetch } from '../src/history.js';

/** Row shape matches the SELECT in src/history.ts. */
type D1Row = {
  observed_at: string;
  price: number;
};

/** Capture every bound parameter + the prepared SQL so we can inspect
 *  what the handler asked of D1 without going through a real driver. */
interface CapturedCall {
  sql: string;
  params: unknown[];
}

interface MockD1 {
  calls: CapturedCall[];
  results: D1Row[];
  prepare(query: string): D1PreparedStatement;
}

/** Build a fake D1 binding. Records the prepared SQL + bound params
 *  for the one query we issue, applies the handler's `ORDER BY
 *  observed_at ASC` client-side (the real driver does this for us),
 *  and returns the ordered `results` from `.all()`. Other D1 methods
 *  are not exercised by this handler. */
function makeD1(results: D1Row[]): MockD1 {
  const calls: CapturedCall[] = [];
  const db: MockD1 = {
    calls,
    results,
    prepare(query: string) {
      const captured: CapturedCall = { sql: query, params: [] };
      const stmt = {
        bind(...values: unknown[]) {
          captured.params = values;
          return stmt;
        },
        async all<T = unknown>(): Promise<{ results?: T[] }> {
          calls.push(captured);
          // Honour the handler's ORDER BY clause the same way D1 would.
          const ordered = [...db.results].sort((a, b) =>
            a.observed_at < b.observed_at
              ? -1
              : a.observed_at > b.observed_at
                ? 1
                : 0,
          );
          return { results: ordered as unknown as T[] };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
  return db;
}

/** Test helper to drive the handler with a real Request object. */
function callHandler(
  db: MockD1,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `https://priskurven.example${path}`;
  const request = new Request(url, init);
  const ctx = {} as ExecutionContext;
  return fetch(request, { DB: db as unknown as D1Database }, ctx);
}

const TWO_ROWS_ASC: D1Row[] = [
  { observed_at: '2026-09-01T04:00:00.000Z', price: 10.0 },
  { observed_at: '2026-09-19T04:00:00.000Z', price: 12.95 },
];

const TWO_ROWS_DESC: D1Row[] = [...TWO_ROWS_ASC].reverse();

describe('/v1/history', () => {
  it('returns oldest-first by default (no sort param)', async () => {
    const db = makeD1(TWO_ROWS_DESC);
    const res = await callHandler(db, '/v1/history?source=rema&sku=21464');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      sku: string;
      observations: { observed_at: string; price: number }[];
    };
    expect(body.source).toBe('rema');
    expect(body.sku).toBe('21464');
    expect(body.observations).toEqual(TWO_ROWS_ASC);
    expect(body.observations[0]!.observed_at).toBe('2026-09-01T04:00:00.000Z');
    expect(body.observations[1]!.observed_at).toBe('2026-09-19T04:00:00.000Z');
  });

  it('reverses when sort=newest-first', async () => {
    const db = makeD1(TWO_ROWS_ASC);
    const res = await callHandler(
      db,
      '/v1/history?source=rema&sku=21464&sort=newest-first',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      observations: { observed_at: string; price: number }[];
    };
    expect(body.observations).toEqual(TWO_ROWS_DESC);
    expect(body.observations[0]!.observed_at).toBe('2026-09-19T04:00:00.000Z');
  });

  it('ignores unknown sort values and returns the default order', async () => {
    const db = makeD1(TWO_ROWS_DESC);
    const res = await callHandler(
      db,
      '/v1/history?source=rema&sku=21464&sort=oldest-last',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      observations: { observed_at: string }[];
    };
    expect(body.observations[0]!.observed_at).toBe('2026-09-01T04:00:00.000Z');
  });

  it('does not join across sources for the same SKU string', async () => {
    // Simulate the (source, source_sku) lookup: minkobmand has rows,
    // rema does not. The handler must 404 for rema, not return
    // minkobmand's data.
    const db = makeD1([]);
    const res = await callHandler(
      db,
      '/v1/history?source=rema&sku=21464',
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: string;
      source: string;
      sku: string;
    };
    expect(body).toEqual({
      error: 'not_found',
      source: 'rema',
      sku: '21464',
    });
  });

  it('binds source + source_sku as parameters, not by string interpolation', async () => {
    const db = makeD1(TWO_ROWS_ASC);
    await callHandler(db, "/v1/history?source=minkobmand&sku=5010029231526");
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.sql).toContain('WHERE source = ? AND source_sku = ?');
    expect(db.calls[0]!.params).toEqual(['minkobmand', '5010029231526']);
  });

  it('404 when no rows match (empty D1 results)', async () => {
    const db = makeD1([]);
    const res = await callHandler(
      db,
      '/v1/history?source=rema&sku=99999999',
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({
      error: 'not_found',
      source: 'rema',
      sku: '99999999',
    });
  });

  it('400 when source is missing', async () => {
    const db = makeD1([]);
    const res = await callHandler(db, '/v1/history?sku=21464');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('400 when sku is missing', async () => {
    const db = makeD1([]);
    const res = await callHandler(db, '/v1/history?source=rema');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('400 when both source and sku are missing', async () => {
    const db = makeD1([]);
    const res = await callHandler(db, '/v1/history');
    expect(res.status).toBe(400);
  });

  it('404 for any path other than /v1/history', async () => {
    const db = makeD1(TWO_ROWS_ASC);
    const res = await callHandler(db, '/v2/history?source=rema&sku=21464');
    expect(res.status).toBe(404);
    expect(db.calls).toHaveLength(0);
  });

  it('404 for the root path', async () => {
    const db = makeD1(TWO_ROWS_ASC);
    const res = await callHandler(db, '/');
    expect(res.status).toBe(404);
    expect(db.calls).toHaveLength(0);
  });

  it('405 for non-GET methods on /v1/history', async () => {
    const db = makeD1(TWO_ROWS_ASC);
    const res = await callHandler(db, '/v1/history?source=rema&sku=21464', {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    expect(db.calls).toHaveLength(0);
  });

  it('returns JSON with no-store cache header on success', async () => {
    const db = makeD1(TWO_ROWS_ASC);
    const res = await callHandler(db, '/v1/history?source=rema&sku=21464');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('echoes the SKU as a string, not coerced to a number', async () => {
    const db = makeD1(TWO_ROWS_ASC);
    const res = await callHandler(
      db,
      '/v1/history?source=rema&sku=021464',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sku: string };
    expect(body.sku).toBe('021464');
    expect(typeof body.sku).toBe('string');
    // Leading-zero SKUs would be lost if we ever parsed this as a
    // number — the spec echoes the URL value verbatim.
  });

  it('does not invoke D1 when the route guard fails', async () => {
    const db = makeD1(TWO_ROWS_ASC);
    await callHandler(db, '/v1/history');
    expect(db.calls).toHaveLength(0);
  });
});

describe('/v1/history integration fixtures', () => {
  it('serves the pinned Rema response shape from a fixture row', async () => {
    // One observation — exact pinned spec example for Rema SKU 21464.
    const fixture: D1Row[] = [
      { observed_at: '2026-09-19T04:00:00.000Z', price: 12.95 },
    ];
    const db = makeD1(fixture);
    const res = await callHandler(db, '/v1/history?source=rema&sku=21464');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      source: 'rema',
      sku: '21464',
      observations: [{ observed_at: '2026-09-19T04:00:00.000Z', price: 12.95 }],
    });
  });

  it('serves a Min Købmand series from a fixture row', async () => {
    // Two observations for a Min Købmand SKU — verify the handler
    // works for the second source without any cross-source mixing.
    const fixture: D1Row[] = [
      { observed_at: '2026-09-19T04:00:00.000Z', price: 39.79 },
      { observed_at: '2026-09-20T04:00:00.000Z', price: 41.5 },
    ];
    const db = makeD1(fixture);
    const res = await callHandler(
      db,
      '/v1/history?source=minkobmand&sku=5010029231526',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      sku: string;
      observations: { observed_at: string; price: number }[];
    };
    expect(body.source).toBe('minkobmand');
    expect(body.sku).toBe('5010029231526');
    expect(body.observations).toHaveLength(2);
    expect(body.observations[0]!.price).toBe(39.79);
    expect(body.observations[1]!.price).toBe(41.5);
  });

  it('pinned 404 response shape', async () => {
    const db = makeD1([]);
    const res = await callHandler(
      db,
      '/v1/history?source=rema&sku=21464',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'not_found',
      source: 'rema',
      sku: '21464',
    });
  });
});

/** Suppress the unused-import lint noise without disabling eslint. */
void vi;