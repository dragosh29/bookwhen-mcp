// End-to-end test: fixtures are validated against Bookwhen's published OpenAPI schemas, then the
// built MCP server is driven over stdio by a real MCP client against a local mock of the API.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, API_KEY, AUTH, PAGE_SIZE, FOREIGN_NEXT } from "./mock-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://api.bookwhen.com/v2/openapi.yaml";
if (!existsSync(`${root}spec.yaml`)) {
  try {
    writeFileSync(`${root}spec.yaml`, await (await fetch(SPEC_URL)).text());
  } catch (err) {
    console.error(`Could not download the Bookwhen spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.yaml ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = parse(readFileSync(`${root}spec.yaml`, "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "bw", components: spec.components });
const validateWith = (schema, obj, label) => {
  const v = typeof schema === "string" ? ajv.getSchema(`bw#/components/schemas/${schema}`) ?? ajv.compile({ $ref: `bw#/components/schemas/${schema}` }) : ajv.compile(schema);
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
};
const validate = (schemaName, obj, id = "") => validateWith(schemaName, obj, `${schemaName} ${id}`);
// The 200 response schemas are inline in each operation and $ref '#/components/...'; point those refs
// at the registered components so they resolve.
const responseSchema = (path) => JSON.parse(JSON.stringify(spec.paths[path].get.responses["200"].content["application/json"].schema).replaceAll('"#/components', '"bw#/components'));
const validateResponse = (path, obj) => validateWith(responseSchema(path), obj, `GET ${path} response`);

console.log("fixtures vs OpenAPI spec");
await check("events, tickets, locations, attachments, leaders, class passes", async () => {
  fx.events.forEach((e) => validate("Event", e, e.id));
  fx.tickets.forEach((t) => validate("Ticket", t, t.id));
  fx.locations.forEach((l) => validate("Location", l, l.id));
  fx.attachments.forEach((a) => validate("Attachment", a, a.id));
  fx.leaders.forEach((l) => validate("Leader", l, l.id));
  fx.classPasses.forEach((c) => validate("ClassPass", c, c.id));
  assert.equal(fx.events.length, 50, "three pages of 20");
  assert.equal(fx.tickets.filter((t) => t.relationships.events.data.some((r) => r.id === fx.MANY)).length, 23, "two pages of tickets");
});

// 2. The mock's responses (lists, single records, errors) match the documented response schemas.
const { server: mock, port, requests, arm, arm429, disarm, setIncludedPlacement, armForeignNext, armLoopNext } = await startMock();
const base = `http://127.0.0.1:${port}/v2`;
const raw = async (path, auth = AUTH) => {
  const res = await fetch(base + path, { headers: { Authorization: auth } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : undefined };
};
await check("mock responses match the documented list, detail and error responses", async () => {
  // Every schema in the spec marks nothing as required, so a schema pass alone would not prove the
  // documented keys are present; assert them explicitly.
  const keys = (obj, ...names) => names.forEach((k) => assert.ok(k in obj, `response is missing "${k}"`));
  const events = (await raw("/events")).json;
  validateResponse("/events", events);
  keys(events, "data", "links");
  keys(events.links, "self", "first", "next");
  assert.equal(events.data.length, PAGE_SIZE);
  assert.match(events.links.next, /\/v2\/events\?page%5Boffset%5D=20$|\/v2\/events\?page\[offset\]=20$/);
  const page2 = (await raw("/events?page[offset]=20")).json;
  validateResponse("/events", page2);
  keys(page2.links, "self", "first", "prev", "next");
  const last = (await raw("/events?page[offset]=40")).json;
  assert.equal(last.data.length, 10);
  assert.equal(last.links.next, undefined, "IndexLinks: elements are only included when relevant");
  const withInc = (await raw("/events?include=location")).json;
  validateResponse("/events", withInc);
  withInc.included.forEach((l) => validate("Location", l, l.id));
  const event = (await raw(`/events/${fx.YOGA}?include=location,tickets,attachments,leaders`)).json;
  validateResponse("/events/{event_id}", event);
  keys(event, "data", "included");
  assert.deepEqual([...new Set(event.included.map((r) => r.type))].sort(), ["attachment", "leader", "location", "ticket"]);
  event.included.filter((r) => r.type === "ticket").forEach((t) => validate("Ticket", t, t.id));
  const tickets = (await raw(`/tickets?event=${fx.MANY}`)).json;
  validateResponse("/tickets", tickets);
  keys(tickets.links, "self", "first", "next");
  assert.match(tickets.links.next, /event=ev-many-20261101090000/, "the next link keeps the event filter");
  const ticket = (await raw(`/tickets/${fx.COURSE_TICKET}?include=events`)).json;
  validateResponse("/tickets/{ticket_id}", ticket);
  ticket.included.forEach((e) => validate("Event", e, e.id));
  validateResponse("/locations", (await raw("/locations")).json);
  validateResponse("/locations/{location_id}", (await raw(`/locations/${fx.STUDIO}`)).json);
  validateResponse("/attachments", (await raw("/attachments?filter[file_type]=pdf")).json);
  validateResponse("/attachments/{attachment_id}", (await raw(`/attachments/${fx.WAIVER}`)).json);
  const limited = await raw("/leaders"); // the mock answers the first leaders call with a 429
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  validateResponse("/leaders", (await raw("/leaders")).json);
  validateResponse("/leaders/{leader_id}", (await raw(`/leaders/${fx.JANE}`)).json);
  validateResponse("/class_passes", (await raw("/class_passes?filter[cost][gte]=2000")).json);
  validateResponse("/class_passes/{class_pass_id}", (await raw("/class_passes/cp-gold10")).json);
  // Spec components.responses: Unauthorized carries a WWW_Authenticate header and no content; ResourceNotFound has no content.
  const unauthorized = await raw("/events", "Basic " + Buffer.from("wrong:").toString("base64"));
  assert.equal(unauthorized.status, 401);
  assert.ok(unauthorized.headers.get("www-authenticate"), "401 should carry WWW-Authenticate");
  assert.equal(unauthorized.text, "");
  const missing = await raw("/events/ev-nope-20260101000000");
  assert.equal(missing.status, 404);
  assert.equal(missing.text, "");
  assert.equal((await raw("/tickets")).status, 400, "`event` is a required query parameter");
});
requests.length = 0; // only count what the MCP server does from here on
arm429();

// 3. Drive the server through MCP.
const connect = async (key, extraEnv = {}) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [`${root}dist/index.js`],
      env: { ...process.env, BOOKWHEN_API_KEY: key, BOOKWHEN_BASE_URL: base, ...extraEnv },
      stderr: "ignore",
    }),
  );
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const TOOLS = ["get_attachment", "get_event", "get_location", "get_ticket", "list_class_passes", "list_event_tickets", "list_events", "list_leaders", "list_locations"];
const PHONES = ["07700 900123", "0117 496 0000", "01234 567890", "+44 7700 900456"];
const noContacts = (text, label) => {
  assert.ok(!text.includes("@example.com"), `${label}: an email address leaked`);
  for (const phone of PHONES) assert.ok(!text.includes(phone), `${label}: phone number ${phone} leaked`);
};

