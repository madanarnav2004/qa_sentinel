/**
 * Retry helper for Gemini / network flakiness (429 rate limits, transient errors).
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatus(e: unknown): number | undefined {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === retries - 1) throw e;
      const status = getErrorStatus(e);
      const delay = status === 429 ? 30000 : 2000 * (i + 1);
      console.warn(`[Sentinel] Gemini call failed (${i + 1}/${retries}), retry in ${delay}ms`, e);
      await sleep(delay);
    }
  }
  throw last;
}
