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

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/endpoints` | Register an endpoint. Body `{ "url": string }`. Returns `{ endpointId, secret, ... }`. |
| `PATCH` | `/endpoints/:id` | Update `url` and/or `status` (`"active"` \| `"paused"`). |
| `POST` | `/events` | Accept an event. Body `{ "endpointId": string, "payload": object }`. Returns **202** immediately. Optional `Idempotency-Key` header. |
| `GET` | `/events/:id` | Event delivery status + full attempt history. |
| `GET` | `/endpoints/:id/events?status=&limit=&offset=` | List an endpoint's events, newest first. |
| `POST` | `/events/:id/redeliver` | Re-queue a `dead` event (attempt counter resets, history preserved). |
| `GET` | `/health` | Liveness check. |

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

**Pluggable storage** — `EndpointRepository` / `EventRepository` are interfaces
(`src/repositories/`) with in-memory implementations. The methods are async, so a
real database is a drop-in replacement without changing any caller.

**Graceful shutdown** — on `SIGINT`/`SIGTERM` the server stops accepting
connections, pauses every queue, clears backoff timers, and aborts in-flight
requests.

### Status filter mapping

`GET /endpoints/:id/events?status=` accepts `pending | delivered | dead`. The
`pending` filter also matches the transient internal `delivering` state (i.e. it
means "not yet in a terminal state"). An unknown value returns **400**.

## Assumptions

Interpretations made where the specification left room; each is enforced in code
and covered by a test.

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

## Tests

`npm test`. The suite (`*.test.ts`) prioritizes the parts most worth trusting:

- **Ordering** — a head event that fails twice then succeeds is not overtaken.
- **Head-of-line blocking** — a first event that fails all 5 attempts holds the
  second until it is `dead` (see [Assumptions](#assumptions)).
- **Concurrency isolation** — a hung endpoint doesn't delay a healthy one.
- **Retry → dead** — 5 attempts recorded, then `dead`.
- **Timeout as failure** — an aborted request counts toward the limit.
- **Idempotency** — same key ⇒ same event id, delivered once.
- **Signature** — `X-Signature` equals the HMAC of the exact bytes sent.
- **Pause/resume** and **redeliver** (history preserved, counter reset).
- **Fail-while-paused** — an attempt failing on a paused endpoint goes straight to
  `dead` (see [Assumptions](#assumptions)).
- **HTTP integration** (supertest): the 202/200 contract, validation, listing,
  pagination.

Tests inject a fake HTTP transport and a tiny backoff config, so they're fast and
never hit the network.

## Project layout

```
src/
  index.ts             entrypoint: compose deps, listen, graceful shutdown
  app.ts               buildApp(services) -> Express app (no listen; used by tests)
  composition.ts       wires the object graph (repos + engine + services)
  config.ts            port + delivery tuning (attempts, timeout, backoff)
  types.ts             Endpoint / WebhookEvent / Attempt domain types
  errors.ts            AppError + status helpers
  delivery/            the core engine
    deliveryManager.ts   Map<endpointId, EndpointQueue>
    endpointQueue.ts     per-endpoint FIFO worker loop (ordering, retry, backoff)
    httpTransport.ts     HttpTransport interface + FetchTransport
    signer.ts            HMAC-SHA256 signing
    backoff.ts           exponential backoff + jitter (pure)
    sleep.ts             cancellable delay
  repositories/        storage interfaces + inMemory/ implementations
  services/            endpointService, eventService
  routes/              endpoints, events, health, serialize
  middleware/          errorHandler
tests/                 all tests + the shared harness (fake transport)
  harness.ts           test-only object graph + fake HTTP transport
  *.test.ts            unit + HTTP integration suites
```

## Deliberate scope cuts

Chosen to fit the time budget; each is a clean extension point rather than a
rewrite:

- **In-memory storage only** — queued/in-flight events are **lost on restart**.
  The repository interfaces make a real store a drop-in swap.
- **Redeliver re-inserts at the queue tail**, not the head — the event already
  lost its ordering slot, so re-blocking the whole queue behind stale work would
  be worse.
- **Idempotency ignores payload mismatch** — the same key always returns the
  original event; a stricter impl would `409` on a differing payload.
- **Offset/limit pagination** — simple and not cursor-stable under concurrent
  inserts.
- **Hand-rolled validation** (no schema library), **no auth / rate limiting**,
  **single process** (horizontal scaling would need a shared queue/store).
