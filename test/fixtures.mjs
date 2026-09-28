// Fake Bookwhen data shaped exactly like the published OpenAPI schemas (validated in e2e.mjs).
// Links inside records point at the real API host, as the spec's examples do; the server never
// follows `self` links, only the list-level `links.next` that the mock builds on its own host.
const BASE = "https://api.bookwhen.com/v2";
const IMG = "https://d3vytqo793z7ur.cloudfront.net/attachments/amplt327zhcc";

const ref = (type, id) => ({ id, type });
const relOne = (type, id, parent) => ({ data: ref(type, id), links: { related: `${parent}/${type}`, self: `${parent}/relationships/${type}` } });
const relMany = (type, ids, parent, plural = `${type}s`) => ({ data: ids.map((id) => ref(type, id)), links: { related: `${parent}/${plural}`, self: `${parent}/relationships/${plural}` } });

// ---- Locations (Location) ----
export const STUDIO = "sjm7pskr31t3";
export const HALL = "o4pgtyi38gk1";
export const locations = [
  {
    id: STUDIO,
    type: "location",
    attributes: {
      address_text: "Studio One\n12 High Street\nBristol\nBS1 4DJ",
      // Contact details typed into free text, to prove they are redacted by default.
      additional_info: "Ring the bell. Running late? Call 0117 496 0000 or email studio@example.com.",
      latitude: 51.4545,
      longitude: -2.5879,
      zoom: 15,
      map_url: "https://d3vytqo793z7ur.cloudfront.net/maps/amplt327zhcc/sjm7pskr31t3/staticmap.png?v=20260901120000",
    },
    links: { self: `${BASE}/locations/${STUDIO}` },
  },
  {
    id: HALL,
    type: "location",
    attributes: {
      address_text: "Community Hall\nChurch Lane\nKeynsham\nBS31 1DY",
      additional_info: "Free parking behind the hall.",
      latitude: 51.4137,
      longitude: -2.4966,
      zoom: 14,
      map_url: "https://d3vytqo793z7ur.cloudfront.net/maps/amplt327zhcc/o4pgtyi38gk1/staticmap.png?v=20260901120000",
    },
    links: { self: `${BASE}/locations/${HALL}` },
  },
];

// ---- Leaders (Leader) ----
export const JANE = "g189gdkucw7r";
export const TOM = "h2k3l4m5n6o7";
export const leaders = [
  {
    id: JANE,
    type: "leader",
    attributes: {
      name: "Jane Smith",
      // An email and a phone number in the bio, to prove free text is redacted by default.
      bio: "Jane has been teaching yoga for over 10 years. Private sessions: jane@example.com or 07700 900123.",
      job_title: "Senior Yoga Instructor",
      location: "Bristol, UK",
      contact_email: "jane.smith@example.com",
      contact_phone: "01234 567890",
      website: "https://www.example.com/jane",
      avatar_url: "https://www.example.com/jane.jpg",
      social_feeds: [{ type: "instagram", url: "https://www.instagram.com/p/example" }],
    },
    links: { self: `${BASE}/leaders/${JANE}` },
  },
  {
    id: TOM,
    type: "leader",
    attributes: {
      name: "Tom Reed",
      bio: "Potter and tutor.",
      job_title: "Ceramics Tutor",
      location: "Keynsham, UK",
      contact_email: "tom@example.com",
      contact_phone: "+44 7700 900456",
      website: "https://www.example.com/tom",
      avatar_url: "https://www.example.com/tom.jpg",
      social_feeds: [],
    },
    links: { self: `${BASE}/leaders/${TOM}` },
  },
];

