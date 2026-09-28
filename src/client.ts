// Minimal Bookwhen API client used by the MCP tools.
// Docs: https://api.bookwhen.com/v2/  Spec: https://api.bookwhen.com/v2/openapi.yaml
import { redactContacts } from "./format.js";

export class BookwhenError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "BookwhenError";
  }
}

// JSON:API resource as documented in the spec's Event, Ticket, Location, Attachment, Leader and
// ClassPass schemas. The spec places an `included` array inside each resource; JSON:API itself puts
// `included` at the top level of the document. Both are read (see list/single below).
export interface JsonApiResource {
  id: string;
  type?: string;
  attributes?: Record<string, any>;
  relationships?: Record<string, any>;
  links?: Record<string, string>;
  included?: JsonApiResource[];
}

interface ListResponse {
  data?: JsonApiResource[];
  links?: { self?: string; first?: string; prev?: string; next?: string };
  included?: JsonApiResource[];
}

interface SingleResponse {
  data?: JsonApiResource;
  included?: JsonApiResource[];
}

export interface ListResult {
  items: JsonApiResource[];
  included: JsonApiResource[];
  complete: boolean;
  note?: string;
}

// A 429 means the request was not processed, so it is safe to repeat for any method. A 502/503/504
// from a gateway does not prove the upstream did not process the request, so those are only retried
// for GET. Every documented Bookwhen endpoint is a GET, so in practice everything is retried; the
// guard is kept so the client stays safe if a write endpoint is ever added.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;

export class BookwhenClient {
  private readonly baseUrl: string;
  private readonly base: URL;
  private readonly authHeader: string;
  private readonly apiKey: string;
  // Bookwhen does not document a rate limit. Space requests at about four per second so a tool
  // call that pages through a list stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;

