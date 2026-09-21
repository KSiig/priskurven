/**
 * Føtex (Salling group) shelf-price collector.
 *
 * Source: `fotex.dk` Algolia catalog — same path as the
 * `salling-lib.js` helper in `Herover/heissepreise`.  Algolia
 * application id and path segment come from the env at call time:
 *
 *   FOTEX_PATH     e.g. `fotex`
 *   FOTEX_APP_ID   e.g. `X4D5NJ4Y46`
 *   FOTEX_KEY      Algolia API key (read-only search key)
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

import type { Observation } from '../types.js';
import {
  algoliaSearchUrl,
  paginateAlgoliaCatalog,
  readAlgoliaEnv,
  type AlgoliaConfig,
} from './algolia.js';

const CONFIG: AlgoliaConfig = {
  source: 'fotex',
  pathEnv: 'FOTEX_PATH',
  appIdEnv: 'FOTEX_APP_ID',
  keyEnv: 'FOTEX_KEY',
};

/**
 * The Føtex source.  Implements the `Source` shape defined in
 * `./algolia.ts`: zero-arg factory returning an
 * `AsyncIterable<Observation>`.  Iterating the iterable issues one
 * POST per Algolia page (`hitsPerPage=1000`) until `nbPages`.  Yields
 * nothing when the env is unset.
 */
export async function* fotex(): AsyncIterable<Observation> {
  const env = readAlgoliaEnv(CONFIG);
  if (env === null) return;
  const url = algoliaSearchUrl(env.appId, env.path);
  yield* paginateAlgoliaCatalog(url, env.appId, env.key, CONFIG.source);
}