// ---- Attachments (Attachment) ----
export const WAIVER = "9v06h1cbv0en";
export const PHOTO = "a1b2c3d4e5f6";
export const attachments = [
  {
    id: WAIVER,
    type: "attachment",
    attributes: {
      title: "Waiver form (return to admin@example.com)",
      file_url: `https://files.bookwhen.com/amplt327zhcc/${WAIVER}/uploaded_file`,
      file_size_bytes: "47070",
      file_size_text: "46 KB",
      file_name: "waiver.pdf",
      file_type: "pdf",
      content_type: "application/pdf",
    },
    links: { self: `${BASE}/attachments/${WAIVER}` },
  },
  {
    id: PHOTO,
    type: "attachment",
    attributes: {
      title: "Studio photo",
      file_url: `https://files.bookwhen.com/amplt327zhcc/${PHOTO}/uploaded_file`,
      file_size_bytes: "204800",
      file_size_text: "200 KB",
      file_name: "studio.jpg",
      file_type: "image",
      content_type: "image/jpeg",
    },
    links: { self: `${BASE}/attachments/${PHOTO}` },
  },
];

// ---- Class passes (ClassPass) ----
// The ClassPass schema has no cost attribute although GET /class_passes can be filtered by cost, so
// the mock keeps each pass's cost here, outside the record it serves.
export const classPassCosts = { "cp-gold10": 12000, "cp-silver5": 6500, "cp-trial1": 2000, "cp-family8": 9900 };
const pass = (id, title, details, usage_allowance, usage_type, extra = {}) => ({
  id,
  type: "class_pass",
  attributes: { title, details, usage_allowance, usage_type, ...extra },
  links: { self: `${BASE}/class_passes/${id}` },
});
export const classPasses = [
  // number_available and use_restricted_for_days are documented as "Null" when unset but typed as
  // plain integers, so the fixtures omit them instead of storing null.
  pass("cp-gold10", "Gold pass", "10 classes, personal use. Queries: passes@example.com", 10, "personal", { number_available: 20, use_restricted_for_days: 60 }),
  pass("cp-silver5", "Silver pass", "5 classes.", 5, "personal", { use_restricted_for_days: 30 }),
  pass("cp-trial1", "Trial class", "One class for newcomers.", 1, "personal"),
  pass("cp-family8", "Family pass", "8 classes, any attendee on the booking.", 8, "any", { number_available: 5 }),
];

// ---- Events (Event) and tickets (Ticket) ----
const eventImage = (name) => ({
  image_url: `${IMG}/gx5xbe4scgb4/processed/g9z3vseolvhu/${name}.jpg`,
  alt_ratio_16x9_1x_url: `${IMG}/gx5xbe4scgb4/processed/g9z3vseolvhu/alt_ratio_16x9_1x_${name}.jpg`,
  alt_ratio_16x9_2x_url: `${IMG}/gx5xbe4scgb4/processed/g9z3vseolvhu/alt_ratio_16x9_2x_${name}.jpg`,
  alt_ratio_16x9_3x_url: `${IMG}/gx5xbe4scgb4/processed/g9z3vseolvhu/alt_ratio_16x9_3x_${name}.jpg`,
  alt_ratio_4x3_1x_url: `${IMG}/gx5xbe4scgb4/processed/g9z3vseolvhu/alt_ratio_4x3_1x_${name}.jpg`,
  alt_ratio_4x3_2x_url: `${IMG}/gx5xbe4scgb4/processed/g9z3vseolvhu/alt_ratio_4x3_2x_${name}.jpg`,
  alt_ratio_4x3_3x_url: `${IMG}/gx5xbe4scgb4/processed/g9z3vseolvhu/alt_ratio_4x3_3x_${name}.jpg`,
  alt_ratio_1x1_1x_url: `${IMG}/gx5xbe4scgb4/processed/g9z3vseolvhu/alt_ratio_1x1_1x_${name}.jpg`,
  alt_ratio_1x1_2x_url: `${IMG}/gx5xbe4scgb4/processed/g9z3vseolvhu/alt_ratio_1x1_2x_${name}.jpg`,
  alt_ratio_1x1_3x_url: `${IMG}/gx5xbe4scgb4/processed/g9z3vseolvhu/alt_ratio_1x1_3x_${name}.jpg`,
});

