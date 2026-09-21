/**
 * Orchestrator — SII-103.
 *
 * One daily job runs every registered source. One source throwing does
 * NOT skip the others. Every observation a source emits is written
 * through the shared writer — including rows that match the previous
 * observation for `(source, source_sku)`. There is no skip-unchanged
 * logic in M1; duplication is acceptable for now.
 *
 * Source/observation shapes come from `src/types.ts`.
 *
 * Failure isolation:
 *   Sources run under `Promise.allSettled`. Each source is wrapped in
 *   its own async function so one rejection cannot abort the others.
 *   Per-source failures are logged with the source's index in the
 *   registered list and surfaced in the returned `RunResult` so the
 *   caller can decide what to do.
 *
 * No skip-unchanged:
 *   The writer is called with whatever the source yields. Dedup is
 *   deferred (see the M1 fail clause in SII-103).
 */

import type { Observation, Source } from "./types.js";
import { minkobmand } from "./sources/minkobmand.js";
import { rema } from "./sources/rema.js";
import { spar } from "./sources/spar.js";
import { nemlig } from "./sources/nemlig.js";
import { netto } from "./sources/netto.js";
import { fotex } from "./sources/fotex.js";
import { bilkatogo } from "./sources/bilkatogo.js";
import { lidl } from "./sources/lidl.js";

export type { Observation, Source };

/**
 * Writer contract for SII-93's `writeObservations`. `write` consumes
 * the entire stream and returns the number of rows inserted. It MUST
 * throw on the first malformed observation or write failure so the
 * orchestrator can attribute the failure to a source.
 */
export interface Writer {
  write(stream: AsyncIterable<Observation>): Promise<number>;
}

/**
 * Registered source list. Adding a collector means appending one
 * import below — nothing else.
 */
export const sources: Source[] = [
  minkobmand,
  rema,
  spar,
  nemlig,
  netto,
  fotex,
  bilkatogo,
  lidl,
];

export interface SourceResult {
  /** `true` when the source ran and wrote every fetched observation. */
  ok: boolean;
  /** Number of rows written by the writer for this source. `0` on failure. */
  written: number;
  /** Error message when `ok` is `false`. Absent on success. */
  error?: string;
}

export interface RunResult {
  /** Per-source outcome keyed by `source_<index>` (0-based position in the registered list). */
  perSource: Record<string, SourceResult>;
}

/**
 * Run every registered source, isolating failures.
 *
 * Implementation notes:
 *   - `Promise.allSettled` (NOT `Promise.all`) — one rejection cannot
 *     abort the rest of the run.
 *   - Each source is awaited individually inside the mapped async
 *     function, so `writer.write` rejection only marks that source's
 *     slot as failed.
 *   - Logging: a `console.error` is emitted per failure with a
 *     structured payload so cron logs are greppable by source index.
 *   - Every fetched observation is written. No skip-unchanged logic.
 */
export async function runOrchestrator(
  srcs: Source[],
  writer: Writer,
): Promise<RunResult> {
  const outcomes = await Promise.allSettled(
    srcs.map(async (source, idx): Promise<{ idx: number; written: number }> => {
      const stream = source();
      const written = await writer.write(stream);
      return { idx, written };
    }),
  );

  const perSource: RunResult["perSource"] = {};
  outcomes.forEach((outcome, i) => {
    const key = `source_${i}`;
    if (outcome.status === "fulfilled") {
      perSource[key] = { ok: true, written: outcome.value.written };
    } else {
      const reason: unknown = outcome.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : (() => {
                try {
                  return JSON.stringify(reason);
                } catch {
                  return String(reason);
                }
              })();
      // Surface the failure in cron logs without aborting the run.
      console.error("priskurven source failed", {
        source: key,
        index: i,
        error: message,
      });
      perSource[key] = { ok: false, written: 0, error: message };
    }
  });

  return { perSource };
}
