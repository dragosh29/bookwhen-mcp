// Local stand-in for api.bookwhen.com/v2, serving the fixtures as JSON:API documents with the
// documented IndexLinks pagination (self/first/prev/next, page[offset]), side-loading via `include`,
// and the documented empty-bodied 401 and 404.
import http from "node:http";
import * as fx from "./fixtures.mjs";

export const API_KEY = "bw-test-key-not-real";
// Spec: Basic auth with the API key as the username and a blank password.
export const AUTH = "Basic " + Buffer.from(`${API_KEY}:`).toString("base64");

// The spec documents no page size; its IndexLinks examples step page[offset] by 20, so the mock
// serves 20 per page. The server never sends a page size, it only follows links.next.
export const PAGE_SIZE = 20;
export const FOREIGN_NEXT = "http://api.bookwhen.invalid/v2/events?page[offset]=20";

const byId = (list) => Object.fromEntries(list.map((r) => [r.id, r]));
const events = byId(fx.events);
const tickets = byId(fx.tickets);
const locations = byId(fx.locations);
const attachments = byId(fx.attachments);
const leaders = byId(fx.leaders);
const classPasses = byId(fx.classPasses);
const ticketsForEvent = (eventId) => fx.tickets.filter((t) => t.relationships.events.data.some((r) => r.id === eventId));

// Documented include options per endpoint.
const EVENT_INCLUDES = ["location", "attachments", "tickets", "tickets.events", "tickets.class_passes", "leaders"];
const TICKET_INCLUDES = ["class_passes", "events", "events.location", "events.tickets", "events.attachments"];

function includedForEvent(ev, opts) {
  const out = [];
  if (opts.includes("location")) out.push(locations[ev.relationships.location.data.id]);
  if (opts.includes("attachments")) out.push(...ev.relationships.attachments.data.map((r) => attachments[r.id]));
  if (opts.includes("leaders")) out.push(...ev.relationships.leaders.data.map((r) => leaders[r.id]));
  if (opts.some((o) => o.startsWith("tickets"))) {
    const ts = ticketsForEvent(ev.id);
    out.push(...ts);
    if (opts.includes("tickets.events")) for (const t of ts) out.push(...t.relationships.events.data.map((r) => events[r.id]));
    if (opts.includes("tickets.class_passes")) for (const t of ts) out.push(...t.relationships.class_passes.data.map((r) => classPasses[r.id]));
  }
  return out;
}
function includedForTicket(t, opts) {
  const out = [];
  if (opts.includes("class_passes")) out.push(...t.relationships.class_passes.data.map((r) => classPasses[r.id]));
  if (opts.some((o) => o.startsWith("events"))) {
    const evs = t.relationships.events.data.map((r) => events[r.id]);
    out.push(...evs);
    if (opts.includes("events.location")) for (const e of evs) out.push(locations[e.relationships.location.data.id]);
    if (opts.includes("events.tickets")) for (const e of evs) out.push(...ticketsForEvent(e.id));
    if (opts.includes("events.attachments")) for (const e of evs) out.push(...e.relationships.attachments.data.map((r) => attachments[r.id]));
  }
  return out;
}
const dedupe = (list) => {
  const seen = new Set();
  return list.filter((r) => r && !seen.has(`${r.type}:${r.id}`) && seen.add(`${r.type}:${r.id}`));
};

// filter[from]/filter[to]: YYYYMMDD or YYYYMMDDHHMISS, compared against start_at as a 14-digit string.
const digits14 = (s, pad) => (s.replace(/\D/g, "") + pad).slice(0, 14);
const startKey = (ev) => digits14(ev.attributes.start_at, "");
const containsAny = (text, csvValue) => csvValue.split(",").some((v) => text.toLowerCase().includes(v.trim().toLowerCase()));
const compare = (value, filters) => {
  // filters: { "": exact, gt, gte, lt, lte, eq }
  for (const [op, raw] of Object.entries(filters)) {
    const n = Number(raw);
    if (op === "" || op === "eq") { if (value !== n) return false; }
    else if (op === "gt") { if (!(value > n)) return false; }
    else if (op === "gte") { if (!(value >= n)) return false; }
    else if (op === "lt") { if (!(value < n)) return false; }
    else if (op === "lte") { if (!(value <= n)) return false; }
    else return false;
  }
  return true;
};