const mkEvent = (id, { title, details, start, end, all_day = false, limit, count, waiting_list = false, max_per_booking = 5, tags, location, tickets, attachments = [], leaders = [] }) => {
  const self = `${BASE}/events/${id}`;
  return {
    id,
    type: "event",
    attributes: { title, details, all_day, start_at: start, end_at: end, attendee_limit: limit, attendee_count: count, waiting_list, max_tickets_per_booking: max_per_booking, tags, event_image: eventImage("Hero13") },
    relationships: {
      location: relOne("location", location, self),
      attachments: relMany("attachment", attachments, self),
      tickets: relMany("ticket", tickets, self),
      leaders: relMany("leader", leaders, self),
    },
    links: { self },
  };
};

const mkTicket = (id, eventIds, { title, details, issued, taken, course = false, group = false, group_min, group_max, available = true, available_from, available_to, net = 1200, tax = 0, face = net, class_passes = [] }) => {
  const self = `${BASE}/tickets/${id}`;
  const enc = encodeURIComponent(`basket_item_ids[${id}]`);
  return {
    id,
    type: "ticket",
    attributes: {
      title,
      details,
      // number_issued is "null" when no limit is set per the spec's description, but its schema type is a
      // plain number, so the fixture omits it in that case; the same for available_from/to.
      ...(issued === null ? {} : { number_issued: issued }),
      number_taken: taken,
      course_ticket: course,
      group_ticket: group,
      ...(group ? { group_min, group_max } : {}),
      available,
      ...(available_from ? { available_from } : {}),
      ...(available_to ? { available_to } : {}),
      cost: { currency_code: "GBP", net, tax, face_value_net: face },
      built_basket_iframe_url: `/pagecode/iframe/basket_items/apply?${enc}=1`,
      built_basket_url: `/pagecode/basket_items/apply?${enc}=1`,
    },
    relationships: {
      events: relMany("event", eventIds, self),
      class_passes: relMany("class_pass", class_passes, self, "class_passes"),
    },
    links: { self },
  };
};

export const YOGA = "ev-sboe-20261005100000";
export const YOGA_SINGLE = "ti-sboe-20261005100000-tk1m";
export const YOGA_GROUP = "ti-sboe-20261005100000-tk2g";
export const COURSE = ["ev-cour-20261012180000", "ev-cour-20261019180000", "ev-cour-20261026180000"];
export const COURSE_TICKET = "ti-cour-20261012180000-tkc1";
export const MANY = "ev-many-20261101090000";
export const RETREAT = "ev-sboe-20261115000000";

const named = [
  mkEvent(YOGA, {
    title: "Beginners Yoga",
    details: "Bring a mat. Questions to jane@example.com or 07700 900123.",
    start: "2026-10-05T10:00:00Z",
    end: "2026-10-05T11:00:00Z",
    limit: 12,
    count: 9,
    waiting_list: true,
    tags: ["yoga", "beginners"],
    location: STUDIO,
    tickets: [YOGA_SINGLE, YOGA_GROUP],
    attachments: [WAIVER],
    leaders: [JANE],
  }),
  ...COURSE.map((id, i) =>
    mkEvent(id, {
      title: `Pottery Course (week ${i + 1} of 3)`,
      details: "Three Monday evenings. Clay and firing included.",
      start: `2026-10-${12 + 7 * i}T18:00:00Z`,
      end: `2026-10-${12 + 7 * i}T20:00:00Z`,
      limit: 8,
      count: 8,
      tags: ["pottery", "course"],
      location: HALL,
      tickets: [COURSE_TICKET],
      leaders: [TOM],
    }),
  ),
  mkEvent(MANY, {
    title: "Open Day",
    details: "Taster sessions all day; one ticket per taster.",
    start: "2026-11-01T09:00:00Z",
    end: "2026-11-01T17:00:00Z",
    limit: 200,
    count: 41,
    max_per_booking: 10,
    tags: ["open-day"],
    location: STUDIO,
    tickets: Array.from({ length: 23 }, (_, i) => `ti-many-20261101090000-t${String(i + 1).padStart(2, "0")}`),
    attachments: [PHOTO],
    leaders: [JANE, TOM],
  }),
  mkEvent(RETREAT, {
    title: "Retreat weekend",
    details: "Two days in the hills.",
    start: "2026-11-15T00:00:00Z",
    end: "2026-11-16T23:59:59Z",
    all_day: true,
    limit: 20,
    count: 3,
    // A phone number typed into a tag, to prove tags are redacted like the other free text.
    tags: ["yoga", "retreat", "book by phone 07700 900123"],
    location: HALL,
    tickets: ["ti-sboe-20261115000000-tk1r"],
    leaders: [JANE],
  }),
];

