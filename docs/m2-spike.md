# M2 spike — shared join key (SII-104)

This note is the artefact from the SII-104 spike. It scores three
candidate join keys — `ean`, `brand-name-size`, `exact-name` — on the
latest rows in the `observations` table and recommends one. It does
**not** add a join route. The scoring is the pure function in
`src/m2-score.ts`; the live numbers here were pulled from D1 once
via the Cloudflare REST API on 2026-10-05 and pasted below.

## Sources of truth

- Anchor source: `rema`.
- Pass-set: `minkobmand`, `nemlig`, `netto` (rates decide whether a
  key passes the 0.50 threshold).
- Report-only: `bilkatogo`, `fotex`, `spar`, `lidl` (included in the
  table, excluded from the pass rule).
- A key passes when its rate is at least 0.50 on **every** pass-set
  source. The recommendation rule is pinned by the SII-104 issue
  body.

## How the numbers were pulled

The Cloudflare D1 REST API was hit directly with a `POST` against
`https://api.cloudflare.com/client/v4/accounts/5b3269050c8afff008527d038d4f2538/d1/database/6397206b-e59e-4b9b-a3b3-6dc9674e1325/query`
(SELECTs only; `CLOUDFLARE_API_TOKEN` from the environment). Two
queries were run:

1. `SELECT source, MAX(observed_at) AS max_observed_at FROM observations GROUP BY source`
   — to find the latest collect timestamp per source.
2. `SELECT source, source_sku, observed_at, name, brand, size_value, size_unit, gtins FROM observations`
   — to pull every row, then keep only rows whose `observed_at` equals
   the per-source max. (All rows in the table sit on the latest collect
   today, so a full table pull and a latest-only pull give the same
   rows.)

The pulled JSON was handed to `score()` in `src/m2-score.ts`. The
function is pure — it does not call the network.

Latest `observed_at` per source (UTC):

| source | max observed_at |
|---|---|
| `bilkatogo` | `2026-10-05T04:00:38.790Z` |
| `lidl`      | `2026-10-05T04:00:38.792Z` |
| `minkobmand`| `2026-10-05T04:00:38.682Z` |
| `netto`     | `2026-10-05T04:00:38.786Z` |
| `rema`      | `2026-10-05T04:00:39.805Z` |
| `spar`      | `2026-10-05T04:00:38.780Z` |
| `nemlig`    | (no rows) |
| `fotex`     | (no rows) |

## Row counts per source (latest pass)

The numbers below are the `source_sku` count kept for each source
after the latest-only filter — the denominator the rates are taken
against is the anchor count (next table).

| source | role | rows |
|---|---|---:|
| `rema` | anchor | 3950 |
| `minkobmand` | pass-set | 4454 |
| `nemlig` | pass-set | 0 |
| `netto` | pass-set | 4626 |
| `bilkatogo` | report-only | 30000 |
| `fotex` | report-only | 0 |
| `spar` | report-only | 5084 |
| `lidl` | report-only | 158 |

Anchor `source_sku` count: **3950** (rema).

## Rates per key

Rates are `unique-hit / anchor source_sku count` (denominator includes
`no-key` rows). `passes` is `true` iff the rate is at least 0.50 on
**all three** pass-set sources.

### `ean`

Two rows match when their `gtins` arrays share one string. The
arrays are not re-filtered.

| source | anchor | unique-hit | ambiguous | no-key | rate | passes? |
|---|---:|---:|---:|---:|---:|---|
| `minkobmand` (pass-set) | 3950 | 641 | 4 | 3305 | 0.1623 | ❌ |
| `nemlig` (pass-set)     | 3950 | 0   | 0 | 3950 | 0.0000 | ❌ |
| `netto` (pass-set)      | 3950 | 0   | 0 | 3950 | 0.0000 | ❌ |
| `bilkatogo` (report)    | 3950 | 0   | 0 | 3950 | 0.0000 | — |
| `fotex` (report)        | 3950 | 0   | 0 | 3950 | 0.0000 | — |
| `spar` (report)         | 3950 | 645 | 8 | 3297 | 0.1633 | — |
| `lidl` (report)         | 3950 | 15  | 0 | 3935 | 0.0038 | — |

