/**
 * Cloud Functions entry point — SII-103.
 *
 * Export name (Cloud Functions `entry_point`): `handler`.
 *
 * The handler builds the SII-93 writer from env and delegates to
 * `runOrchestrator`. The functions-framework HTTP wrapper does not
 * send a returned value, so the handler must end the response itself.
 * Leaving it open makes Cloud Run hold the Scheduler request until
 * the 300s timeout and answer 504.
 */
import { createD1ClientFromEnv } from "./d1.js";
import { writeObservations } from "./writer.js";
import { sources, runOrchestrator, type RunResult } from "./orchestrator.js";
import { fillEmptySlots } from "./fill-slots.js";

interface HttpResponse {
  status(code: number): { json(body: unknown): void };
}

function isHttpResponse(value: unknown): value is HttpResponse {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return false;
  }
  return typeof value.status === "function";
}

/** End an HTTP invocation. Returns false when `res` is not a response. */
export function endHttpResponse(
  res: unknown,
  status: number,
  body: unknown,
): boolean {
  if (!isHttpResponse(res)) return false;
  res.status(status).json(body);
  return true;
}

export const handler = async (
  _req?: unknown,
  res?: unknown,
): Promise<RunResult> => {
  try {
    const client = createD1ClientFromEnv();
    const result = await runOrchestrator(sources, {
      write: (stream) => writeObservations(stream, client),
    });
    // SII-131 — fill empty `product_slots` rows from a unique GTIN
    // after the collect. Call it even when some sources have ok=false
    // (per spec). A throw here must NOT fail the collect: log it and
    // still return HTTP 200 with the orchestrator's RunResult.
    try {
      await fillEmptySlots(client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("priskurven fillEmptySlots failed", { error: message });
    }
    endHttpResponse(res, 200, result);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("priskurven handler failed", { error: message });
    if (endHttpResponse(res, 500, { error: message })) {
      return { perSource: {} };
    }
    throw err;
  }
};
