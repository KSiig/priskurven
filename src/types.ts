/**
 * Shared types for shelf-price collectors.
 *
 * SII-92 implements only `minkobmand`; sibling M1 issues add their own
 * sources that import these same shapes from this module.
 */

export type Observation = {
  source: string;
  source_sku: string;
  observed_at: string;
  price: number;
  currency: string;
  name?: string;
  brand?: string;
  size?: { value: number; unit: string };
  gtins: string[];
  raw: unknown;
};

export type Source = () => AsyncIterable<Observation>;