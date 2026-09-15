# Priskurven

Danish grocery **shelf-price** history. Not flyers.

Linear: [Priskurven](https://linear.app/siig/project/priskurven-37cc2fd9178c)

## What this is

A daily collector of store shelf / webshop prices. You query one product at one chain over time (M1), later the same product across chains (M2), later a category such as minimælk (M3).

Identity in M1 is `(source, source_sku)`. GTIN is optional payload, never the row key.

## Sources (M1)

| Source | How | Key |
|---|---|---|
| Rema 1000 | `cphapp.rema1000.dk` catalog dump | Rema `id` (+ `bar_codes` when present) |
| Nemlig | Sitecore webapi group walk | Nemlig `Id` |
| Lidl | `lidl.dk/p/api/gridboxes` | `productId` |
| Netto / Føtex / BilkaToGo | Salling Algolia indexes | Algolia `objectID` |
| Min Købmand Holluf Pile | Longjohn `merchantId=769` (Hollufgårdsvej 219, **5220**) | `sku` |

Optional: SPAR Odense NØ, Longjohn `merchantId=1329` (5240).

Out of scope: Tjek/etilbudsavis, Coop, Meny Odense (no grocery klik-og-køb catalog).

## Infra

App code lives here. GCP scheduler/function, Cloudflare D1, and GitHub Actions WIF live in [KSiig/homelab](https://github.com/KSiig/homelab).
