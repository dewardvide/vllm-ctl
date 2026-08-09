import "server-only";

/**
 * Shared helpers for route handlers.
 *
 * Errors are returned as `{ error }` with a message written for the person
 * reading it in the UI — a route handler should never leak a stack trace into
 * a toast.
 */

export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data as object, init);
}

export function fail(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

/** Wraps a handler so a thrown error becomes a clean 500 with its message. */
export async function guard(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, 500);
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error("Request body was not valid JSON.");
  }
}

/** Parses a route param that must be a positive integer id. */
export function intParam(value: string, what = "id"): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${what}.`);
  return n;
}