const client = await connect(API_KEY);
console.log("mcp tools");

await check("tools/list exposes 9 read-only tools, none destructive", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} readOnlyHint`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} destructiveHint`);
  }
});

await check("list_events follows links.next (page[offset] 20, 40) to the last page and sends no filter by default", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_events", { max_results: 100 });
  assert.equal(data.count, 50);
  assert.equal(data.complete, true);
  assert.equal(data.note, undefined);
  assert.deepEqual(since(n).map((r) => [r.path, r.query["page[offset]"]]), [["/events", undefined], ["/events", "20"], ["/events", "40"]]);
  // The throttle spaces requests 250 ms apart. Times are taken when the mock receives each request, so a
  // few milliseconds of jitter between the first and second connection are allowed for.
  const times = since(n).map((r) => r.t);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 235, `page requests should be about 250 ms apart (gap ${times[i] - times[i - 1]} ms)`);
  assert.deepEqual(Object.keys(since(n)[0].query), [], "no filter or include is sent unless asked; the API defaults `from` to today");
  assert.equal(data.window.from, "today (API default)");
  const yoga = data.events[0];
  assert.equal(yoga.id, fx.YOGA);
  assert.equal(yoga.title, "Beginners Yoga");
  assert.deepEqual([yoga.attendee_limit, yoga.attendee_count, yoga.spaces_left, yoga.waiting_list], [12, 9, 3, true]);
  assert.equal(yoga.details, "Bring a mat. Questions to [email redacted] or [phone redacted].");
  assert.equal(yoga.location_id, fx.STUDIO);
  assert.equal(yoga.location, undefined, "location is only side-loaded on request");
  assert.deepEqual(yoga.ticket_ids, [fx.YOGA_SINGLE, fx.YOGA_GROUP]);
  assert.deepEqual(yoga.leader_ids, [fx.JANE]);
  assert.equal(yoga.image_url, fx.events[0].attributes.event_image.image_url);
  const retreat = data.events.find((e) => e.id === fx.RETREAT);
  assert.equal(retreat.all_day, true);
  assert.deepEqual(retreat.tags, ["yoga", "retreat", "book by phone [phone redacted]"], "tags are redacted like other free text");
  noContacts(JSON.stringify(data), "list_events");
  const rawTags = await call(client, "list_events", { tags: ["retreat"], include_contact_details: true });
  assert.deepEqual(rawTags.data.events[0].tags, ["yoga", "retreat", "book by phone 07700 900123"]);
});

await check("list_events stops at max_results and says how to see more", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_events", { max_results: 25 });
  assert.equal(data.count, 25);
  assert.equal(data.complete, false);
  assert.match(data.note, /raise max_results/);
  assert.equal(since(n).length, 2, "two pages are enough for 25 results");
});

