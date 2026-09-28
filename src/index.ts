#!/usr/bin/env node
// Bookwhen MCP server: lets Claude, ChatGPT and other MCP clients read a Bookwhen account's public
// events, tickets and availability, locations, class passes, leaders and attachments.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BookwhenClient, BookwhenError, type ListResult } from "./client.js";
import * as fmt from "./format.js";

const apiKey = process.env.BOOKWHEN_API_KEY?.trim();
if (!apiKey) {
  console.error("BOOKWHEN_API_KEY is not set. Create a key in Bookwhen's API tokens setup (admin.bookwhen.com/settings/api_access_permission_sets).");
  process.exit(1);
}
const api = new BookwhenClient(apiKey, process.env.BOOKWHEN_BASE_URL || undefined);

const server = new McpServer(
  { name: "bookwhen", version: "0.1.0" },
  {
    instructions: [
      "Read-only tools for a Bookwhen account's public booking data: events (classes, courses, workshops), their tickets and availability, locations, class passes, leaders and attachments.",
      "Bookwhen's public API exposes no attendee or booking records, so nothing here can list who booked; attendee_count and number_taken are counts only.",
      "IDs are strings: events look like ev-sboe-20200320100000, tickets like ti-sboe-20200320100000-tk1m, class passes like cp-vk3x1brhpsbf; locations, leaders and attachments are short slugs.",
      "list_events returns events from today onwards unless `from` is given (API default). Dates are YYYYMMDD or YYYYMMDDHHMMSS.",
      "Typical flow for 'is there space on Tuesday's class?': list_events with from/to, then get_event or list_event_tickets for spaces_left per ticket.",
      "Ticket costs are in the currency's smallest unit (1000 = 10.00 in a two-decimal currency).",
      "Email addresses and phone numbers typed into free text, and leaders' contact details, are only returned when explicitly requested with include_contact_details.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

// The spec types every ID as a plain string and documents no format. Its examples are
// ev-sboe-20200320100000 (event), ti-sboe-20200320100000-tk1m (ticket), sjm7pskr31t3 (location),
// 9v06h1cbv0en (attachment), g189gdkucw7r (leader), cp-vk3x1brhpsbf (class pass). Only reject values
// that could not be a path segment: letters, digits, "_" and "-", up to 80 characters.
const id = (what: string, example: string) => z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, `${what} IDs are short strings of letters, digits, _ and -, e.g. ${example}`);
// Spec, filter[from] / filter[to]: "format YYYYMMDD or YYYYMMDDHHMISS".
const stamp = z.string().regex(/^\d{8}(\d{6})?$/, "Dates are YYYYMMDD or YYYYMMDDHHMMSS, e.g. 20261001 or 20261001180000");
// Multiple values of one filter are sent comma-separated (spec example: filter[tag]=tag%20one,tag%20two),
// so a value containing a comma cannot be expressed.
const words = (what: string) =>
  z.array(z.string().min(1).max(200).refine((s) => !s.includes(","), `${what} values cannot contain commas: the API separates multiple values with commas`)).min(1).max(20);
// The operator object is strict and must name at least one operator: an empty or mistyped object
// ({} or { ge: 5 }) would otherwise be accepted and silently send no filter at all.
const comparison = z.union([
  z.number().int().min(0).describe("Exact value"),
  z
    .object({ eq: z.number().int().min(0).optional(), gt: z.number().int().min(0).optional(), gte: z.number().int().min(0).optional(), lt: z.number().int().min(0).optional(), lte: z.number().int().min(0).optional() })
    .strict()
    .refine((o) => Object.keys(o).length > 0, "give at least one of eq, gt, gte, lt, lte")
    .describe("Comparison operators, combined with AND"),
]);

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof BookwhenError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

const csv = (values: string[] | undefined) => (values && values.length ? values.join(",") : undefined);
const page = (r: ListResult) => ({ count: r.items.length, complete: r.complete, note: r.note });
/** filter[name]=v for an exact value, filter[name][op]=v for each operator. */
const comparisonQuery = (name: string, value: z.infer<typeof comparison> | undefined): Record<string, number | undefined> => {
  if (value === undefined) return {};
  if (typeof value === "number") return { [`filter[${name}]`]: value };
  return Object.fromEntries(Object.entries(value).map(([op, v]) => [`filter[${name}][${op}]`, v]));
};

server.registerTool(
  "list_events",
  {
    title: "List events",
    description:
      "List events (classes, courses, workshops) with date, attendee limit and count, tags and location ID. The API returns events from today onwards unless `from` is given; every filter is combined with AND, and multiple values within one filter are sent comma-separated. Pages are followed until the API reports no next page or max_results is reached.",
    inputSchema: {
      from: stamp.optional().describe("Inclusive start, YYYYMMDD or YYYYMMDDHHMMSS (filter[from]; the API defaults to today)"),
      to: stamp.optional().describe("Non-inclusive end, YYYYMMDD or YYYYMMDDHHMMSS (filter[to])"),
      tags: words("Tag").optional().describe("Tag words to include (filter[tag])"),
      title: words("Title").optional().describe("Entry titles to search for (filter[title])"),
      detail: words("Detail").optional().describe("Entry details text to search for (filter[detail])"),
      location: words("Location").optional().describe("Location slugs to include (filter[location])"),
      calendar: words("Calendar").optional().describe("Calendars (schedule pages) to restrict to (filter[calendar])"),
      compact: z.boolean().optional().describe("Combine the events of a course into a single virtual event (filter[compact])"),
      include_location: z.boolean().default(false).describe("Side-load each event's location (include=location). Slower; the API recommends includes for single-event requests"),
      max_results: z.number().int().min(1).max(500).default(50).describe("Maximum number of events to return"),
      include_contact_details: z.boolean().default(false).describe("Stop redacting email addresses and phone numbers from titles, details and location text"),
    },
    annotations: READ,
  },
  safe(async ({ from, to, tags, title, detail, location, calendar, compact, include_location, max_results, include_contact_details }) => {
    const r = await api.list(
      "/events",
      {
        "filter[from]": from,
        "filter[to]": to,
        "filter[tag]": csv(tags),
        "filter[title]": csv(title),
        "filter[detail]": csv(detail),
        "filter[location]": csv(location),
        "filter[calendar]": csv(calendar),
        "filter[compact]": compact === undefined ? undefined : String(compact),
        include: include_location ? "location" : undefined,
      },
      { maxItems: max_results, maxPages: 25 },
    );
    const inc = fmt.indexIncluded(r.included);
    return { window: { from: from ?? "today (API default)", to: to ?? "no end" }, ...page(r), events: r.items.map((e) => fmt.event(e, inc, include_contact_details)) };
  }),
);

server.registerTool(
  "get_event",
  {
    title: "Get event with tickets, location, leaders and attachments",
    description: "One event with its location, every ticket type with availability (number issued, taken, spaces left, cost), its leaders and its attachments, side-loaded in a single call.",
    inputSchema: {
      event_id: id("Event", "ev-sboe-20200320100000").describe("Event ID"),
      include_contact_details: z.boolean().default(false).describe("Include leaders' contact email and phone, and stop redacting email addresses and phone numbers from free text"),
    },
    annotations: READ,
  },
  safe(async ({ event_id, include_contact_details }) => {
    // include options documented for GET /events/{event_id}: location, attachments, tickets, tickets.events, tickets.class_passes, leaders.
    const { item, included } = await api.single(`/events/${event_id}`, { include: "location,tickets,attachments,leaders" });
    const inc = fmt.indexIncluded(included);
    const ev = fmt.eventDetail(item, inc, include_contact_details);
    const missing = [
      ev.location_id && !ev.location ? "location" : undefined,
      ev.ticket_ids.length > ev.tickets.length ? "tickets" : undefined,
      ev.attachment_ids.length > ev.attachments.length ? "attachments" : undefined,
      ev.leader_ids.length > ev.leaders.length ? "leaders" : undefined,
    ].filter(Boolean);
    return {
      event: ev,
      note: missing.length ? `The API did not side-load ${missing.join(", ")} for this event; use the IDs with the other tools.` : undefined,
      cost_note: ev.tickets.length ? "Ticket costs are in the currency's smallest unit (1000 = 10.00 in a two-decimal currency)." : undefined,
    };
  }),
);

server.registerTool(
  "list_event_tickets",
  {
    title: "List tickets for an event",
    description:
      "Every ticket type for one event with availability: number issued (null = no limit), number taken (booked or reserved in checkout), spaces left, availability window, cost, and whether it is a group ticket (min/max people) or a course ticket (books all events in the course).",
    inputSchema: {
      event_id: id("Event", "ev-sboe-20200320100000").describe("Event ID (required by GET /tickets)"),
      max_results: z.number().int().min(1).max(500).default(100),
      include_contact_details: z.boolean().default(false).describe("Stop redacting email addresses and phone numbers from ticket titles and details"),
    },
    annotations: READ,
  },
  safe(async ({ event_id, max_results, include_contact_details }) => {
    let r: ListResult;
    try {
      r = await api.list("/tickets", { event: event_id }, { maxItems: max_results, maxPages: 25 });
    } catch (err) {
      // The spec lists only 200 and 401 for GET /tickets, so what an unknown event returns is not
      // documented; a 404 is read as "no such event" and named as such.
      if (err instanceof BookwhenError && err.status === 404) throw new BookwhenError(`No event with ID ${event_id} was found (Bookwhen answered 404 for GET /tickets?event=${event_id}). Check the event ID with list_events.`, 404);
      throw err;
    }
    const inc = fmt.indexIncluded(r.included);
    return {
      event_id,
      ...page(r),
      cost_note: "Ticket costs are in the currency's smallest unit (1000 = 10.00 in a two-decimal currency).",
      tickets: r.items.map((t) => fmt.ticket(t, inc, include_contact_details)),
    };
  }),
);

server.registerTool(
  "get_ticket",
  {
    title: "Get a ticket",
    description: "One ticket type with its availability and cost, and the event(s) it books onto (all events in the course for a course ticket).",
    inputSchema: {
      ticket_id: id("Ticket", "ti-sboe-20200320100000-tk1m").describe("Ticket ID"),
      include_contact_details: z.boolean().default(false).describe("Stop redacting email addresses and phone numbers from free text"),
    },
    annotations: READ,
  },
  safe(async ({ ticket_id, include_contact_details }) => {
    // include options documented for GET /tickets/{ticket_id}: class_passes, events, events.location, events.tickets, events.attachments.
    const { item, included } = await api.single(`/tickets/${ticket_id}`, { include: "events" });
    return { ticket: fmt.ticket(item, fmt.indexIncluded(included), include_contact_details), cost_note: "Costs are in the currency's smallest unit (1000 = 10.00 in a two-decimal currency)." };
  }),
);

server.registerTool(
  "list_locations",
  {
    title: "List locations",
    description: "Venues with address, extra directions, coordinates and a static map image URL. Optionally filter by text in the address or in the additional info.",
    inputSchema: {
      address_text: z.string().min(1).max(200).optional().describe("Only locations whose address contains this text (filter[address_text])"),
      additional_info: z.string().min(1).max(200).optional().describe("Only locations whose additional info contains this text (filter[additional_info])"),
      max_results: z.number().int().min(1).max(500).default(100),
      include_contact_details: z.boolean().default(false).describe("Stop redacting email addresses and phone numbers from address and additional info text"),
    },
    annotations: READ,
  },
  safe(async ({ address_text, additional_info, max_results, include_contact_details }) => {
    const r = await api.list("/locations", { "filter[address_text]": address_text, "filter[additional_info]": additional_info }, { maxItems: max_results, maxPages: 25 });
    return { ...page(r), locations: r.items.map((l) => fmt.location(l, include_contact_details)) };
  }),
);

server.registerTool(
  "get_location",
  {
    title: "Get a location",
    description: "One venue: address, additional info, coordinates and map image URL.",
    inputSchema: {
      location_id: id("Location", "sjm7pskr31t3").describe("Location ID (slug)"),
      include_contact_details: z.boolean().default(false).describe("Stop redacting email addresses and phone numbers from address and additional info text"),
    },
    annotations: READ,
  },
  safe(async ({ location_id, include_contact_details }) => ({ location: fmt.location((await api.single(`/locations/${location_id}`)).item, include_contact_details) })),
);

server.registerTool(
  "list_class_passes",
  {
    title: "List class passes",
    description:
      "Class passes (pre-purchased bundles of bookings) with usage allowance, type (personal or any attendee), number available and day restriction. Filters: title or details text, usage type, and cost, usage_allowance or use_restricted_for_days as an exact value or comparison (gt, gte, lt, lte, eq). Cost values are in the currency's smallest unit, as in the spec's example filter[cost][gte]=2000.",
    inputSchema: {
      title: z.string().min(1).max(200).optional().describe("Text in the pass title (filter[title])"),
      detail: z.string().min(1).max(200).optional().describe("Text in the pass details (filter[detail])"),
      usage_type: z.enum(["personal", "any"]).optional().describe("personal: booker only; any: additional attendees too (filter[usage_type])"),
      cost: comparison.optional().describe("Cost in the currency's smallest unit, exact or with operators (filter[cost], filter[cost][gte] ...)"),
      usage_allowance: comparison.optional().describe("Number of classes the pass covers, exact or with operators (filter[usage_allowance])"),
      use_restricted_for_days: comparison.optional().describe("Days the pass stays valid from first use, exact or with operators (filter[use_restricted_for_days])"),
      max_results: z.number().int().min(1).max(500).default(100),
      include_contact_details: z.boolean().default(false).describe("Stop redacting email addresses and phone numbers from titles and details"),
    },
    annotations: READ,
  },
  safe(async ({ title, detail, usage_type, cost, usage_allowance, use_restricted_for_days, max_results, include_contact_details }) => {
    const r = await api.list(
      "/class_passes",
      {
        "filter[title]": title,
        "filter[detail]": detail,
        "filter[usage_type]": usage_type,
        ...comparisonQuery("cost", cost),
        ...comparisonQuery("usage_allowance", usage_allowance),
        ...comparisonQuery("use_restricted_for_days", use_restricted_for_days),
      },
      { maxItems: max_results, maxPages: 25 },
    );
    return {
      ...page(r),
      cost_note: "The ClassPass record documented by Bookwhen carries no cost field, so the cost of each pass is not shown; the cost filter is applied by the API.",
      class_passes: r.items.map((c) => fmt.classPass(c, include_contact_details)),
    };
  }),
);

server.registerTool(
  "list_leaders",
  {
    title: "List leaders",
    description: "Leaders (published admin profiles: the people running or teaching sessions) with name, job title, location, bio, website and social links. Their contact email and phone are only returned with include_contact_details.",
    inputSchema: {
      max_results: z.number().int().min(1).max(500).default(100),
      include_contact_details: z.boolean().default(false).describe("Include each leader's contact email and phone, and stop redacting email addresses and phone numbers from bios"),
    },
    annotations: READ,
  },
  safe(async ({ max_results, include_contact_details }) => {
    const r = await api.list("/leaders", {}, { maxItems: max_results, maxPages: 25 });
    return { ...page(r), leaders: r.items.map((l) => fmt.leader(l, include_contact_details)) };
  }),
);

server.registerTool(
  "get_attachment",
  {
    title: "Get an attachment",
    description: "One file attached to an event: title, file name, type, size and the download URL (the spec says to use this URL rather than the one it forwards to).",
    inputSchema: {
      attachment_id: id("Attachment", "9v06h1cbv0en").describe("Attachment ID"),
      include_contact_details: z.boolean().default(false).describe("Stop redacting email addresses and phone numbers from the title and file name"),
    },
    annotations: READ,
  },
  safe(async ({ attachment_id, include_contact_details }) => ({ attachment: fmt.attachment((await api.single(`/attachments/${attachment_id}`)).item, include_contact_details) })),
);

await server.connect(new StdioServerTransport());
console.error("Bookwhen MCP server running (read-only: Bookwhen's public API has no write endpoints).");