  constructor(apiKey: string, baseUrl = "https://api.bookwhen.com/v2") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.base = new URL(this.baseUrl);
    // Spec info.description and securitySchemes.basicAuth: HTTP Basic with the API key as the
    // username and a blank password, i.e. base64("<key>:").
    this.apiKey = apiKey;
    this.authHeader = "Basic " + Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  }

  /**
   * Response text is only ever passed on through here. The spec documents 401 and 404 with empty
   * bodies, but if the live API (or a proxy in front of it) echoes the request's credentials, the key
   * and the Basic header value must not reach the assistant's output.
   */
  private scrub(text: string | undefined): string | undefined {
    if (!text) return text;
    return text.split(this.authHeader).join("[key redacted]").split(this.apiKey).join("[key redacted]");
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** True when `url` is on the configured API host and under its base path (e.g. /v2). */
  isOnApi(url: URL): boolean {
    const basePath = this.base.pathname.replace(/\/+$/, "");
    return url.origin === this.base.origin && (url.pathname === basePath || url.pathname.startsWith(basePath + "/"));
  }

  /** Path shown in messages: the part after the base URL, e.g. /events/ev-abc. */
  private label(url: URL): string {
    const basePath = this.base.pathname.replace(/\/+$/, "");
    return url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) || "/" : url.href;
  }

  /**
   * `target` is a path relative to the base URL (starts with "/") or an absolute URL that has
   * already passed isOnApi (pagination links). The API key is never sent anywhere else.
   */
  async request<T = any>(method: string, target: string, opts: { query?: Record<string, string | number | boolean | undefined> } = {}): Promise<T> {
    const url = target.startsWith("/") ? new URL(this.baseUrl + target) : new URL(target);
    if (!this.isOnApi(url)) throw new BookwhenError(`Refusing to send the API key to ${url.origin}${url.pathname}: it is not under BOOKWHEN_BASE_URL (${this.baseUrl}).`);
    const entries = Object.entries(opts.query ?? {}).filter(([, v]) => v !== undefined && v !== "");
    if (entries.length) {
      for (const [k, v] of entries) url.searchParams.set(k, String(v));
      // URLSearchParams writes a space as "+" and a comma as "%2C". The spec's example is
      // filter[tag]=tag%20one,tag%20two ("%20 is a space"), so match it: spaces as %20, the comma that
      // separates multiple values literal. Pagination links are sent as the API wrote them.
      url.search = url.searchParams.toString().replace(/\+/g, "%20").replace(/%2C/gi, ",");
    }
    const path = this.label(url);

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, { method, headers: { Authorization: this.authHeader, Accept: "application/json" } });
      } catch (err) {
        throw new BookwhenError(`Could not reach Bookwhen at ${this.baseUrl}: ${(err as Error).message}`);
      }

      const retryable = RETRY_ANY_METHOD.has(res.status) || (method === "GET" && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new BookwhenError(`Bookwhen asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${path} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date already
        // passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (res.status === 204) return undefined as T;

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (res.ok) {
        // Every documented 200 body is a JSON object with a `data` member. A 200 with HTML (a proxy,
        // a captive portal, a login page) must not be mistaken for an empty list.
        if (!json || typeof json !== "object") {
          throw new BookwhenError(
            `Bookwhen returned ${res.status} for ${method} ${path} but the body was not JSON (starts with: ${JSON.stringify(this.scrub(redactContacts(text, false))?.slice(0, 60) ?? "")}). Check BOOKWHEN_BASE_URL and whether a proxy or login page is in the way.`,
            res.status,
          );
        }
        return json as T;
      }

      // The spec documents 401 and 404 with empty bodies. If a body is present it is free text or a
      // JSON:API errors array; either way contact details and the API key are redacted before it is
      // passed on. Redaction runs on the whole body before it is cut short, so a key straddling the cut
      // cannot leak its first characters.
      const detail = this.scrub(redactContacts(describeError(json) ?? text, false))?.slice(0, 300);
      if (res.status === 401 || res.status === 403) {
        throw new BookwhenError(
          `Bookwhen rejected the API key (${res.status}). Check BOOKWHEN_API_KEY: it must be an API key from Bookwhen's API tokens setup (admin.bookwhen.com/settings/api_access_permission_sets), which the server sends as the HTTP Basic username with a blank password.${detail ? " " + detail : ""}`,
          res.status,
        );
      }
      if (res.status === 404) throw new BookwhenError(`Not found: ${path}. Check the ID.${detail ? " " + detail : ""}`, 404);
      if (res.status === 429) throw new BookwhenError("Bookwhen rate limit reached (the limit is not documented). Wait a minute and try again.", 429);
      if (res.status === 400 || res.status === 422) throw new BookwhenError(`Bookwhen refused ${method} ${path} (${res.status}); check the filter values.${detail ? " " + detail : ""}`, res.status);
      if (method !== "GET" && RETRY_GET_ONLY.has(res.status)) {
        throw new BookwhenError(`Bookwhen returned ${res.status} for ${method} ${path}. The request was not retried because it may already have been processed.${detail ? " " + detail : ""}`, res.status);
      }
      if (RETRY_GET_ONLY.has(res.status)) {
        // A GET that failed MAX_ATTEMPTS times in a row. The gateway body is usually HTML, so only a JSON
        // message is passed on.
        const jsonDetail = this.scrub(redactContacts(describeError(json), false));
        throw new BookwhenError(
          `Bookwhen returned ${res.status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${jsonDetail ? " " + jsonDetail : ""}`,
          res.status,
        );
      }
      throw new BookwhenError(`Bookwhen returned ${res.status} for ${method} ${path}.${detail ? " " + detail : ""}`, res.status);
    }
  }

  get<T = any>(target: string, query?: Record<string, string | number | boolean | undefined>) {
    return this.request<T>("GET", target, { query });
  }

  /** One resource, with whatever was side-loaded (top-level `included` or the spec's resource-level one). */
  async single(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<{ item: JsonApiResource; included: JsonApiResource[] }> {
    const res = await this.get<SingleResponse>(path, query);
    if (!res?.data || typeof res.data !== "object") throw new BookwhenError(`Bookwhen returned no data for GET ${path}.`);
    return { item: res.data, included: collectIncluded(res, [res.data]) };
  }

  /**
   * Fetch a JSON:API collection by following `links.next` (the spec's IndexLinks, e.g.
   * ...?page[offset]=20). The page size is whatever the API uses: the spec documents no page-size
   * parameter, so none is sent. Stops when there is no `next` link (the documented end), at an empty
   * page, at `maxItems`, at `maxPages`, or when a `next` link is not on the configured API host, in
   * which case it is not followed (the API key must not go anywhere else) and the note says so.
   */
  async list(path: string, query: Record<string, string | number | boolean | undefined> = {}, { maxItems = 50, maxPages = 10 } = {}): Promise<ListResult> {
    const items: JsonApiResource[] = [];
    const included: JsonApiResource[] = [];
    const seen = new Set<string>();
    let res = await this.get<ListResponse>(path, query);
    for (let page = 1; ; page++) {
      const data = Array.isArray(res?.data) ? res.data : [];
      items.push(...data);
      included.push(...collectIncluded(res, data));
      const next = typeof res?.links?.next === "string" && res.links.next !== "" ? res.links.next : undefined;
      if (!next || data.length === 0) {
        if (items.length > maxItems) return { items: items.slice(0, maxItems), included, complete: false, note: `Only the first ${maxItems} of ${items.length} results are shown; raise max_results to see the rest.` };
        return { items, included, complete: true };
      }
      if (items.length >= maxItems) return { items: items.slice(0, maxItems), included, complete: false, note: `More results exist beyond the first ${maxItems}; raise max_results to see more.` };
      if (page >= maxPages) return { items, included, complete: false, note: `Stopped after ${maxPages} pages (${items.length} results); the list continues.` };
      let nextUrl: URL;
      try {
        nextUrl = new URL(next);
      } catch {
        return { items, included, complete: false, note: `The API returned a next-page link that is not a valid URL (${JSON.stringify(next.slice(0, 80))}); it was not followed.` };
      }
      if (!this.isOnApi(nextUrl)) return { items, included, complete: false, note: `The API returned a next-page link to ${nextUrl.origin}${nextUrl.pathname}, which is not under the configured Bookwhen API base URL (${this.baseUrl}); it was not followed.` };
      if (seen.has(nextUrl.href)) return { items, included, complete: false, note: "The API returned the same next-page link twice; stopped to avoid looping." };
      seen.add(nextUrl.href);
      res = await this.get<ListResponse>(nextUrl.href);
    }
  }
}

/** Side-loaded resources: the top-level `included` (JSON:API) plus any `included` inside a resource (the spec's schemas). */
function collectIncluded(doc: { included?: unknown } | undefined, resources: JsonApiResource[]): JsonApiResource[] {
  const out: JsonApiResource[] = [];
  if (Array.isArray(doc?.included)) out.push(...(doc!.included as JsonApiResource[]));
  for (const r of resources) if (Array.isArray(r?.included)) out.push(...r.included);
  return out.filter((r) => r && typeof r === "object" && typeof r.id === "string");
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The spec documents no error body. If one comes back, read a JSON:API `errors` array
// ({title, detail}) or a plain {message}/{error} object.
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const errs = json.errors;
  if (Array.isArray(errs) && errs.length) {
    const s = errs.map((e: any) => [e?.title, e?.detail].filter((x) => typeof x === "string" && x.trim()).join(": ")).filter(Boolean).join("; ");
    if (s) return s;
  }
  const single = [json.message, json.error].find((x) => typeof x === "string" && x.trim());
  return single;
}
