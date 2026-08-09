"use client";

/**
 * Thin fetch wrapper for the app's own API.
 *
 * Every route returns `{ error }` on failure, so unwrapping that here means no
 * caller has to remember to check `res.ok`.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* an empty body is fine for some responses */
  }

  if (!res.ok) {
    const message =
      (body as { error?: string })?.error ?? `Request failed (${res.status}).`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

export const api = {
  get: <T,>(url: string) => request<T>(url),
  post: <T,>(url: string, data?: unknown) =>
    request<T>(url, { method: "POST", body: JSON.stringify(data ?? {}) }),
  patch: <T,>(url: string, data: unknown) =>
    request<T>(url, { method: "PATCH", body: JSON.stringify(data) }),
  del: <T,>(url: string, data?: unknown) =>
    request<T>(url, { method: "DELETE", body: JSON.stringify(data ?? {}) }),
};
