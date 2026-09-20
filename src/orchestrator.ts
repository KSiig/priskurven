/**
 * Orchestrator — SII-103.
 *
 * One daily job runs every registered source. One source throwing does
 * NOT skip the others. Every observation a source emits is written
 * through the shared writer — including rows that match the previous
 * observation for `(source, source_sku)`. There is no skip-unchanged
 * logic in M1; duplication is acceptable for now.
 *
 * Source/observation shapes:
 *   The canonical types live in SII-92's `src/types.ts`. Per the stack
 *   plan, this file inlines its own copies so the SII-103 branch
 *   compiles in isolation. The parent reconciles during stack
 *   assembly — the fields here deliberately match SII-92, SII-93 and
 *   the inlined sibling fetcher types byte for byte.
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

export interface Observation {
  source: string;
  source_sku: string;
  /** ISO 8601 UTC with milliseconds, e.g. `2026-09-20T13:45:01.123Z`. */
  observed_at: string;
  price: number;
  currency: string;
  name?: string;
  brand?: string;
  size?: { value: number; unit: string };
  gtins: string[];
  /** Original payload node, retained verbatim for downstream debugging. */
  raw: unknown;
}

/** A source is a zero-arg factory returning an async iterable of observations. */
export type Source = () => AsyncIterable<Observation>;

/**
 * Writer contract — local placeholder for the shared writer that lives
 * in SII-93's `src/writer.ts`. Production wiring happens in `src/index.ts`.
 * `write` consumes the entire stream and returns the number of rows
 * inserted. It MUST throw on the first malformed observation or write
 * failure so the orchestrator can attribute the failure to a source.
 */
export interface Writer {
  write(stream: AsyncIterable<Observation>): Promise<number>;
}

/**
 * Registered source list. SII-92, SII-94, SII-95, SII-96, SII-97, SII-98
 * each export a `Source` from `src/sources/<slug>.ts`. Adding a new
 * source means appending one import to the list below — nothing else.
 *
 * Empty by design: this issue owns the wiring, not the fetchers.
 */
export const sources: Source[] = [];

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