await check("list_events passes every implemented filter (all documented ones except entry) through as filter[option], comma-separated for multiple values, spaces as %20", async () => {
  const window = await call(client, "list_events", { from: "20261010", to: "20261101" });
  assert.deepEqual(requests.at(-1).query, { "filter[from]": "20261010", "filter[to]": "20261101" });
  assert.deepEqual(window.data.events.map((e) => e.id), fx.COURSE, "to is non-inclusive: the 1 November open day is excluded");
  assert.deepEqual(window.data.window, { from: "20261010", to: "20261101" });
  const precise = await call(client, "list_events", { from: "20261005100000", to: "20261005100001" });
  assert.equal(requests.at(-1).query["filter[from]"], "20261005100000");
  assert.deepEqual(precise.data.events.map((e) => e.id), [fx.YOGA]);
  const tagged = await call(client, "list_events", { tags: ["retreat", "pottery"], max_results: 100 });
  assert.equal(requests.at(-1).query["filter[tag]"], "retreat,pottery");
  assert.deepEqual(tagged.data.events.map((e) => e.id), [...fx.COURSE, fx.RETREAT]);
  const titled = await call(client, "list_events", { title: ["open day", "retreat"] });
  assert.equal(requests.at(-1).query["filter[title]"], "open day,retreat");
  // On the wire, as in the spec's example filter[tag]=tag%20one,tag%20two: a space is %20 (not "+") and the
  // separating comma is literal.
  assert.match(requests.at(-1).raw, /filter(?:\[|%5B)title(?:\]|%5D)=open%20day,retreat(?:&|$)/, `wire form was ${requests.at(-1).raw}`);
  assert.ok(!requests.at(-1).raw.includes("+"), "no form-style + for spaces");
  assert.deepEqual(titled.data.events.map((e) => e.title), ["Open Day", "Retreat weekend"]);
  const detailed = await call(client, "list_events", { detail: ["clay"] });
  assert.equal(requests.at(-1).query["filter[detail]"], "clay");
  assert.equal(detailed.data.count, 3);
  const located = await call(client, "list_events", { location: [fx.HALL], to: "20261101" });
  assert.deepEqual(requests.at(-1).query, { "filter[to]": "20261101", "filter[location]": fx.HALL }, "filters combine");
  assert.deepEqual(located.data.events.map((e) => e.id), fx.COURSE);
  const calendar = await call(client, "list_events", { calendar: ["workshops"], max_results: 100 });
  assert.equal(requests.at(-1).query["filter[calendar]"], "workshops");
  assert.deepEqual(calendar.data.events.map((e) => e.id), [...fx.COURSE, fx.MANY]);
  const compact = await call(client, "list_events", { compact: true, max_results: 100 });
  assert.equal(requests.at(-1).query["filter[compact]"], "true");
  assert.equal(compact.data.count, 48, "the three course events collapse into one");
  const expanded = await call(client, "list_events", { compact: false, max_results: 1 });
  assert.equal(requests.at(-1).query["filter[compact]"], "false");
  assert.equal(expanded.data.count, 1);
  const before = requests.length;
  for (const args of [{ from: "2026-10-01" }, { to: "202610" }, { tags: ["yoga,pilates"] }, { title: [] }]) {
    const bad = await client.callTool({ name: "list_events", arguments: args });
    assert.ok(bad.isError, `list_events should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "invalid filters are refused before any request");
});

await check("list_events include_location sends include=location and resolves each event's location", async () => {
  const { data } = await call(client, "list_events", { include_location: true, max_results: 5 });
  assert.equal(requests.at(-1).query.include, "location");
  assert.equal(data.events[0].location.id, fx.STUDIO);
  assert.equal(data.events[0].location.address, "Studio One\n12 High Street\nBristol\nBS1 4DJ");
  assert.equal(data.events[0].location.additional_info, "Ring the bell. Running late? Call [phone redacted] or email [email redacted].");
  assert.equal(data.events[1].location.id, fx.HALL);
});

let yogaDefault;
await check("get_event side-loads location, tickets with availability, attachments and leaders, redacting contact details by default", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_event", { event_id: fx.YOGA });
  assert.deepEqual(since(n).map((r) => [r.path, r.query.include]), [[`/events/${fx.YOGA}`, "location,tickets,attachments,leaders"]]);
  const e = data.event;
  yogaDefault = e;
  assert.equal(e.title, "Beginners Yoga");
  assert.equal(e.spaces_left, 3);
  assert.equal(e.location.id, fx.STUDIO);
  assert.equal(e.location.additional_info, "Ring the bell. Running late? Call [phone redacted] or email [email redacted].");
  assert.deepEqual(e.tickets.map((t) => [t.id, t.number_issued, t.number_taken, t.spaces_left, t.available]), [[fx.YOGA_SINGLE, 10, 7, 3, true], [fx.YOGA_GROUP, null, 2, null, false]]);
  assert.equal(e.tickets[0].details, "One person, one class. Refunds via [email redacted]");
  assert.deepEqual(e.tickets[0].cost, { currency_code: "GBP", net: 1200, tax: 0, face_value_net: 1200 });
  assert.deepEqual([e.tickets[1].group_ticket, e.tickets[1].group_min, e.tickets[1].group_max, e.tickets[1].available_from], [true, 2, 5, "2026-10-01T00:00:00Z"]);
  assert.deepEqual(e.tickets[1].class_pass_ids, ["cp-family8"]);
  assert.equal(e.tickets[1].basket_path, fx.tickets[1].attributes.built_basket_url);
  assert.deepEqual(e.attachments.map((a) => [a.id, a.title, a.file_type]), [[fx.WAIVER, "Waiver form (return to [email redacted])", "pdf"]]);
  assert.deepEqual(e.leaders.map((l) => [l.name, l.job_title]), [["Jane Smith", "Senior Yoga Instructor"]]);
  assert.equal(e.leaders[0].bio, "Jane has been teaching yoga for over 10 years. Private sessions: [email redacted] or [phone redacted].");
  assert.equal(e.leaders[0].contact_email, undefined, "leader contact email only on request");
  assert.equal(e.leaders[0].contact_phone, undefined, "leader contact phone only on request");
  assert.equal(data.note, undefined);
  const text = JSON.stringify(data);
  noContacts(text, "get_event");
  assert.ok(text.includes(fx.YOGA) && text.includes(fx.YOGA_SINGLE) && text.includes("2026-10-05T10:00:00Z"), "IDs and timestamps are not mistaken for phone numbers");
});

await check("get_event returns contact details when explicitly asked", async () => {
  const { data } = await call(client, "get_event", { event_id: fx.YOGA, include_contact_details: true });
  const e = data.event;
  assert.equal(e.details, "Bring a mat. Questions to jane@example.com or 07700 900123.");
  assert.equal(e.location.additional_info, fx.locations[0].attributes.additional_info);
  assert.equal(e.tickets[0].details, "One person, one class. Refunds via refunds@example.com");
  assert.equal(e.attachments[0].title, "Waiver form (return to admin@example.com)");
  assert.equal(e.leaders[0].bio, fx.leaders[0].attributes.bio);
  assert.deepEqual([e.leaders[0].contact_email, e.leaders[0].contact_phone], ["jane.smith@example.com", "01234 567890"]);
});

await check("get_event reads `included` in the spec's shape (inside the resource) as well as JSON:API's top-level one", async () => {
  setIncludedPlacement("resource");
  const { data } = await call(client, "get_event", { event_id: fx.YOGA });
  assert.deepEqual(data.event, yogaDefault, "same output whichever place the API puts `included`");
  setIncludedPlacement("top");
  const many = await call(client, "get_event", { event_id: fx.MANY });
  assert.equal(many.data.event.tickets.length, 23, "all side-loaded tickets are resolved");
  assert.deepEqual(many.data.event.leaders.map((l) => l.name), ["Jane Smith", "Tom Reed"]);
});

await check("list_event_tickets sends event=<id>, follows the next link (which keeps the event filter) and reports availability", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_event_tickets", { event_id: fx.MANY });
  assert.equal(data.count, 23);
  assert.equal(data.complete, true);
  assert.deepEqual(since(n).map((r) => [r.path, r.query.event, r.query["page[offset]"]]), [["/tickets", fx.MANY, undefined], ["/tickets", fx.MANY, "20"]]);
  assert.deepEqual(data.tickets[0], {
    id: "ti-many-20261101090000-t01", title: "Taster 1", details: "30 minutes.", available: true, number_issued: 6, number_taken: 0, spaces_left: 6,
    course_ticket: false, group_ticket: false, cost: { currency_code: "GBP", net: 500, tax: 0, face_value_net: 500 },
    basket_path: "/pagecode/basket_items/apply?basket_item_ids%5Bti-many-20261101090000-t01%5D=1", event_ids: [fx.MANY], class_pass_ids: ["cp-gold10", "cp-silver5", "cp-trial1"],
  });
  assert.match(data.cost_note, /smallest unit/);
  const course = await call(client, "list_event_tickets", { event_id: fx.COURSE[1] });
  assert.deepEqual(course.data.tickets.map((t) => [t.id, t.course_ticket, t.spaces_left, t.event_ids.length]), [[fx.COURSE_TICKET, true, 0, 3]]);
  const capped = await call(client, "list_event_tickets", { event_id: fx.MANY, max_results: 20 });
  assert.equal(capped.data.count, 20);
  assert.equal(capped.data.complete, false);
  assert.match(capped.data.note, /raise max_results/);
});

await check("get_ticket sends include=events and lists every event a course ticket books onto", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_ticket", { ticket_id: fx.COURSE_TICKET });
  assert.deepEqual(since(n).map((r) => [r.path, r.query.include]), [[`/tickets/${fx.COURSE_TICKET}`, "events"]]);
  assert.equal(data.ticket.course_ticket, true);
  assert.deepEqual(data.ticket.cost, { currency_code: "GBP", net: 9000, tax: 0, face_value_net: 6000 });
  assert.deepEqual(data.ticket.events.map((e) => [e.id, e.title, e.start_at]), fx.COURSE.map((id, i) => [id, `Pottery Course (week ${i + 1} of 3)`, `2026-10-${12 + 7 * i}T18:00:00Z`]));
});

await check("list_locations passes address_text and additional_info filters; get_location; location text redacted by default", async () => {
  const all = await call(client, "list_locations");
  assert.deepEqual(requests.at(-1).query, {});
  assert.deepEqual(all.data.locations.map((l) => l.id), [fx.STUDIO, fx.HALL]);
  assert.equal(all.data.locations[0].additional_info, "Ring the bell. Running late? Call [phone redacted] or email [email redacted].");
  assert.deepEqual([all.data.locations[0].latitude, all.data.locations[0].longitude], [51.4545, -2.5879]);
  const byAddress = await call(client, "list_locations", { address_text: "Keynsham" });
  assert.deepEqual(requests.at(-1).query, { "filter[address_text]": "Keynsham" });
  assert.deepEqual(byAddress.data.locations.map((l) => l.id), [fx.HALL]);
  const byInfo = await call(client, "list_locations", { additional_info: "bell" });
  assert.deepEqual(requests.at(-1).query, { "filter[additional_info]": "bell" });
  assert.deepEqual(byInfo.data.locations.map((l) => l.id), [fx.STUDIO]);
  const one = await call(client, "get_location", { location_id: fx.STUDIO, include_contact_details: true });
  assert.equal(requests.at(-1).path, `/locations/${fx.STUDIO}`);
  assert.equal(one.data.location.additional_info, fx.locations[0].attributes.additional_info);
  assert.match(one.data.location.map_url, /staticmap\.png/);
});

await check("list_class_passes passes text, usage_type and comparison filters through as documented", async () => {
  const all = await call(client, "list_class_passes");
  assert.deepEqual(requests.at(-1).query, {});
  assert.deepEqual(all.data.class_passes.map((c) => c.id), ["cp-gold10", "cp-silver5", "cp-trial1", "cp-family8"]);
  assert.deepEqual(all.data.class_passes[0], { id: "cp-gold10", title: "Gold pass", details: "10 classes, personal use. Queries: [email redacted]", usage_allowance: 10, usage_type: "personal", number_available: 20, use_restricted_for_days: 60 });
  assert.deepEqual([all.data.class_passes[2].number_available, all.data.class_passes[2].use_restricted_for_days], [null, null]);
  assert.equal(all.data.note, undefined);
  assert.match(all.data.cost_note, /no cost field/);
  const capped = await call(client, "list_class_passes", { max_results: 2 });
  assert.match(capped.data.note, /raise max_results/);
  assert.match(capped.data.cost_note, /no cost field/, "the cost explanation is kept when the list is capped");
  const byTitle = await call(client, "list_class_passes", { title: "gold" });
  assert.deepEqual(requests.at(-1).query, { "filter[title]": "gold" });
  assert.deepEqual(byTitle.data.class_passes.map((c) => c.id), ["cp-gold10"]);
  const byDetail = await call(client, "list_class_passes", { detail: "newcomers" });
  assert.deepEqual(requests.at(-1).query, { "filter[detail]": "newcomers" });
  assert.deepEqual(byDetail.data.class_passes.map((c) => c.id), ["cp-trial1"]);
  const byUsage = await call(client, "list_class_passes", { usage_type: "any" });
  assert.deepEqual(requests.at(-1).query, { "filter[usage_type]": "any" });
  assert.deepEqual(byUsage.data.class_passes.map((c) => c.id), ["cp-family8"]);
  const exact = await call(client, "list_class_passes", { cost: 6500 });
  assert.deepEqual(requests.at(-1).query, { "filter[cost]": "6500" });
  assert.deepEqual(exact.data.class_passes.map((c) => c.id), ["cp-silver5"]);
  const range = await call(client, "list_class_passes", { cost: { gte: 2000, lt: 3000 } }); // the spec's own example
  assert.deepEqual(requests.at(-1).query, { "filter[cost][gte]": "2000", "filter[cost][lt]": "3000" });
  assert.deepEqual(range.data.class_passes.map((c) => c.id), ["cp-trial1"]);
  const allowance = await call(client, "list_class_passes", { usage_allowance: { gte: 8 }, usage_type: "personal" });
  assert.deepEqual(requests.at(-1).query, { "filter[usage_type]": "personal", "filter[usage_allowance][gte]": "8" });
  assert.deepEqual(allowance.data.class_passes.map((c) => c.id), ["cp-gold10"]);
  const days = await call(client, "list_class_passes", { use_restricted_for_days: { lte: 30 } });
  assert.deepEqual(requests.at(-1).query, { "filter[use_restricted_for_days][lte]": "30" });
  assert.deepEqual(days.data.class_passes.map((c) => c.id), ["cp-silver5"]);
  const gtEq = await call(client, "list_class_passes", { usage_allowance: { gt: 5, eq: 8 } });
  assert.deepEqual(requests.at(-1).query, { "filter[usage_allowance][gt]": "5", "filter[usage_allowance][eq]": "8" });
  assert.deepEqual(gtEq.data.class_passes.map((c) => c.id), ["cp-family8"]);
  const before = requests.length;
  // An empty or mistyped comparison object would otherwise be accepted and send no filter at all.
  for (const args of [{ usage_type: "shared" }, { cost: {} }, { cost: { foo: 5 } }, { usage_allowance: { ge: 5 } }, { cost: { gte: -1 } }]) {
    const bad = await client.callTool({ name: "list_class_passes", arguments: args });
    assert.ok(bad.isError, `list_class_passes should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "invalid filters are refused before any request");
});

await check("list_leaders (after a 429 retry that waits for Retry-After) hides contact email and phone unless asked", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_leaders");
  const tries = since(n).filter((r) => r.path === "/leaders");
  assert.equal(tries.length, 2, "leaders should be retried once after 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.deepEqual(data.leaders.map((l) => [l.id, l.name, l.job_title, l.location]), [[fx.JANE, "Jane Smith", "Senior Yoga Instructor", "Bristol, UK"], [fx.TOM, "Tom Reed", "Ceramics Tutor", "Keynsham, UK"]]);
  assert.equal(data.leaders[0].bio, "Jane has been teaching yoga for over 10 years. Private sessions: [email redacted] or [phone redacted].");
  assert.deepEqual(data.leaders[0].social_feeds, [{ type: "instagram", url: "https://www.instagram.com/p/example" }]);
  assert.deepEqual([data.leaders[0].website, data.leaders[0].avatar_url], ["https://www.example.com/jane", "https://www.example.com/jane.jpg"], "URLs are passed through");
  for (const l of data.leaders) assert.ok(!("contact_email" in l) && !("contact_phone" in l), "contact fields absent by default");
  noContacts(JSON.stringify(data), "list_leaders");
  const withContact = await call(client, "list_leaders", { include_contact_details: true });
  assert.deepEqual(withContact.data.leaders.map((l) => [l.contact_email, l.contact_phone]), [["jane.smith@example.com", "01234 567890"], ["tom@example.com", "+44 7700 900456"]]);
  assert.equal(withContact.data.leaders[0].bio, fx.leaders[0].attributes.bio);
});

await check("get_attachment returns the file details and download URL", async () => {
  const { data } = await call(client, "get_attachment", { attachment_id: fx.WAIVER });
  assert.equal(requests.at(-1).path, `/attachments/${fx.WAIVER}`);
  assert.deepEqual(data.attachment, {
    id: fx.WAIVER, title: "Waiver form (return to [email redacted])", file_name: "waiver.pdf", file_type: "pdf", content_type: "application/pdf",
    file_size_bytes: 47070, file_size_text: "46 KB", file_url: `https://files.bookwhen.com/amplt327zhcc/${fx.WAIVER}/uploaded_file`,
  });
  const rawTitle = await call(client, "get_attachment", { attachment_id: fx.WAIVER, include_contact_details: true });
  assert.equal(rawTitle.data.attachment.title, "Waiver form (return to admin@example.com)");
});

await check("a next-page link on another host is not followed, and a repeated next link stops the loop; both are reported", async () => {
  armForeignNext();
  let n = requests.length;
  const { res, data } = await call(client, "list_events", { max_results: 100 });
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.count, PAGE_SIZE, "only the first page");
  assert.equal(data.complete, false);
  assert.match(data.note, new RegExp(`next-page link to ${new URL(FOREIGN_NEXT).origin.replace(/\./g, "\\.")}/v2/events, which is not under the configured Bookwhen API base URL`));
  assert.equal(since(n).length, 1, "no request left the mock");
  armLoopNext();
  n = requests.length;
  const loop = await call(client, "list_events", { max_results: 100 });
  assert.ok(!loop.res.isError, loop.text);
  assert.equal(loop.data.count, 2 * PAGE_SIZE, "the two pages before the loop are kept");
  assert.equal(loop.data.complete, false);
  assert.match(loop.data.note, /same next-page link twice/);
  assert.deepEqual(since(n).map((r) => r.query["page[offset]"]), [undefined, "20"], "the repeated link is requested once, not again");
});

