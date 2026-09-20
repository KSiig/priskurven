/**
 * BilkaToGo (Salling group) shelf-price collector.
 *
 * Source: `bilkatogo.dk` Algolia catalog — same path as the
 * `salling-lib.js` helper in `Herover/heissepreise`.  Algolia
 * application id and path segment come from the env at call time:
 *
 *   BILKATOGO_PATH     e.g. `bilkatogo`
 *   BILKATOGO_APP_ID   e.g. `X4D5NJ4Y46`
 *   BILKATOGO_KEY      Algolia API key (read-only search key)
 *
 * When any of the three env vars is missing the source yields nothing
 * — per the SII-97 spec, "skip live calls if env is unset".  Tests
 * inject fixtures via `globalThis.fetch` stubs and set the env vars
 * inside `beforeEach`.
 *
 * Spec: SII-97. No isolation logic — see SII-103.
 *
 * @see https://linear.app/siig/issue/SII-97
 */

import {
  algoliaSearchUrl,
  paginateAlgoliaCatalog,
  readAlgoliaEnv,
  type AlgoliaConfig,
} from './algolia.js';

const CONFIG: AlgoliaConfig = {
  source: 'bilkatogo',
  pathEnv: 'BILKATOGO_PATH',
  appIdEnv: 'BILKATOGO_APP_ID',
  keyEnv: 'BILKATOGO_KEY',
};

/**
 * The BilkaToGo source.  Implements the `Source` shape defined in
 * `./algolia.ts`: zero-arg factory returning an
 * `AsyncIterable<Observation>`.  Iterating the iterable issues one
 * POST per Algolia page (`hitsPerPage=1000`) until `nbPages`.  Yields
 * nothing when the env is unset.
 */
export async function* bilkatogo(): AsyncIterable<import('./algolia.js').Observation> {
  const env = readAlgoliaEnv(CONFIG);
  if (env === null) return;
  const url = algoliaSearchUrl(env.appId, env.path);
  yield* paginateAlgoliaCatalog(url, env.appId, env.key, CONFIG.source);
}