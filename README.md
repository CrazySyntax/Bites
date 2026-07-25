# Webhook Delivery Service

A small service that delivers webhook events to customer endpoints with ordered,
retried, signed delivery. Built with Node.js + TypeScript (ESM) and Express 5.

## Requirements

- Node.js **18+** (uses global `fetch`, `AbortController`, and `node:crypto`).
  Developed on Node 22.

## Run

```bash
npm install
npm run dev      # start with hot reload (tsx) on http://localhost:3000
```

Other scripts:

```bash
npm test         # run the test suite (Jest + ts-jest, ESM)
npm run build    # type-check + emit to dist/
npm start        # run the compiled build
```

Override the port with `PORT=4000 npm run dev`.

### Configuration

`src/config.ts` reads its values from the environment (see `.env.example` for
every supported key). The env file is resolved in this order:

1. An explicit `--env-path <path>` (or `--env-path=<path>`) command-line
   argument, if given. A path passed here that does not exist is a hard error.
2. Otherwise, a `.env` file in the working directory, if one exists.
3. Otherwise, the defaults baked into `config.ts`.

Real environment variables take precedence over the env file, so
`PORT=4000 npm start` still wins. The loader is hand-rolled (`src/env.ts`),
keeping the project free of runtime dependencies beyond Express.

```bash
cp .env.example .env                       # then edit to taste
npm start                                  # loads ./.env if present
npm start -- --env-path ./config/prod.env  # or point at a specific file
```

> The flag is `--env-path`, not `--env-file`: Node consumes `--env-file` itself
> (its built-in `.env` support) before the app can see it.

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/endpoints` | Register an endpoint. Body `{ "url": string }`. Returns `{ endpointId, secret, ... }`. |
| `PATCH` | `/endpoints/:id` | Update `url` and/or `status` (`"active"` \| `"paused"`). |
| `POST` | `/events` | Accept an event. Body `{ "endpointId": string, "payload": object }`. Returns **202** immediately. Optional `Idempotency-Key` header. |
| `GET` | `/events/:id` | Event delivery status + full attempt history. |
| `GET` | `/endpoints/:id/events?status=&limit=&offset=` | List an endpoint's events, newest first. |
| `POST` | `/events/:id/redeliver` | Re-queue a `dead` event (attempt counter resets, history preserved). |
| `POST` | `/database/dump` | Snapshot the whole database to a file. Returns `{ dumped, endpoints, events }`. |
| `POST` | `/database/load` | Restore the database from the snapshot file and rehydrate the services (restored `pending` events resume delivery). Returns `{ loaded, endpoints, events }`. |

### Quick example

```bash
# 1. Register an endpoint — capture the id + secret from the response.
curl -sX POST localhost:3000/endpoints \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/hook"}'

# 2. Send an event (delivered asynchronously).
curl -sX POST localhost:3000/events \
  -H 'content-type: application/json' \
  -H 'idempotency-key: order-123' \
  -d '{"endpointId":"<id>","payload":{"order":42}}'