await check("bad IDs are rejected before any API call; unknown IDs give a clear 404", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_event", { event_id: "../events" }],
    ["get_ticket", { ticket_id: "has space" }],
    ["get_location", { location_id: "" }],
    ["get_attachment", { attachment_id: "a/b" }],
    ["list_event_tickets", { event_id: "ev-x?include=leaders" }],
    ["get_location", { location_id: "x".repeat(81) }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid IDs");
  const missing = await call(client, "get_event", { event_id: "ev-nope-20260101000000" });
  assert.ok(missing.res.isError);
  assert.equal(missing.text, "Not found: /events/ev-nope-20260101000000. Check the ID.");
  // The spec documents the 404 body as empty; if the live API sends JSON:API errors, their text is appended after redaction.
  arm({ method: "GET", path: "/events/ev-gone-20260101000000", status: 404, body: { errors: [{ title: "Not Found", detail: "No event for owner@example.com; ring 07700 900999" }] } });
  const gone = await call(client, "get_event", { event_id: "ev-gone-20260101000000" });
  assert.equal(gone.text, "Not found: /events/ev-gone-20260101000000. Check the ID. Not Found: No event for [email redacted]; ring [phone redacted]");
  disarm();
  const missingTicket = await call(client, "get_ticket", { ticket_id: "ti-nope-20260101000000-tk1m" });
  assert.equal(missingTicket.text, "Not found: /tickets/ti-nope-20260101000000-tk1m. Check the ID.");
  const noEvent = await call(client, "list_event_tickets", { event_id: "ev-nope-20260101000000" });
  assert.ok(noEvent.res.isError);
  assert.equal(noEvent.text, "No event with ID ev-nope-20260101000000 was found (Bookwhen answered 404 for GET /tickets?event=ev-nope-20260101000000). Check the event ID with list_events.");
});

