import type { ApiError, DependencyReport } from '@crm/shared';

/**
 * Client-side counterpart of the uniform ApiError shape every config route
 * returns. Builders catch ApiClientError and branch on `code` — e.g.
 * DEPENDENCIES renders the guardrail report — never on message strings.
 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiError['code'];
  readonly fields: Record<string, string[]> | undefined;
  readonly dependencies: DependencyReport | undefined;

  constructor(status: number, body: ApiError) {
    super(body.error);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = body.code;
    this.fields = body.fields;
    this.dependencies = body.dependencies;
  }
}

/** Fetch a same-origin API route; JSON in, JSON out, typed error out. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      // JSON is the only body this app ever sends; callers pass a string.
      ...(init?.body != null ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  // Three cases must stay distinct: a parsed body, a legitimately empty body,
  // and a body that is present but not JSON. Collapsing the last two into
  // `null` is how a non-JSON 200 gets handed back as if it were a valid T,
  // and the caller then destructures null.
  const text = await res.text();
  let body: unknown;
  let parsed = false;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
      parsed = true;
    } catch {
      // leave parsed false — the body is present but not ours
    }
  }

  if (!res.ok) {
    const err =
      parsed && body && typeof body === 'object' && 'error' in body
        ? (body as ApiError)
        : { error: `Request failed (${res.status})` };
    throw new ApiClientError(res.status, err);
  }

  // A 2xx that is not JSON is never a valid result. In practice it means the
  // request was answered by something other than the API — an auth redirect
  // followed to an HTML page, or a proxy error page. Surfacing it as a real
  // error lets the UI react instead of crashing on a null field access.
  if (text.trim() && !parsed) {
    throw new ApiClientError(res.status, {
      error: 'The server returned an unexpected response. Your session may have expired.',
      code: 'VALIDATION',
    });
  }

  return body as T;
}
