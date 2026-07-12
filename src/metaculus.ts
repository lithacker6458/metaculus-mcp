/**
 * Thin client for the Metaculus API v2.
 *
 * Source of truth: the official OpenAPI 3.0.0 spec (version 2.0.0) published in the
 * open-source Metaculus repo at docs/openapi.yml and rendered at
 * https://www.metaculus.com/api/ (accessed 2026-07-12).
 *
 * Auth (from the spec's TokenAuth security scheme): every request must carry
 *   Authorization: Token <token>
 * Users generate their own free token at
 * https://www.metaculus.com/accounts/settings/account/#api-access
 *
 * Rate limits: the spec states request throttling applies to metaculus.com but
 * publishes no numbers (verified 2026-07-12). We surface 429s verbatim.
 */

export const METACULUS_BASE = "https://www.metaculus.com";

export const NO_TOKEN_MESSAGE =
  "No Metaculus API token was provided. All Metaculus API endpoints require authentication " +
  "(unauthenticated requests are rejected with HTTP 403). " +
  "Generate a free token at https://www.metaculus.com/accounts/settings/account/#api-access " +
  "and configure your MCP client to send it on every request to this server, using ONE of these headers: " +
  '"Authorization: Token <your-token>" (Metaculus\'s native format), ' +
  '"Authorization: Bearer <your-token>", or "X-Metaculus-Token: <your-token>".';

export class MetaculusApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`Metaculus API error ${status} for ${url}: ${body}`);
    this.name = "MetaculusApiError";
  }
}

export type QueryValue =
  | string
  | number
  | boolean
  | Array<string | number>
  | undefined;

export interface MetFetchOptions {
  method?: "GET" | "POST";
  query?: Record<string, QueryValue>;
  body?: unknown;
}

/** Build a URL with repeated keys for array params (OpenAPI form/explode default). */
export function buildUrl(
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const url = new URL(path, METACULUS_BASE);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.append(key, String(value));
      }
    }
  }
  return url.toString();
}

/** Perform an authenticated request against the Metaculus API. Returns the raw Response. */
export async function metFetch(
  token: string,
  path: string,
  options: MetFetchOptions = {},
): Promise<Response> {
  const url = buildUrl(path, options.query);
  const headers: Record<string, string> = {
    // Spec: "Token-based authentication. Use format: `Token <input token>`"
    Authorization: `Token ${token}`,
    "User-Agent": "metaculus-mcp/1.0 (remote MCP server on Cloudflare Workers)",
  };
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    let hint = "";
    if (response.status === 401 || response.status === 403) {
      hint =
        " Hint: check that your Metaculus API token is valid, and note that some data " +
        "(Community Prediction aggregates, closed-question resolutions you haven't predicted on, " +
        "and the data-download endpoints) is restricted by access tier per the official API docs.";
    } else if (response.status === 429) {
      hint =
        " Hint: you were rate-limited by metaculus.com. The API spec documents that throttling " +
        "exists but publishes no numeric limits; back off and retry later.";
    }
    throw new MetaculusApiError(response.status, text.slice(0, 2000) + hint, url);
  }
  return response;
}

/** Perform an authenticated request and parse the JSON body. */
export async function metJson<T = unknown>(
  token: string,
  path: string,
  options: MetFetchOptions = {},
): Promise<T> {
  const response = await metFetch(token, path, options);
  // Some write endpoints (e.g. forecast submission, HTTP 201) may return an empty body.
  const text = await response.text();
  if (!text) return { http_status: response.status } as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { http_status: response.status, raw_body: text.slice(0, 2000) } as unknown as T;
  }
}