await check("a persistent 429 gives up after 3 attempts with the rate-limit message", async () => {
  arm429({ persistent: true });
  const n = requests.length;
  const { res, text } = await call(client, "list_leaders");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/leaders").length, 3, "exactly three attempts");
  assert.equal(text, "Bookwhen rate limit reached (the limit is not documented). Wait a minute and try again.");
  disarm();
});

await check("a Retry-After longer than the cap makes the call give up at once, naming the wait", async () => {
  arm429({ retryAfter: "600" });
  const n = requests.length;
  const { res, text } = await call(client, "list_leaders");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/leaders").length, 1, "no retry when the server asks for a wait longer than the cap");
  assert.match(text, /asked to wait 600 seconds before retrying GET \/leaders \(HTTP 429\)/);
  disarm();
});

await check("an HTTP-date Retry-After is honoured, and a fractional one is read as seconds", async () => {
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  let n = requests.length;
  assert.ok(!(await call(client, "list_leaders")).res.isError);
  let tries = since(n).filter((r) => r.path === "/leaders");
  assert.equal(tries.length, 2);
  let gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (3.5 to 5 s), not retry at once or use the 2 s fallback (waited ${gap} ms)`);
  arm429({ retryAfter: "1.5" }); // Date.parse("1.5") is a date in 2001, which would mean "retry now"
  n = requests.length;
  assert.ok(!(await call(client, "list_leaders")).res.isError);
  tries = since(n).filter((r) => r.path === "/leaders");
  assert.equal(tries.length, 2);
  gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("a 429 without a Retry-After header is retried after the 2 s fallback", async () => {
  arm429({ retryAfter: null });
  const n = requests.length;
  const { res, text } = await call(client, "list_leaders");
  assert.ok(!res.isError, text);
  const tries = since(n).filter((r) => r.path === "/leaders");
  assert.equal(tries.length, 2);
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 2000 && gap < 2900, `retry should wait the 2 s fallback (waited ${gap} ms)`);
  disarm();
});

await check("a 504 on a GET is retried like 502 and 503", async () => {
  arm({ method: "GET", path: "/locations", status: 504, headers: { "Retry-After": "0" } });
  const n = requests.length;
  const { res, data, text } = await call(client, "list_locations");
  assert.ok(!res.isError, text);
  assert.equal(data.count, 2);
  assert.equal(since(n).filter((r) => r.path === "/locations").length, 2, "one 504, then success");
  disarm();
});

await check("a 502 on a GET is retried once; a GET failing three times with 503 gives up with advice and without the gateway's HTML", async () => {
  arm({ method: "GET", path: "/locations", status: 502, headers: { "Retry-After": "0" } });
  let n = requests.length;
  const ok = await call(client, "list_locations");
  assert.ok(!ok.res.isError, ok.text);
  assert.equal(ok.data.count, 2);
  assert.equal(since(n).filter((r) => r.path === "/locations").length, 2);
  disarm();
  arm({ method: "GET", path: "/locations", status: 503, times: 3, headers: { "Retry-After": "0" } });
  n = requests.length;
  const { res, text } = await call(client, "list_locations");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/locations").length, 3);
  assert.equal(text, "Bookwhen returned 503 for GET /locations 3 times in a row. The service may be unavailable; try again in a few minutes.");
  disarm();
});

await check("a 200 whose body is not JSON is an error, not an empty list, and the quoted start of the page is redacted", async () => {
  arm({ method: "GET", path: "/events", status: 200 }); // the mock answers with its own HTML page
  const { res, text } = await call(client, "list_events");
  assert.ok(res.isError, `a non-JSON 200 must not be reported as success: ${text}`);
  assert.match(text, /returned 200 for GET \/events but the body was not JSON \(starts with: "<html>.*Check BOOKWHEN_BASE_URL/);
  disarm();
  arm({ method: "GET", path: "/events", status: 200, text: "<html>contact studio@example.com or 07700 900123 now</html>" });
  const leaky = await call(client, "list_events");
  assert.ok(leaky.res.isError);
  assert.match(leaky.text, /starts with: "<html>contact \[email redacted\] or \[phone redacted\] now/);
  noContacts(leaky.text, "non-JSON 200");
  disarm();
  assert.ok(!(await call(client, "list_events", { max_results: 1 })).res.isError);
});

await check("an error body that echoes the API key or the Basic header is redacted before it reaches the tool output", async () => {
  const b64 = Buffer.from(`${API_KEY}:`).toString("base64");
  arm({ method: "GET", path: `/locations/${fx.STUDIO}`, status: 401, body: { errors: [{ title: "Unauthorized", detail: `Bad API key ${API_KEY}` }] } });
  const unauthorized = await call(client, "get_location", { location_id: fx.STUDIO });
  assert.ok(unauthorized.res.isError);
  assert.match(unauthorized.text, /rejected the API key \(401\).*Unauthorized: Bad API key \[key redacted\]$/);
  arm({ method: "GET", path: "/locations/nope", status: 404, text: `no route; auth header was Basic ${b64}` });
  const missing = await call(client, "get_location", { location_id: "nope" });
  assert.equal(missing.text, "Not found: /locations/nope. Check the ID. no route; auth header was [key redacted]");
  arm({ method: "GET", path: "/locations", status: 503, times: 3, headers: { "Retry-After": "0" }, body: { message: `upstream refused key ${API_KEY}` } });
  const down = await call(client, "list_locations");
  assert.match(down.text, /3 times in a row.*upstream refused key \[key redacted\]$/);
  arm({ method: "GET", path: "/events", status: 200, text: `<html>Basic ${b64} ${API_KEY}</html>` });
  const html = await call(client, "list_events");
  assert.match(html.text, /starts with: "<html>\[key redacted\] \[key redacted\]/);
  for (const t of [unauthorized.text, missing.text, down.text, html.text]) {
    assert.ok(!t.includes(API_KEY), `the API key leaked: ${t}`);
    assert.ok(!t.includes(b64), `the Basic header leaked: ${t}`);
  }
  disarm();
});

await check("every request used Basic auth base64(key:) and a documented method+path; only the nine tools' endpoints were hit", async () => {
  const templates = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== "parameters").map((m) => ({ m: m.toUpperCase(), p, re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$") })));
  assert.ok(requests.length > 40);
  const used = new Set();
  for (const r of requests) {
    assert.equal(r.auth, `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`);
    assert.equal(r.method, "GET");
    assert.equal(r.body, undefined);
    const t = templates.find((t) => t.m === r.method && t.re.test(r.path));
    assert.ok(t, `undocumented call ${r.method} ${r.path}`);
    used.add(`${t.m} ${t.p}`);
    // Only documented query parameters: filter[...] (events, locations, class_passes), include (events, tickets), event (tickets), page[offset] (from links.next).
    for (const k of Object.keys(r.query)) {
      const allowed = k === "page[offset]" || (k === "include" && (r.path.startsWith("/events") || r.path.startsWith("/tickets"))) || (k === "event" && r.path === "/tickets") || (/^filter\[/.test(k) && ["/events", "/locations", "/class_passes"].includes(r.path));
      assert.ok(allowed, `undocumented query parameter ${k} on ${r.path}`);
    }
  }
  assert.deepEqual([...used].sort(), [
    "GET /attachments/{attachment_id}", "GET /class_passes", "GET /events", "GET /events/{event_id}", "GET /leaders", "GET /locations", "GET /locations/{location_id}", "GET /tickets", "GET /tickets/{ticket_id}",
  ]);
});
await client.close();

await check("there is no write gate: BOOKWHEN_ALLOW_WRITES has no effect because the API has no write endpoints", async () => {
  const c = await connect(API_KEY, { BOOKWHEN_ALLOW_WRITES: "true" });
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true);
  await c.close();
});

await check("a wrong API key gives an actionable error", async () => {
  const bad = await connect("wrong-key");
  const { res, text } = await call(bad, "list_events");
  assert.ok(res.isError);
  assert.match(text, /rejected the API key \(401\)\. Check BOOKWHEN_API_KEY: .*HTTP Basic username with a blank password/);
  await bad.close();
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock.`);
