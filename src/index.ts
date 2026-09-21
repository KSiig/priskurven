/**
 * Cloud Functions entry point — SII-103.
 *
 * Export name (Cloud Functions `entry_point`): `handler`.
 *
 * The handler is intentionally thin. It builds the SII-93 writer from
 * env and delegates to `runOrchestrator`. SII-91 owns the
 * firebase-functions binding; the handler signature uses `unknown`
 * request/response so it is assignable to whatever SII-91 wires in.
 */
import { createD1ClientFromEnv } from "./d1.js";
import { writeObservations } from "./writer.js";
import { sources, runOrchestrator, type RunResult } from "./orchestrator.js";

export const handler = async (
  _req?: unknown,
  _res?: unknown,
): Promise<RunResult> => {
  const client = createD1ClientFromEnv();
  return runOrchestrator(sources, {
    write: (stream) => writeObservations(stream, client),
  });
};
