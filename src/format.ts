// Turn Bookwhen JSON:API records into compact objects an assistant can read quickly.
// Field names follow the schemas in Bookwhen's OpenAPI spec (Event, Ticket, Location, Attachment,
// Leader, ClassPass).
import type { JsonApiResource } from "./client.js";

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Three shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958, 00 44 7700 900123);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000, (07700) 900789);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07 700 900 789, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so Bookwhen IDs such as
// ev-sboe-20200320100000 and ti-sboe-20200320100000-tk1m, ISO timestamps and hyphenated references are
// left alone. Any other 9-11 digit string starting with 0 (an order number, say) is redacted too; the
// raw text is available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;

const redactString = (text: string) => text.replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]");

/**
 * Replace email addresses and phone-number-like sequences inside free text (event details, leader
 * bios, location notes, ticket and class pass details, titles) unless contact details were requested.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? text : redactString(text);
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

/** Side-loaded resources keyed by "type:id". */
export type Included = Map<string, JsonApiResource>;

export function indexIncluded(resources: JsonApiResource[]): Included {
  const map: Included = new Map();
  for (const r of resources) if (r && typeof r.id === "string" && typeof r.type === "string") map.set(`${r.type}:${r.id}`, r);
  return map;
}

/** IDs in a relationship's `data` (a single ref or an array of refs). */
export function refIds(rel: unknown): string[] {
  const data = (rel as Rec | undefined)?.data;
  const refs: unknown[] = Array.isArray(data) ? data : data ? [data] : [];
  return refs.map((x) => (x as Rec)?.id).filter((id): id is string => typeof id === "string");
}

function resolve(rel: unknown, type: string, inc: Included): JsonApiResource[] {
  return refIds(rel).map((id) => inc.get(`${type}:${id}`)).filter((r): r is JsonApiResource => !!r);
}

// ---- Event ----

export function event(r: JsonApiResource, inc: Included, includeContact: boolean) {
  const a = r.attributes ?? {};
  const rel = r.relationships ?? {};
  const limit = num(a.attendee_limit);
  const count = num(a.attendee_count);
  const locationId = refIds(rel.location)[0];
  const loc = locationId ? inc.get(`location:${locationId}`) : undefined;
  return {
    id: r.id,
    title: redactContacts(a.title, includeContact),
    start_at: str(a.start_at),
    end_at: str(a.end_at),
    all_day: bool(a.all_day),
    attendee_limit: limit,
    attendee_count: count,
    // Derived: attendee_limit minus attendee_count, when both are present.
    spaces_left: limit !== undefined && count !== undefined ? limit - count : undefined,
    waiting_list: bool(a.waiting_list),
    max_tickets_per_booking: num(a.max_tickets_per_booking),
    // Tags are admin-typed text too, so they get the same redaction as the other free-text fields.
    tags: Array.isArray(a.tags) ? a.tags.map((t: unknown) => redactContacts(String(t), includeContact) ?? "") : undefined,
    details: redactContacts(a.details, includeContact),
    image_url: str(a.event_image?.image_url),
    location_id: locationId,
    location: loc ? location(loc, includeContact) : undefined,
    ticket_ids: refIds(rel.tickets),
    attachment_ids: refIds(rel.attachments),
    leader_ids: refIds(rel.leaders),
  };
}

/** An event with its side-loaded location, tickets, attachments and leaders (GET /events/{id}?include=...). */
export function eventDetail(r: JsonApiResource, inc: Included, includeContact: boolean) {
  const rel = r.relationships ?? {};
  return {
    ...event(r, inc, includeContact),
    tickets: resolve(rel.tickets, "ticket", inc).map((t) => ticket(t, inc, includeContact)),
    attachments: resolve(rel.attachments, "attachment", inc).map((x) => attachment(x, includeContact)),
    leaders: resolve(rel.leaders, "leader", inc).map((l) => leader(l, includeContact)),
  };
}

// ---- Ticket ----