`ean` does **not** pass: the rate is 0 on `netto` (the Salling Algolia
index does not request a barcode attribute — SII-97) and on `nemlig`
(the Nemlig JSON payload does not carry GTINs — SII-96). It also
fails the 0.50 bar on `minkobmand`.

### `brand-name-size`

All four fields — `brand`, `name`, `size_value`, `size_unit` — must
match after trim and lower case. A null field on the anchor counts
as `no-key`.

| source | anchor | unique-hit | ambiguous | no-key | rate | passes? |
|---|---:|---:|---:|---:|---:|---|
| `minkobmand` (pass-set) | 3950 | 0 | 0 | 3950 | 0.0000 | ❌ |
| `nemlig` (pass-set)     | 3950 | 0 | 0 | 3950 | 0.0000 | ❌ |
| `netto` (pass-set)      | 3950 | 0 | 0 | 3950 | 0.0000 | ❌ |
| `bilkatogo` (report)    | 3950 | 0 | 0 | 3950 | 0.0000 | — |
| `fotex` (report)        | 3950 | 0 | 0 | 3950 | 0.0000 | — |
| `spar` (report)         | 3950 | 0 | 0 | 3950 | 0.0000 | — |
| `lidl` (report)         | 3950 | 0 | 0 | 3950 | 0.0000 | — |

`brand-name-size` does **not** pass: `rema` writes no `brand` and no
`size_value` / `size_unit` (the Rema mapper only fills in `name` from
`item.name` and `gtins` from the bar codes — SII-94), so every anchor
row is `no-key`. This key cannot split own-brand from Arla with the
M1 fields the writers have today; that split is M3.

### `exact-name`

`name` equal after trim and lower case. A null `name` is `no-key`.

| source | anchor | unique-hit | ambiguous | no-key | rate | passes? |
|---|---:|---:|---:|---:|---:|---|
| `minkobmand` (pass-set) | 3950 | 74  | 20  | 3856 | 0.0187 | ❌ |
| `nemlig` (pass-set)     | 3950 | 0   | 0   | 3950 | 0.0000 | ❌ |
| `netto` (pass-set)      | 3950 | 426 | 325 | 3199 | 0.1078 | ❌ |
| `bilkatogo` (report)    | 3950 | 384 | 213 | 3353 | 0.0972 | — |
| `fotex` (report)        | 3950 | 0   | 0   | 3950 | 0.0000 | — |
| `spar` (report)         | 3950 | 131 | 12  | 3807 | 0.0332 | — |
| `lidl` (report)         | 3950 | 13  | 1   | 3936 | 0.0033 | — |

`exact-name` does **not** pass: even on `netto`, where the rate is
highest, only ~11% of anchor `source_sku` values match exactly one
target row.

## Recommendation: do not join yet

No key passes the 0.50 threshold on all three pass-set sources.
The strongest candidate is `ean` on `minkobmand` (0.1623) and `spar`
(0.1633); the rest sit below 0.05. Joining on any of the three keys
today would split one rema row into zero, one, or many target rows
in a way the schema cannot recover from.

## Caveats and assumptions

- `nemlig` had 0 rows on 2026-10-05 (per the issue body: the frontpage
  walk times out behind Queue-it; SII-116 logs and skips one failed
  ribbon but the bootstrap is still failing today). Without nemlig
  rows the pass rule cannot be satisfied.
- `netto` (Salling) writes `gtins = []` by spec — the Algolia request
  does not ask for a barcode field (SII-97). That hard-caps the `ean`
  rate on `netto` at 0.
- `rema` writes `brand = NULL` and `size_value = NULL` /
  `size_unit = NULL` (SII-94). That hard-caps the `brand-name-size`
  rate at 0 — every anchor row is `no-key` for that key.
- The pull happened once on 2026-10-05. Re-pull before re-using any
  number in a future milestone note; the table is the source of
  truth, this doc is a snapshot.
- The recompute rule (SII-104: "Recompute. Do not copy any count from
  this issue into the report.") was honoured — the counts above come
  from a fresh D1 query, not from the issue body.
- `ean` matching does **not** re-validate the EAN-13 checksum. The
  spec says "do not filter the arrays again"; the writers have
  already filtered, so the spike trusts the stored strings.