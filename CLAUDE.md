# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A webhook delivery service (Node.js + TypeScript, ESM, Express 5) that delivers
events to customer endpoints with **ordered, retried, HMAC-signed** delivery.
Zero runtime dependencies beyond Express — the env loader, backoff, and delivery
engine are all hand-rolled.

## Commands

```bash
npm run dev      # tsx watch, hot reload, http://localhost:3000
npm test         # Jest + ts-jest (ESM); requires NODE_OPTIONS=--experimental-vm-modules (set by the script)
npm run build    # tsc -p tsconfig.build.json -> dist/
npm start        # run compiled dist/index.js

npx jest tests/delivery.test.ts        # single test file
npx jest -t "head-of-line"             # single test by name
PORT=4000 npm run dev                  # override a config value
npm start -- --env-path ./config/prod.env   # point at a specific env file (NOT --env-file; Node steals that)
```

Config comes from the environment via `src/config.ts` (see `.env.example`).
Env resolution order: explicit `--env-path` (missing path = hard error) → `.env`
in cwd → baked-in defaults. Real env vars always win over the file.

## Module system gotcha

`module: NodeNext` — relative imports **must** carry a `.js` extension even
though the source is `.ts` (e.g. `import { x } from "./foo.js"`). Jest strips
this back to `.ts` via a `moduleNameMapper` in `jest.config.js`. Match this in
every new import or the build breaks.

## Architecture

Layered and dependency-injected: `routes → services → repositories`, with the
delivery engine wired alongside. **No global singletons** — the entire object
graph is assembled in `src/composition.ts` (`createComposition`), which is what
lets tests inject a fake transport, shrunk backoff config, and deterministic
clock/rng. `src/app.ts` (`buildApp`) builds the Express app from
already-constructed services so tests drive it with supertest without a socket.

There is a **DI cycle** (services need the delivery manager; the manager reads
through the services). It is broken with setter injection: build services →
build `DeliveryManager` → `setDeliveryManager()` on each service. Preserve this
ordering in `composition.ts` and `tests/harness.ts`.

### Delivery engine (`src/delivery/`) — the core

- `DeliveryManager` owns a `Map<endpointId, EndpointQueue>`, created lazily.
- Each `EndpointQueue` is a FIFO of event ids drained by **one** worker loop. A
  `running` flag makes `wake()` idempotent so a queue is never double-drained.
- **Ordering = head-of-line blocking.** The head event is *peeked, not shifted*,
  and retried in place until terminal (`delivered`/`dead`); only then does the
  next event start. A later event can never overtake an earlier retrying one.
  This is deliberate — see `endpointQueue.ts:run()`.
- **Isolation.** Per-endpoint queue + loop means endpoints deliver concurrently;
  a slow/down endpoint parks in its own `await` (fetch timeout or backoff sleep)
  without touching other queues.
- The engine touches storage only through the narrow `EndpointReader` /
  `EventStore` seams (`src/delivery/stores.ts`), which the **services** implement
  — never the repositories directly. This keeps the services the single
  write-through point.
- `HttpTransport` (`httpTransport.ts`) is the injectable network boundary;
  `FetchTransport` is prod, `FakeTransport` (`tests/harness.ts`) is tests.

### Two-level storage (important, non-obvious)

The **database (repositories) is the source of truth**; every change is written
through to it. Services (`EndpointService` / `EventService`) hold an in-memory
working set that is a *subset* of the database — only what's needed immediately.

- **Endpoints**: never evicted (no terminal state); memory and DB stay in sync.
- **Events**: only `pending` events stay resident, and at most
  `MAX_IN_MEMORY_EVENTS_PER_ENDPOINT` (10) **per endpoint**. When an event
  becomes terminal (`delivered`/`dead`) it is written to the DB and **evicted
  from memory**. Reads (`findById`) fall back to the DB transparently, so
  `GET /events/:id`, listing, and `redeliver` still work. When an endpoint's
  resident set empties, the service reloads up to 10 recent pending events.
- Capacity, idempotency, and listing checks all run against the **database**, so
  they stay correct across eviction.

### Persistence

Storage is in-memory, so a crash loses queued state. `POST /database/dump`
serializes both repositories to a JSON file (`DATABASE_FILE`, fixed in code, not
client-supplied) for backup or inspection. Each process start writes a fresh
empty snapshot (`index.ts`). There is no load/restore endpoint — dump is
write-only.

## Conventions to follow

- **Errors**: throw the typed helpers in `src/errors.ts` (`badRequest`=400,
  `notFound`=404, `conflict`=409, `capacityExceeded`=500). The `errorHandler` in
  `app.ts` maps `AppError` → its status; everything else → 500. Express 5
  auto-forwards rejected async handlers, so route handlers can just `throw`.
- **Capacity limits deliberately return HTTP 500** (not 429/507) — per the spec;
  don't "fix" this.
- **Signing**: `X-Signature: sha256=<hex>` is HMAC-SHA256 (keyed by the endpoint
  secret) over `<endpointId>.<rawPayload>` — `rawPayload` is
  `JSON.stringify(payload)` captured once at creation. Binding the endpoint id in
  stops a captured body being replayed to a different endpoint. The bytes signed
  must equal the bytes sent, so never re-stringify the payload at delivery time.
- **Logging** (`src/logger.ts`): each service/queue constructs its **own**
  `private readonly logger = new ConsoleLogger()` — the logger is *not* injected
  or shared. Never raw `console.*` in the engine/services. INFO on entity change
  / retry schedule, ERROR on delivery failure/timeout. Log endpoints via
  `redactEndpoint()` (the `secret` is the signing key). Verbosity is uniform via
  `LOG_LEVEL` (`info` | `error` | `silent`), read by every `ConsoleLogger` at
  construction. Tests set `LOG_LEVEL=silent` in `jest.setup.ts` to stay quiet;
  `logger.test.ts` builds `new ConsoleLogger(level)` with an explicit level and
  spies on the console.
- **Event statuses are exactly `pending | delivered | dead`** — there is no
  "delivering" state. An event is `pending` while queued, in flight, and during
  backoff. Don't add a transient state.
- **Paused-endpoint rule**: a delivery that fails while its endpoint is `paused`
  is *parked, not killed* — the event stays `pending` at the head of its queue
  and the worker loop stops draining (`endpointQueue.ts:run` breaks on
  `this.paused`) instead of scheduling a retry. Its remaining attempts run when
  the endpoint is reactivated. A failure only marks an event `dead` when its
  attempts are genuinely exhausted (`endpointQueue.ts:registerFailure`).

## Design rationale

The README's **"Approach & design"** and **"Assumptions"** sections are the
authoritative record of interpretation decisions (ordering semantics, the three
statuses, paused-endpoint parking, capacity caps as 500, the two-level storage /
terminal-event eviction rule). Read them before changing delivery, storage, or
status behavior — each assumption is enforced in code and covered by a test.