export function ticket(r: JsonApiResource, inc: Included, includeContact: boolean) {
  const a = r.attributes ?? {};
  const rel = r.relationships ?? {};
  // Spec: number_issued "If null then no limit has been set".
  const issued = num(a.number_issued);
  const taken = num(a.number_taken);
  const cost = a.cost && typeof a.cost === "object" ? a.cost : undefined;
  const events = resolve(rel.events, "event", inc);
  return {
    id: r.id,
    title: redactContacts(a.title, includeContact),
    details: redactContacts(a.details, includeContact),
    available: bool(a.available),
    available_from: str(a.available_from),
    available_to: str(a.available_to),
    number_issued: issued ?? null,
    number_taken: taken,
    // Derived: number_issued minus number_taken; null when no limit is set.
    spaces_left: issued !== undefined && taken !== undefined ? issued - taken : null,
    course_ticket: bool(a.course_ticket),
    group_ticket: bool(a.group_ticket),
    group_min: num(a.group_min),
    group_max: num(a.group_max),
    // Spec: net, tax and face_value_net are "stated in the currency smallest units. eg. 1000 is $10".
    cost: cost ? { currency_code: str(cost.currency_code), net: num(cost.net), tax: num(cost.tax), face_value_net: num(cost.face_value_net) } : undefined,
    basket_path: str(a.built_basket_url),
    event_ids: refIds(rel.events),
    events: events.length ? events.map((e) => ({ id: e.id, title: redactContacts(e.attributes?.title, includeContact), start_at: str(e.attributes?.start_at), end_at: str(e.attributes?.end_at) })) : undefined,
    class_pass_ids: refIds(rel.class_passes),
  };
}

// ---- Location ----

export function location(r: JsonApiResource, includeContact: boolean) {
  const a = r.attributes ?? {};
  return {
    id: r.id,
    address: redactContacts(a.address_text, includeContact),
    additional_info: redactContacts(a.additional_info, includeContact),
    latitude: num(a.latitude),
    longitude: num(a.longitude),
    map_url: str(a.map_url),
  };
}

// ---- Attachment ----

export function attachment(r: JsonApiResource, includeContact: boolean) {
  const a = r.attributes ?? {};
  return {
    id: r.id,
    title: redactContacts(a.title, includeContact),
    file_name: redactContacts(a.file_name, includeContact),
    file_type: str(a.file_type),
    content_type: str(a.content_type),
    file_size_bytes: num(a.file_size_bytes), // spec types it as a string ("47070")
    file_size_text: str(a.file_size_text),
    file_url: str(a.file_url), // spec: "should be used instead of the forwarded URL due to file access policies"
  };
}

// ---- Leader ----

// The spec calls contact_email and contact_phone "Public contact email address" / "Public contact phone
// number", but they are a person's contact details, so they are only returned on request. The name,
// job title, bio, location and links are always returned, minus any email or phone typed into them.
export function leader(r: JsonApiResource, includeContact: boolean) {
  const a = r.attributes ?? {};
  return {
    id: r.id,
    name: redactContacts(a.name, includeContact),
    job_title: redactContacts(a.job_title, includeContact),
    location: redactContacts(a.location, includeContact),
    bio: redactContacts(a.bio, includeContact),
    website: redactContacts(a.website, includeContact),
    avatar_url: str(a.avatar_url),
    // The feed type is redacted like the other text fields; the URL is passed through as stored.
    social_feeds: Array.isArray(a.social_feeds) ? a.social_feeds.map((s: Rec) => ({ type: redactContacts(s?.type, includeContact), url: str(s?.url) })) : undefined,
    ...(includeContact ? { contact_email: str(a.contact_email), contact_phone: str(a.contact_phone) } : {}),
  };
}

// ---- Class pass ----

export function classPass(r: JsonApiResource, includeContact: boolean) {
  const a = r.attributes ?? {};
  return {
    id: r.id,
    title: redactContacts(a.title, includeContact),
    details: redactContacts(a.details, includeContact),
    usage_allowance: num(a.usage_allowance),
    usage_type: str(a.usage_type), // "personal" (booker only) or "any" (additional attendees too)
    number_available: num(a.number_available) ?? null, // spec: null when no limit is set
    use_restricted_for_days: num(a.use_restricted_for_days) ?? null, // spec: null when no restriction
  };
}