# 3. Inspect delivery status + attempt history.
curl -s localhost:3000/events/<eventId>
```

Each delivery is an HTTP `POST` to the endpoint's `url` with these headers:

- `X-Signature: sha256=<hex>` — HMAC-SHA256 of the **exact request body** keyed by
  the endpoint's secret. Customers verify with:
  `HMAC_SHA256(rawBody, secret) === hex(X-Signature)`.
- `X-Event-Id`, `X-Event-Timestamp`, `X-Attempt` — delivery metadata.
- `Content-Type: application/json`.

The request body is `JSON.stringify(payload)` captured once at creation, so the
bytes signed always equal the bytes sent.

## Approach & design

**Layered, dependency-injected.** `routes → services → repositories`, with the
delivery engine (`services → deliveryManager → { repositories, transport, signer,
backoff }`) wired together in `src/composition.ts`. No global singletons: every
dependency is passed in, which is what makes the engine testable with a fake HTTP
transport and a shrunk backoff config (see `tests/harness.ts`).

**Per-endpoint FIFO queues — the core of the service** (`src/delivery/`):

- `DeliveryManager` owns a `Map<endpointId, EndpointQueue>`, created lazily.
- Each `EndpointQueue` is an ordered list of event ids drained by **one** worker
  loop (a `running` flag makes `wake()` idempotent, so it's never double-drained).
- **Ordering** — the head event is *peeked*, not removed, and retried in place
  until it reaches a terminal state (`delivered` or `dead`); only then is it
  shifted off and the next event begins. This is deliberate head-of-line blocking:
  a later event can never overtake an earlier one that is still retrying. This is
  the intended reading of "events for the same endpoint are delivered in order."
- **Concurrency & isolation** — because each endpoint has its own queue and loop,
  different endpoints deliver concurrently, and a slow/down endpoint parks inside
  its own `await` (the fetch timeout or the backoff sleep) without touching any
  other endpoint's queue.

**Retry / backoff / timeout** (`backoff.ts`, `sleep.ts`, `config.ts`):

- Any `2xx` = delivered. Everything else (non-2xx, network error, or a request
  exceeding the 5s per-attempt timeout via `AbortController`) is a failed attempt.
- Failures retry with exponential backoff + full jitter
  (`base·factor^(n-1)`, capped, plus `[0, base)` jitter). Give up after **5**
  attempts and mark the event `dead`. All knobs live in `DeliveryConfig`.
- Backoff waits use a cancellable `setTimeout` so pause/shutdown can interrupt
  them and tests don't leak timers.

**Idempotency** — `POST /events` with an `Idempotency-Key` is deduped per
endpoint (`endpointId:key`). A repeat returns the original `eventId` with
**200** + `{ deduplicated: true }` (versus **202** for a fresh accept) and does
**not** enqueue a second delivery. The existence-check + create is kept free of an
intervening `await`, so two concurrent same-key requests can't both create an event.

**Pause / resume** — pausing sets the endpoint status and stops its worker (and
cancels an in-flight backoff wait); events keep enqueuing while paused. Resuming
restarts the loop and delivers the backlog in order.

**Two-level, pluggable storage** — the services (`EndpointService` /
`EventService`) own an in-memory working set and write every change through to
the `repositories/` layer, which represents the database: `EndpointRepository` /
`EventRepository` interfaces with in-memory implementations. The methods are
async, so a real database is a drop-in replacement without changing any caller.
The delivery engine reads/persists through the services via the narrow
`EndpointReader` / `EventStore` seams (`src/delivery/stores.ts`), so the services
stay the single write-through point. See the two-level-storage assumption for the
terminal-event (`delivered`/`dead`) eviction rule. 

The database layer is the source of truth.
Every change to events or endpoints is persisted to the database. We do so in order to 
avoid losing data on process crash. In a real production high-throughput system, the app may not write
directly to the database, but instead use a message queue to decouple the delivery from the persistence.
Every change to events or endpoints will be produced to the queue, and a separate consumer will consume
a bulk of messages and write the entire bulk to the database.
This approach may cause some delay in persisting the data, but we can definitely live with that.
The data that we need immediately, we will keep in EventService and EndpointService classes.

The in-memory data in EventService and EndpointService 
is a subset of the data in the database. We keep there only data that we need immediately
and we cannot tolerate availability or consistency. These are:
- all endpoints entities (id, url, secret, status). Once a user calls POST /event, we need to perfectly 
know the data of the endpoint to the exact time of the call.
- For each endpoint, 10 most recent events in "pending" status. "Devlivered" and "dead" events
are not needed immediately, and we can fetch them from the database when needed.

**Snapshot persistence** (`src/services/databaseService.ts`, `routes/database.ts`)
— because the store is in-memory, a crash loses state. `POST /database/dump`
serializes the whole database (both repositories) to a JSON file, and
`POST /database/load` reads that file back: it repopulates the repositories, then
rehydrates the services' working sets (`EndpointService.reload()` /
`EventService.reload()`) and **re-queues every restored `pending` event** so
delivery resumes where the crashed process left off. The endpoint service reloads
first, so a `paused` endpoint has its queue paused before its backlog is
re-enqueued. The file path is fixed in code (`DATABASE_FILE` in `config.ts`), not
client-supplied. Each process start writes a fresh, empty snapshot file
(`index.ts`), so a stale file never loads implicitly — a restore is always an
explicit `POST /database/load`.

**Graceful shutdown** — on `SIGINT`/`SIGTERM` the server stops accepting
connections, pauses every queue, clears backoff timers, and aborts in-flight
requests.

### Status filter mapping

`GET /endpoints/:id/events?status=` accepts `pending | delivered | dead` — the
same three values an event's `status` can take (see the assumption below). The
filter is a direct match; an unknown value returns **400**.

## Assumptions

Interpretations made where the specification left room; each is enforced in code
and covered by a test.

- **An event has exactly three statuses: `pending`, `delivered`, `dead`.** There
  is no separate "in flight" / "delivering" state. An event is `pending` from the
  moment it is accepted and stays `pending` throughout its whole non-terminal
  life — while it sits in the queue, while a request is on the wire, and while it
  waits out the backoff after a failed attempt that still has retries left. It
  leaves `pending` only on a terminal outcome: `delivered` on a 2xx, or `dead`
  once all attempts are exhausted (or per the paused-endpoint rule below). The
  reasoning: from a client's point of view "pending" already means "not yet
  delivered, still trying", so exposing a transient delivering state adds
  churn without adding information — the live attempt count and attempt history
  in `GET /events/:id` already convey progress. `GET /events/:id/…?status=`
  therefore filters over the same three values.

- **A delivery that fails while its endpoint is paused kills that event
  immediately.** If an attempt fails and the endpoint is currently `paused`, the
  event is marked `dead` right away rather than scheduled for another retry —
  even if it still has attempts remaining before the 5-attempt limit. The
  reasoning: a paused endpoint is a deliberate "stop sending here" signal and is
  not expected to recover on its own, so continuing to retry against it is wasted
  work; failing fast surfaces the problem instead of hiding it behind backoff.
  Only the in-flight event is affected — other events for that endpoint remain
  `pending` and resume delivery normally once the endpoint is reactivated, and a
  `dead` event can still be re-queued with `POST /events/:id/redeliver`.
  (Note: this is a deliberate deviation from the plain "retry up to 5 times"
  rule, applied narrowly to the paused case; active endpoints retry as normal.)

- **Same-endpoint events are delivered strictly one at a time, and a failing
  event blocks the ones behind it.** When two (or more) events are queued for the
  same endpoint and the first fails, the queue keeps retrying that first event
  and does **not** start the second until the first reaches a terminal state —
  either it succeeds, or it fails all 5 attempts and is marked `dead`. This is
  the intended reading of "events for the same endpoint are delivered in order":
  head-of-line blocking, so a later event can never overtake an earlier one that
  is still being retried. It is implemented by peeking the head of the per-endpoint
  queue and only removing it once terminal (`src/delivery/endpointQueue.ts`).
  Different endpoints are unaffected — they each have their own queue and are
  delivered concurrently, so one endpoint's stuck event never delays another's.

- **The in-memory store is capacity-bounded to avoid unbounded memory growth.**
  At most **100** endpoints may exist, and each endpoint may hold at most **50**
  events. A `POST /endpoints` that would exceed the endpoint limit, or a
  `POST /events` that would exceed an endpoint's event limit, is rejected with
  **HTTP 500** (`{ "error": "endpoint limit reached (max 100)" }` /
  `"event limit reached for endpoint (max 50)"`). The reasoning: with only
  in-memory storage there is no eviction or archival, so unbounded creation is a
  memory leak; a hard cap surfaces the ceiling loudly rather than letting the
  process grow until it is killed. **500** (rather than 429/507) is used because
  the spec asked for it, and it correctly signals a server-side capacity
  condition the client cannot resolve by changing its request. The limit on
  events is checked *after* the idempotency lookup, so a deduplicated retry of an
  already-accepted event never trips the cap. Limits live in `src/config.ts`
  (`MAX_ENDPOINTS`, `MAX_EVENTS_PER_ENDPOINT`); a real datastore would raise or
  remove them.

- **Storage has two levels, and terminal (`delivered`/`dead`) events are archived,
  not memory-resident.**
  `EndpointService` / `EventService` each own an in-memory working set (a `Map`)
  and write every change *through* to the `repositories/` layer, which stands in
  for the database (swappable for real DB queries without touching callers). The
  delivery engine reads and persists through the services (`EndpointReader` /
  `EventStore` in `src/delivery/stores.ts`), so the services are the single
  write-through point — a change is always reflected to the database. When an
  event reaches a terminal state — `delivered` (2xx) or `dead` (all attempts
  exhausted, or failed while paused) — it is still written to the database with
  that status but is **evicted from `EventService`'s in-memory map**: a terminal
  event should not occupy the process working set, yet must remain fetchable
  (`GET /events/:id`) and, for a `dead` event, redeliverable
  (`POST /events/:id/redeliver`). Both operations fall back to the database when
  memory misses, and `redeliver` re-admits the event to memory. Listing,
  capacity, and idempotency checks run against the database, so they stay correct
  across eviction (a terminal event still counts toward the cap and still dedupes
  by key). Only `pending` events stay memory-resident. (`inMemoryCount()` on
  `EventService` exposes the working-set size as an operational metric.)

- **`EventService`'s in-memory working set is bounded to the 10 most recent
  `pending` events per endpoint.** The database holds every event, but to
  avoid heap collapse under many endpoints the service caps its resident copy at
  `MAX_IN_MEMORY_EVENTS_PER_ENDPOINT` (10) events *per endpoint*. Consequences:
  once an endpoint already has 10 resident events, a newly accepted event is
  written to the database **only** and not cached; and when an endpoint's
  resident count falls to 0 (its cached events all became `delivered`/`dead` and
  were evicted), the service reloads up to 10 of that endpoint's most recent
  `pending` events from the database on the next `save`. Reads for a
  database-only event fall back to the database transparently, so correctness is
  unaffected — the bound only limits how much lives in process memory.
  (`inMemoryCountForEndpoint(endpointId)` exposes the per-endpoint resident count
  as an operational metric.)

## Manual testing
We can use the following public API in order to test the webhook delivery service manually:
curl -X POST "https://httpbin.dev/delay/{n}" \
     -H "Content-Type: application/json" \
     -d '{"test": "data"}'
It can simulate a webhook that returns within n seconds delay 