export function startMock() {
  const requests = [];
  // Injected failures: { method, path, status, times, headers, body }. Each matching request consumes one
  // "time" and gets that status instead of the normal answer. The suite starts with a single 429 on
  // GET /leaders so the retry path is exercised.
  const failure429 = () => ({ method: "GET", path: "/leaders", status: 429, times: 1, headers: { "Retry-After": "1" }, body: {} });
  let failures = [failure429()];
  // Where side-loaded resources go: "top" is JSON:API's top-level `included`; "resource" is the spec's
  // literal shape, an `included` array inside each resource.
  let includedPlacement = "top";
  // When armed, the next GET /events page 1 answers with a next link on a foreign host.
  let foreignNext = false;
  // When armed, GET /events pages at offset 20 answer with a next link to themselves (a looping API).
  let loopNext = false;
  let port;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/^\/v2(?=\/|$)/, "");
    let body = "";
    for await (const chunk of req) body += chunk;
    // `raw` keeps the request line as sent, so a check can see the wire encoding of query values.
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), raw: req.url, auth: req.headers.authorization, body: body || undefined, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { ...(json === undefined ? {} : { "Content-Type": "application/json" }), ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    // Spec components.responses: Unauthorized (WWW_Authenticate header, no content), ResourceNotFound
    // (no content), InvalidParameters (no content).
    const notFound = () => send(404, undefined);
    const invalid = () => send(400, undefined);
    if (req.headers.authorization !== AUTH) return send(401, undefined, { "WWW-Authenticate": 'Basic realm="Bookwhen API"' });

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.text !== undefined) {
        // A non-JSON body of the test's choosing (a proxy's HTML page, a plain-text error).
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(failure.text);
      }
      if (failure.body === undefined) {
        // Gateway-style error: not JSON, like a real 502 page.
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }
    if (req.method !== "GET") return notFound();

    const offset = Math.max(0, Number(url.searchParams.get("page[offset]") || 0));
    const pageLink = (o) => {
      const u = new URL(`http://127.0.0.1:${port}/v2${path}`);
      for (const [k, v] of url.searchParams) if (k !== "page[offset]") u.searchParams.set(k, v);
      if (o > 0) u.searchParams.set("page[offset]", String(o));
      return u.href;
    };
    // IndexLinks: "Elements are only included when relevant."
    const paged = (items, included) => {
      const data = items.slice(offset, offset + PAGE_SIZE);
      const links = { self: pageLink(offset), first: pageLink(0) };
      if (offset > 0) links.prev = pageLink(Math.max(0, offset - PAGE_SIZE));
      if (offset + PAGE_SIZE < items.length) links.next = pageLink(offset + PAGE_SIZE);
      if (foreignNext && path === "/events" && offset === 0) {
        links.next = FOREIGN_NEXT;
        foreignNext = false;
      }
      if (loopNext && path === "/events" && offset === PAGE_SIZE) {
        links.next = pageLink(PAGE_SIZE);
        loopNext = false;
      }
      return withIncluded({ data, links }, data, included);
    };
    const single = (item, included) => withIncluded({ data: item }, [item], included);
    const withIncluded = (doc, resources, included) => {
      if (!included) return doc;
      const list = dedupe(included);
      if (includedPlacement === "top") return { ...doc, included: list };
      // Spec shape: `included` inside each resource (deep-copied so the fixtures stay clean).
      const copy = (r) => ({ ...r, included: list });
      return Array.isArray(doc.data) ? { ...doc, data: resources.map(copy) } : { ...doc, data: copy(doc.data) };
    };
    const includes = (allowed) => {
      const raw = url.searchParams.get("include");
      if (!raw) return [];
      const opts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      return opts.every((o) => allowed.includes(o)) ? opts : undefined;
    };
    const filter = (name) => url.searchParams.get(`filter[${name}]`);
    const comparisonFilter = (name) => {
      const f = {};
      for (const [k, v] of url.searchParams) {
        if (k === `filter[${name}]`) f[""] = v;
        const m = k.match(new RegExp(`^filter\\[${name}\\]\\[(\\w+)\\]$`));
        if (m) f[m[1]] = v;
      }
      return f;
    };

    const p = path.split("/").filter(Boolean);

    if (p[0] === "events") {
      if (p.length === 1) {
        const opts = includes(EVENT_INCLUDES);
        if (!opts) return invalid();
        let list = fx.events;
        // The real API defaults `from` to today; the mock has no clock, so an absent `from` means no lower bound.
        const from = filter("from");
        const to = filter("to");
        if (from) list = list.filter((e) => startKey(e) >= digits14(from, "000000"));
        if (to) list = list.filter((e) => startKey(e) < digits14(to, "000000"));
        const tag = filter("tag");
        if (tag) list = list.filter((e) => e.attributes.tags.some((t) => tag.split(",").map((s) => s.trim()).includes(t)));
        const title = filter("title");
        if (title) list = list.filter((e) => containsAny(e.attributes.title, title));
        const detail = filter("detail");
        if (detail) list = list.filter((e) => containsAny(e.attributes.details, detail));
        const location = filter("location");
        if (location) list = list.filter((e) => location.split(",").includes(e.relationships.location.data.id));
        const calendar = filter("calendar");
        if (calendar) list = list.filter((e) => calendar.split(",").includes(fx.eventCalendars[e.id]));
        if (filter("compact") === "true") list = list.filter((e) => !fx.courseOf[e.id] || fx.courseOf[e.id] === e.id);
        list = [...list].sort((a, b) => (startKey(a) < startKey(b) ? -1 : 1));
        return send(200, paged(list, opts.length ? list.slice(offset, offset + PAGE_SIZE).flatMap((e) => includedForEvent(e, opts)) : undefined));
      }
      if (p.length === 2) {
        const ev = events[p[1]];
        if (!ev) return notFound();
        const opts = includes(EVENT_INCLUDES);
        if (!opts) return invalid();
        return send(200, single(ev, opts.length ? includedForEvent(ev, opts) : undefined));
      }
    }

    if (p[0] === "tickets") {
      if (p.length === 1) {
        const eventId = url.searchParams.get("event");
        if (!eventId) return invalid(); // `event` is a required query parameter
        const opts = includes(TICKET_INCLUDES);
        if (!opts) return invalid();
        if (!events[eventId]) return notFound();
        const list = ticketsForEvent(eventId);
        return send(200, paged(list, opts.length ? list.slice(offset, offset + PAGE_SIZE).flatMap((t) => includedForTicket(t, opts)) : undefined));
      }
      if (p.length === 2) {
        const t = tickets[p[1]];
        if (!t) return notFound();
        const opts = includes(TICKET_INCLUDES);
        if (!opts) return invalid();
        return send(200, single(t, opts.length ? includedForTicket(t, opts) : undefined));
      }
    }

    if (p[0] === "locations") {
      if (p.length === 1) {
        let list = fx.locations;
        const address = filter("address_text");
        if (address) list = list.filter((l) => l.attributes.address_text.toLowerCase().includes(address.toLowerCase()));
        const info = filter("additional_info");
        if (info) list = list.filter((l) => l.attributes.additional_info.toLowerCase().includes(info.toLowerCase()));
        return send(200, paged(list));
      }
      if (p.length === 2) return locations[p[1]] ? send(200, single(locations[p[1]])) : notFound();
    }

    if (p[0] === "attachments") {
      if (p.length === 1) {
        let list = fx.attachments;
        for (const name of ["title", "file_name", "file_type"]) {
          const v = filter(name);
          if (v) list = list.filter((a) => a.attributes[name].toLowerCase().includes(v.toLowerCase()));
        }
        return send(200, paged(list));
      }
      if (p.length === 2) return attachments[p[1]] ? send(200, single(attachments[p[1]])) : notFound();
    }

    if (p[0] === "leaders") {
      if (p.length === 1) return send(200, paged(fx.leaders));
      if (p.length === 2) return leaders[p[1]] ? send(200, single(leaders[p[1]])) : notFound();
    }

    if (p[0] === "class_passes") {
      if (p.length === 1) {
        let list = fx.classPasses;
        const title = filter("title");
        if (title) list = list.filter((c) => c.attributes.title.toLowerCase().includes(title.toLowerCase()));
        const detail = filter("detail");
        if (detail) list = list.filter((c) => c.attributes.details.toLowerCase().includes(detail.toLowerCase()));
        const usage = filter("usage_type");
        if (usage) {
          if (!["personal", "any"].includes(usage)) return invalid();
          list = list.filter((c) => c.attributes.usage_type === usage);
        }
        const cost = comparisonFilter("cost");
        if (Object.keys(cost).length) list = list.filter((c) => compare(fx.classPassCosts[c.id], cost));
        const allowance = comparisonFilter("usage_allowance");
        if (Object.keys(allowance).length) list = list.filter((c) => compare(c.attributes.usage_allowance, allowance));
        const days = comparisonFilter("use_restricted_for_days");
        if (Object.keys(days).length) list = list.filter((c) => c.attributes.use_restricted_for_days !== undefined && compare(c.attributes.use_restricted_for_days, days));
        return send(200, paged(list));
      }
      if (p.length === 2) return classPasses[p[1]] ? send(200, single(classPasses[p[1]])) : notFound();
    }

    return notFound();
  });

  /** Queue a failure for the next `times` requests matching method+path (body undefined = non-JSON gateway page; `text` = a custom non-JSON body). */
  const arm = ({ method, path, status, times = 1, headers, body, text }) => {
    failures.push({ method, path, status, times, headers, body, text });
  };
  /** A single (or persistent) 429 on GET /leaders; retryAfter null sends no Retry-After header at all. */
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  const setIncludedPlacement = (where) => {
    includedPlacement = where;
  };
  const armForeignNext = () => {
    foreignNext = true;
  };
  const armLoopNext = () => {
    loopNext = true;
  };
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve({ server, port, requests, arm, arm429, disarm, setIncludedPlacement, armForeignNext, armLoopNext });
    }),
  );
}