// 44 drop-in classes so /events spans three pages of 20 (50 events in total).
const bulk = Array.from({ length: 44 }, (_, i) => {
  const day = 2 + (i % 28);
  const d = String(day).padStart(2, "0");
  const id = `ev-bulk-202611${d}${String(9 + (i % 9)).padStart(2, "0")}0000`;
  return mkEvent(id, {
    title: `Drop-in class ${i + 1}`,
    details: "Turn up and flow.",
    start: `2026-11-${d}T${String(9 + (i % 9)).padStart(2, "0")}:00:00Z`,
    end: `2026-11-${d}T${String(10 + (i % 9)).padStart(2, "0")}:00:00Z`,
    limit: 15,
    count: i % 16,
    tags: ["drop-in", i % 2 ? "yoga" : "pilates"],
    location: i % 2 ? STUDIO : HALL,
    tickets: [`ti-bulk-202611${d}-tk${i + 1}`],
    leaders: [JANE],
  });
});
export const events = [...named, ...bulk];

// Mock-side data the schema does not carry: the calendar (schedule page) each event is on, for
// filter[calendar], and which events form a course, for filter[compact].
export const eventCalendars = Object.fromEntries(events.map((e) => [e.id, e.attributes.tags.includes("yoga") || e.attributes.tags.includes("pilates") ? "studio-timetable" : "workshops"]));
export const courseOf = Object.fromEntries(COURSE.map((id) => [id, COURSE[0]]));

export const tickets = [
  mkTicket(YOGA_SINGLE, [YOGA], { title: "Single ticket", details: "One person, one class. Refunds via refunds@example.com", issued: 10, taken: 7, net: 1200, face: 1200 }),
  mkTicket(YOGA_GROUP, [YOGA], { title: "Group ticket", details: "Bring friends.", issued: null, taken: 2, group: true, group_min: 2, group_max: 5, available: false, available_from: "2026-10-01T00:00:00Z", available_to: "2026-10-05T09:00:00Z", net: 4000, tax: 800, face: 4000, class_passes: ["cp-family8"] }),
  mkTicket(COURSE_TICKET, COURSE, { title: "Full course", details: "All three sessions.", issued: 8, taken: 8, course: true, net: 9000, face: 6000 }),
  mkTicket("ti-sboe-20261115000000-tk1r", [RETREAT], { title: "Retreat place", details: "Includes meals.", issued: 20, taken: 3, net: 25000, tax: 5000 }),
  ...Array.from({ length: 23 }, (_, i) => mkTicket(`ti-many-20261101090000-t${String(i + 1).padStart(2, "0")}`, [MANY], { title: `Taster ${i + 1}`, details: "30 minutes.", issued: 6, taken: i % 7, net: 500, class_passes: ["cp-gold10", "cp-silver5", "cp-trial1"] })),
  ...bulk.map((e, i) => mkTicket(e.relationships.tickets.data[0].id, [e.id], { title: "Drop-in", details: "Pay as you go.", issued: 15, taken: i % 16, net: 900, class_passes: ["cp-gold10", "cp-silver5"] })),
];
