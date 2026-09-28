# Bookwhen MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients read a Bookwhen account's public booking data: events (classes, courses, workshops), their tickets and availability, locations, class passes, leaders and attachments. It is built from Bookwhen's public API documentation and its published OpenAPI spec (`https://api.bookwhen.com/v2/openapi.yaml`).

Bookwhen's public API is read-only and exposes public data only. It has no write endpoints, so this server has no write tools and no "allow writes" setting, and it returns no attendee or booking records: `attendee_count` on an event and `number_taken` on a ticket are counts, and nothing here can say who booked.

Once it's connected, someone on the account can ask things like:

- "What's on next week, and where?"
- "Is there space on Tuesday's beginners class, and what does a ticket cost?"
- "Which tickets does the pottery course sell, and how many are left?"
- "Which class passes cover ten or more classes?"
- "Who leads the retreat weekend, and what does their profile say?"

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `list_events` | Events with date, attendee limit and count, spaces left, tags and location ID, from today onwards unless `from` is given (the API's default). Filters: `from`/`to` (`YYYYMMDD` or `YYYYMMDDHHMMSS`), `tags`, `title`, `detail`, `location`, `calendar`, `compact`; multiple values within one filter are sent comma-separated, and filters combine with AND. `include_location` side-loads each event's location. Pages are followed via the API's `links.next` until it reports no next page or `max_results` is reached. | `GET /events` |
| `get_event` | One event with its location, every ticket type with availability (number issued, taken, spaces left, cost, availability window, group and course flags), its leaders and its attachments, side-loaded in one call. | `GET /events/{event_id}?include=location,tickets,attachments,leaders` |
| `list_event_tickets` | Every ticket type for one event with availability and cost, following pages. | `GET /tickets?event={event_id}` |
| `get_ticket` | One ticket type with its availability and cost, and the event(s) it books onto (all events in the course for a course ticket). | `GET /tickets/{ticket_id}?include=events` |
| `list_locations` | Venues with address, additional info, coordinates and static map image URL. Filters: `address_text`, `additional_info`. | `GET /locations` |
| `get_location` | One venue. | `GET /locations/{location_id}` |
| `list_class_passes` | Class passes with usage allowance, type (`personal` or `any`), number available and day restriction. Filters: `title`, `detail`, `usage_type`, and `cost`, `usage_allowance` and `use_restricted_for_days` as an exact value or with `gt`/`gte`/`lt`/`lte`/`eq` (an empty operator object or an unknown operator name is refused rather than sent as no filter). | `GET /class_passes` |
| `list_leaders` | Leaders (published admin profiles) with name, job title, location, bio, website and social links. Contact email and phone only with `include_contact_details`. | `GET /leaders` |
| `get_attachment` | One file attached to an event: title, file name, type, size and download URL. | `GET /attachments/{attachment_id}` |

Not covered on purpose: `GET /attachments` (list), `GET /leaders/{leader_id}`, `GET /class_passes/{class_pass_id}`, the `entry` filter on events, and the `tickets.events`, `tickets.class_passes`, `events.location`, `events.tickets` and `events.attachments` include paths. Ticket costs are passed through as the API states them, in the currency's smallest unit (the spec's example: 1000 is $10); the server does not convert them.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need an API key for your Bookwhen account, generated in Bookwhen under API tokens setup (`admin.bookwhen.com/settings/api_access_permission_sets`). The API authenticates with HTTP Basic: the key is the username and the password is blank, which is what this server sends.

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bookwhen": {
      "command": "node",
      "args": ["/absolute/path/to/bookwhen-mcp/dist/index.js"],
      "env": { "BOOKWHEN_API_KEY": "your-key" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add bookwhen -e BOOKWHEN_API_KEY=your-key -- node /absolute/path/to/bookwhen-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `BOOKWHEN_API_KEY` | yes | Your API key, sent as the HTTP Basic username with a blank password. |
| `BOOKWHEN_BASE_URL` | no | Defaults to `https://api.bookwhen.com/v2`. Used by the tests. |

There is no `BOOKWHEN_ALLOW_WRITES`: the API documents no write endpoint, so there is nothing to enable. Setting it has no effect (the tests check this).

## Safety defaults

- Every tool is read-only and carries the MCP `readOnlyHint` annotation; the server only ever sends `GET`.
- Leaders' `contact_email` and `contact_phone` are only returned when the assistant explicitly asks (`include_contact_details`), even though the spec labels them public. In free text (event titles, details and tags, ticket titles and details, location address and additional info, leader names, job titles, locations, bios, websites and social feed types, attachment titles and file names, class pass titles and details) email addresses are replaced with `[email redacted]` and phone-number-like sequences with `[phone redacted]` by default. The phone match is a heuristic: it covers international numbers written with `+` or `00` (including the `+44 (0)7700 …` form), UK numbers written with a bracketed area code such as `(020) 7946 0958`, and UK-style `0…` numbers of 9 to 11 digits with spaces, dots or hyphens between groups. Other digit strings that happen to start with `0` (an order number, say) are redacted too, while Bookwhen IDs such as `ev-sboe-20200320100000`, ISO timestamps and hyphenated references are left alone; the raw text is available with `include_contact_details`. The same redaction is applied to any error text the API returns before it is passed on, including the quoted start of a non-JSON body; in that error text the API key and the `Authorization` header value are also replaced with `[key redacted]`, in case a live response or a proxy ever echoes them (the spec documents 401 and 404 bodies as empty). Redaction runs on the whole body before it is cut short for the message.
- Image, map, avatar, file and social feed URLs (`image_url`, `map_url`, `avatar_url`, `file_url`, `social_feeds[].url`) and the ticket's `basket_path` are returned as stored; the redaction is not applied to them.
- IDs are checked before any call is made: they must be short strings of letters, digits, `_` and `-` (up to 80 characters, no slashes, spaces or query characters), because the spec types every ID as a plain string and documents no format (its examples: `ev-sboe-20200320100000`, `ti-sboe-20200320100000-tk1m`, `sjm7pskr31t3`, `9v06h1cbv0en`, `g189gdkucw7r`, `cp-vk3x1brhpsbf`). `from`/`to` must be `YYYYMMDD` or `YYYYMMDDHHMMSS`; a tag, title, detail, location or calendar value may not contain a comma, because the API separates multiple values with commas. Filter values are sent as in the spec's example (`filter[tag]=tag%20one,tag%20two`): spaces as `%20`, the separating comma literal, everything else percent-encoded.
- Pagination follows the `links.next` URL the API returns (the spec's `IndexLinks`, e.g. `?page[offset]=20`) and stops when there is none. The spec documents no page-size parameter, so none is sent. A `next` link that is not under the configured API base URL (host and path, e.g. `/v2`) is never followed, so the API key cannot be sent anywhere else; the result then names the link's host and path and is marked incomplete. A repeated `next` link stops the loop.
- Bookwhen does not document a rate limit. Requests are spaced 250 ms apart (about four per second). A 429 is retried at most twice, waiting for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s then 4 s when the header is absent or unreadable). Each wait is capped at 10 seconds so a tool call stays under the MCP client's default 60-second request timeout: if Bookwhen asks for a longer wait the call gives up at once and the message says how long to wait.
- 502, 503 and 504 are retried the same way for `GET` (which is every request this server makes); when all three attempts fail the error says the service may be unavailable and to try again in a few minutes, without the gateway's HTML.
- A 200 whose body is not JSON (a proxy or a login page in the way) is reported as an error naming `BOOKWHEN_BASE_URL`, never as an empty list.
- A rejected API key produces a message that says which variable to fix and where keys come from. The spec documents 401 and 404 with empty bodies; a 404 is reported with the path and "Check the ID", and a 404 from `GET /tickets?event=…` names the event ID.

## Tests

```bash
npm test
```

The test suite:

1. Validates every fixture record against the component schemas in Bookwhen's published OpenAPI spec (`Event`, `Ticket`, `Location`, `Attachment`, `Leader`, `ClassPass`). The spec is downloaded from `api.bookwhen.com/v2/openapi.yaml` to `spec.yaml` on the first run.
2. Starts a local mock of the API under `/v2` that serves those fixtures as JSON:API documents with `IndexLinks` pagination (`self`, `first`, `prev`, `next` with `page[offset]`, 20 per page, links only when relevant), side-loads related resources for the documented `include` options, applies the documented event, location and class pass filters, answers an empty-bodied 401 with a `WWW-Authenticate` header for a wrong key and an empty-bodied 404 for unknown IDs, answers the first `GET /leaders` with a 429, and records each request line as sent so the wire encoding of filter values can be checked. Each of the mock's list and detail responses is validated against the operation's documented 200 response schema, and the documented `data`/`links` keys are asserted explicitly (see the note below).
3. Starts the built server and drives it over stdio with the official MCP client: 27 checks covering every tool and its annotations, following `links.next` across three pages to the documented end (no `next`) with the page requests about 250 ms apart, stopping at `max_results` with a note, every implemented `filter[...]` option on events (all documented ones except `entry`; including comma-joined multiple values sent as `open%20day,retreat` on the wire, `compact` true and false, and combined filters), `include=location`, the exact `include` sent by `get_event` and `get_ticket`, `included` read from both the top level (JSON:API) and inside the resource (the spec's schema), the `event` parameter and the next link that keeps it on `GET /tickets`, ticket availability arithmetic (`spaces_left`, `null` when no limit is set), the location, class pass (text, `usage_type`, exact and operator comparisons as in the spec's `filter[cost][gte]` example; `{}` and unknown operator names refused before any request; the cost note kept when the list is capped) and leader tools, redaction of emails and phone numbers by default in event details and tags, ticket details, location info, leader bios and attachment titles, leader contact fields withheld by default and all of these returned on request, the 429 retry waiting for `Retry-After` in the seconds, fractional-seconds and HTTP-date forms and falling back to 2 s when the header is absent, giving up after three attempts on a persistent 429 and at once on a `Retry-After` above the cap, a 502 and a 504 retried and a 503 failing three times reported with advice, a 200 with a non-JSON body reported as an error with the quoted start of the body redacted, the API key and Basic header value scrubbed from 401, 404, 503 and non-JSON error text that echoes them, a foreign-host `next` link not followed and a repeated `next` link stopping the loop, invalid IDs and filters refused before any request, the 401 and 404 messages (including a 404 whose JSON:API `errors` text is appended after redaction), that `BOOKWHEN_ALLOW_WRITES` has no effect, and that every request used `Basic base64(key:)`, a documented method and path, and only documented query parameters.

Note that the spec marks no field as required on any schema, so schema validation only proves the types of fields that are present. Step 2 therefore also asserts that the documented keys are present in the mock's responses; the fixture records themselves are only type-checked.

## Status

This is a working prototype. It has **not yet been run against the live API**, because it was built without a Bookwhen account. Everything below is taken from the published spec and should be confirmed on a real account:

- Where the API puts side-loaded resources. The spec's `Event` and `Ticket` schemas carry an `included` array inside each resource; JSON:API (which the spec says the API follows) puts `included` at the top level of the document. The server reads both and the tests exercise both; only one will be real.
- The page size and the exact form of `links.next`. The spec's examples step `page[offset]` by 20; the mock uses 20. The server sends no page-size parameter because none is documented.
- What `GET /tickets?event=…` returns for an unknown event. The spec lists only 200 and 401 for that operation; the server reads a 404 as "no such event" and would pass an empty list through as "no tickets".
- The wire encoding of filter values. The server sends them as the spec's example shows (`filter[tag]=tag%20one,tag%20two`: spaces as `%20`, the separating comma literal); the parameter names go out as `filter%5Btag%5D`, which decodes to the same thing. Neither form has been seen accepted by the live API.
- The values `filter[calendar]` and `filter[location]` expect. The spec says "calendars (schedule pages)" and "location slugs"; the server sends what it is given, and the mock treats a location slug as the location's ID.
- Whether multiple values in one filter (`filter[tag]=a,b`) match any or all of them. The mock matches any; the server just passes the comma-joined list through.
- The exact format of `filter[from]`/`filter[to]` with a time part. The spec writes `YYYYMMDDHHMISS`; the server accepts 8 or 14 digits.
- Null handling. The spec describes `number_issued`, `available_from`, `available_to`, `number_available` and `use_restricted_for_days` as null when unset but types them as non-nullable; the fixtures omit those fields in that case and the server treats missing and `null` alike (`number_issued: null` and `spaces_left: null` mean "no limit set").
- Whether `ClassPass` records carry a cost. The schema has no cost attribute although `GET /class_passes` is filterable by `cost`; the server applies the filter and says in its output that no cost is shown.
- The bodies of 401 and 404 responses. The spec documents them as empty; if the live API returns JSON:API `errors`, their `title`/`detail` are appended to the message (after contact-detail redaction).
- The `built_basket_url` value is a relative path in the spec's example (`/pagecode/basket_items/apply?…`); the server passes it through as `basket_path` without guessing the host.
- How many requests per second the API tolerates and whether it ever returns 429 or `Retry-After`; the spec says nothing, so the throttle here is a guess on the polite side.
- Whether an API key with a restricted permission set answers 401 or 403 for an endpoint it may not read; the server treats both as a key problem.

## Going to production

This version runs locally over stdio, with the account holder's own API key. For customers to connect from claude.ai or ChatGPT without handling keys, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by Bookwhen, and then a listing in the Claude and ChatGPT connector directories.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
