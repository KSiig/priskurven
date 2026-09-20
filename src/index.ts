/**
 * Cloud Functions entry point — SII-103.
 *
 * Export name (Cloud Functions `entry_point`): `handler`.
 *
 * The handler is intentionally thin. It resolves the production writer
 * from SII-93's `src/writer.ts` and delegates to `runOrchestrator`
 * from `src/orchestrator.ts`. SII-91 owns the firebase-functions
 * binding; the handler signature uses `unknown` request/response so
 * it compiles before SII-91 lands and is trivially assignable to
 * whatever SII-91 wires in.
 *
 * Why a dynamic import for the writer:
 *   `src/writer.ts` is owned by SII-93, not SII-103. Per the stack
 *   plan this branch must compile in isolation, so we resolve
 *   `./writer.js` lazily at runtime instead of importing it at
 *   module load. At stack time the file exists and resolution
 *   succeeds; before the stack is merged, calling `handler` throws
 *   with a clear missing-module error — and that is fine because
 *   tests inject a Writer directly through `runOrchestrator`.
 */
import { sources, runOrchestrator, type Writer, type RunResult } from "./orchestrator.js";

export const handler = async (
  _req?: unknown,
  _res?: unknown,
): Promise<RunResult> => {
  const writer = await loadWriter();
  return runOrchestrator(sources, writer);
};

async function loadWriter(): Promise<Writer> {
  // SII-93's `src/writer.ts` lands at stack time. The file is absent on
  // this branch alone, so TypeScript cannot resolve `./writer.js` and
  // we silence the missing-module error. At runtime after stacking,
  // the dynamic import resolves normally.
  // @ts-ignore — SII-93 lands at stack time.
  const mod = await import("./writer.js");
  // @ts-ignore — see above; mod is typed by the runtime module shape.
  const client = mod.createD1ClientFromEnv();
  return {
    async write(stream) {
      // @ts-ignore — see above.
      return mod.writeObservations(stream, client);
    },
  };
}
