# Realtime Fintech Dashboard — System Specification

> Status: **Draft v2** · Date: 2026-10-29 · Owner: Roman
> v2 changes: money/decimal-library analysis (§5.6, ADR-9), hosting moved to **Render** (§10, ADR-8), GitHub pipeline roadmap (§10.4), Wasm language options (§12.1). The repo has a single `main` branch.
> Scope: test assignment "Senior Frontend Developer — Realtime Fintech Dashboard".
> This document is the single source of truth for requirements, architecture, the delivery plan and future evolution.

---

## Table of contents

1. [Purpose and problem statement](#1-purpose-and-problem-statement)
2. [Glossary](#2-glossary)
3. [Requirements](#3-requirements)
4. [Architecture overview](#4-architecture-overview)
5. [Component specifications](#5-component-specifications)
6. [Data model and contracts](#6-data-model-and-contracts)
7. [Key flows (sequence)](#7-key-flows)
8. [Cross-cutting concerns](#8-cross-cutting-concerns)
9. [Testing strategy](#9-testing-strategy)
10. [Build, CI/CD pipeline and Render hosting](#10-build-cicd-pipeline-and-render-hosting)
11. [Repository layout](#11-repository-layout)
12. [Architecture decision records (ADR)](#12-architecture-decision-records)
13. [Step-by-step delivery plan](#13-step-by-step-delivery-plan)
14. [Requirements traceability matrix](#14-requirements-traceability-matrix)
15. [Risks and mitigations](#15-risks-and-mitigations)
16. [Future development proposals](#16-future-development-proposals)
17. [Open questions](#17-open-questions)

---

## 1. Purpose and problem statement

The system is a browser-only, real-time market-data dashboard. A **simulated market-data producer**, written in Rust and compiled to WebAssembly, runs inside a **Web Worker** and generates a continuous stream of **market updates** (one trade plus a top-of-book bid/ask snapshot each) for a configurable set of fictional instruments. The worker aggregates the stream into per-instrument metrics. The Angular UI shows them as a live table.

The system covers these problems:

| # | Problem | How the system solves it |
|---|---|---|
| P1 | Show live, correct trading metrics per instrument | Exact, incremental aggregation using integer cents. Computing the metrics needs no event history. |
| P2 | Keep the UI responsive at high data rates (up to 20,000 updates/s) | Generation and aggregation run off the main thread. Snapshots are conflated, rendering is coalesced to animation frames, and the app uses zoneless signals with OnPush. |
| P3 | Let the operator control the producer | Pause/Resume, producer status, and a settings page with validation and an explicit Apply. |
| P4 | Guarantee that each run is consistent | Monotonic `runId` fencing. Late results from a previous run are dropped. Apply resets all totals atomically. |
| P5 | Prove that the code is correct | Unit tests for the Rust generator, TS metrics, the worker engine, the stores and the forms. A contract test runs the compiled `.wasm`. |
| P6 | Deliver continuously | GitHub Actions lints, tests and builds every push. Render auto-deploys `main` once the CI checks pass. |

### Non-goals
- No realistic exchange, matching engine, order book depth or market microstructure.
- No backend, auth, persistence across reloads or historical charts. Section 16 covers these as future work.
- No e2e test suite. It is optional and listed as future work.

---

## 2. Glossary

| Term | Definition |
|---|---|
| Instrument | A fictional tradable asset identified by a symbol (e.g. `ALFA`). |
| Market update | One generated event: one trade (price, quantity) plus the current best bid/ask prices and quantities for one instrument. |
| Batch | `updatesPerBatch` market updates generated in one producer tick. Instruments may repeat within a batch. |
| Run | One lifetime of a producer configuration. A run starts on app boot or on **Apply** and is identified by `runId`. |
| Last traded price (LTP) | Price of the most recent trade of an instrument. |
| Bid / Ask | Best available buying price / best available selling price. Invariant: `bid < ask`. |
| Spread | `ask − bid`. |
| Volume | Cumulative sum of trade quantities in the current run. |
| VWAP | `Σ(price × qty) / Σ(qty)` over the current run. |
| Order-book imbalance (OBI) | `(bidQty − askQty) / (bidQty + askQty)` ∈ [−1, +1]. |
| Conflation | Delivering only the latest state to a slow consumer instead of queuing every intermediate state. This is a standard market-data technique. |
| Fencing token | A monotonically increasing id (`runId`). Messages that carry an older id are rejected. |

---

## 3. Requirements

### 3.1 Functional requirements

**Dashboard (FR-D)**
- **FR-D1** Table with one row per instrument of the active run.
- **FR-D2** Columns: Symbol, Last price, Bid–ask spread, Volume, VWAP, Order-book imbalance. Bid, ask and quantities are optional secondary columns.
- **FR-D3** Before any data arrives, show "unavailable" (`—`) for price-based metrics and `0` for volume.
- **FR-D4** Show "unavailable" when a formula's denominator is zero: VWAP when `Σqty = 0`, OBI when `bidQty + askQty = 0`.
- **FR-D5** Format prices as currency (USD, 2 decimals). Format OBI as a signed value in [−1, +1] with 2 decimals (e.g. `+0.20`).
- **FR-D6** Pause/Resume control. Pause stops generation. Resume keeps all values and totals and does **not** back-fill the paused interval.
- **FR-D7** Producer status: lifecycle state (initializing / running / paused / error), run id, active settings, total updates and effective rate.

**Settings (FR-S)**
- **FR-S1** Form fields: Instrument count (1–50, default 5), Updates per batch (1–1000, default 100), Batch interval in ms (50–2000, default 500). All fields are integers and required.
- **FR-S2** Editing the form does not affect the producer.
- **FR-S3** **Apply** (enabled only when the form is valid and differs from the active settings, or always enabled; see Open questions) starts a new run. It clears all previous values and totals and starts generation even when the producer was paused.
- **FR-S4** Field errors are inline, accessible and specific (required, not integer, out of range).
- **FR-S5** The app starts with the default settings. Settings are not persisted across reloads.

**Producer (FR-P)**
- **FR-P1** The Wasm library generates market updates. It does not generate metrics.
- **FR-P2** Per-instrument state persists across calls. Prices evolve from previous values (random walk).
- **FR-P3** Invariants: `price > 0`, `bid > 0`, `bid < ask`, `tradeQty > 0`, `bidQty ≥ 0`, `askQty ≥ 0`, and `tradePrice ∈ {bid, ask}`.
- **FR-P4** `generate(n)` returns exactly `n` updates.
- **FR-P5** Randomness (PRNG) and price logic run in Wasm.
- **FR-P6** The producer runs in a Web Worker. Only one producer exists per app instance, regardless of navigation.
- **FR-P7** Initialization errors (fetch, compile, instantiate, ABI mismatch) are shown in the UI with a meaningful message and a Retry action.
- **FR-P8** Resources are cleaned up: the worker is terminated and timers are cleared when the producer is replaced or the app is destroyed.

**Navigation (FR-N)**
- **FR-N1** Two lazy-loaded routes: `/dashboard` (default) and `/settings`.
- **FR-N2** Navigation keeps the active run and its running/paused state. No extra producers are created.

### 3.2 Non-functional requirements

| Id | Requirement | Target |
|---|---|---|
| NFR-1 Performance | Main thread remains interactive at the max rate (1000 updates / 50 ms = 20k/s) | No long tasks > 50 ms on main thread caused by data flow. UI refresh ≤ 1 per animation frame. |
| NFR-2 Correctness | Monetary values exact | Integer minor units (cents) on the hot path. Exact VWAP numerator (BigInt carry). The single non-exact operation, VWAP division, uses a decimal library with an explicit rounding mode (`ROUND_HALF_EVEN`). No binary floating point touches a money value. See §5.6. |
| NFR-3 Memory | Bounded | O(instruments) state. No event history is retained. Wasm output buffer is pre-allocated once. |
| NFR-4 Accessibility | WCAG 2.2 AA, passes AXE | Semantic table, labelled controls, focus management, `aria-live` for status, contrast ≥ 4.5:1, honours `prefers-reduced-motion`. |
| NFR-5 Reliability | Deterministic and reproducible | Seeded PRNG. The same seed and settings produce the same stream. |
| NFR-6 Security | Hardened static app | Real HTTP security headers served by Render: CSP (`script-src 'self' 'wasm-unsafe-eval'`), HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and `frame-ancestors 'none'`. No `eval`, no third-party runtime scripts. The worker validates commands. |
| NFR-7 Maintainability | Strict typing, small units | TS `strict`, no `any`, discriminated unions, pure functions for domain logic, lint/format gates in CI. |
| NFR-8 Testability | No real-time waits | Injected scheduler/clock, fake workers, fake generator, `vi.useFakeTimers`. |
| NFR-9 Deployability | Every push builds and deploys | Every push runs GitHub Actions CI. Render auto-deploys `main` after the checks pass (`autoDeployTrigger: checksPass`), with no manual steps. |
| NFR-10 Bundle | Small | Initial JS < 500 kB budget. Wasm < 50 kB (release build, `opt-level="s"`, LTO, `wasm-opt`). |

---

## 4. Architecture overview

### 4.1 Context

```
┌──────────────────────────────── Browser tab ────────────────────────────────┐
│                                                                             │
│  MAIN THREAD (Angular 22, zoneless, signals)                                │
│  ┌──────────────┐   ┌───────────────────┐   ┌──────────────────────────┐    │
│  │ DashboardPage│◄──│   MarketStore     │◄──│ MarketProducerClient     │    │
│  │ SettingsPage │──►│   SettingsStore   │──►│ (owns the single Worker) │    │
│  └──────────────┘   └───────────────────┘   └────────────┬─────────────┘    │
│                                                         │ postMessage      │
│                                       commands ▼        │ ▲ events         │
│  ───────────────────────────────────────────────────────┼──────────────────│
│  WEB WORKER                                              │                  │
│  ┌────────────────────────────────────────────────────────┴─────────────┐   │
│  │ worker entry (message router, validation)                             │   │
│  │   └─ ProducerEngine (state machine + scheduler + conflation)          │   │
│  │        ├─ WasmMarketGenerator (ABI adapter, zero-copy views)          │   │
│  │        │     └─ market_gen.wasm (Rust: PRNG, per-instrument model)    │   │
│  │        └─ MarketAggregator (exact cumulative metrics, TS, pure)       │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Architectural principles

1. **The worker is the source of truth for market state.** The main thread only renders snapshots. Hot-path work (generation and aggregation) never crosses the thread boundary per update.
2. **Zero-copy hot path.** Wasm writes each batch into a pre-allocated region of linear memory. The aggregator reads it through a typed-array view and copies nothing.
3. **Conflated, versioned snapshots.** The worker posts at most one snapshot per batch, and only after the main thread acknowledged the previous one ("latest wins"). Every message carries `runId` and `seq`.
4. **Fencing by `runId`.** The main thread owns the run counter. Stores drop any event whose `runId` differs from the current one. This addresses FR-S3 and requirement 4 ("rejection of results from a previous run").
5. **Pure domain core.** Metric formulas, the aggregator, validation and formatting are framework-free pure TS. They are trivially unit-testable and shared by the worker and the UI.
6. **Ports and adapters.** The engine depends on the interfaces `MarketGenerator`, `Scheduler`, `Clock` and `EventSink`. The Wasm adapter, timers and `postMessage` are adapters that tests replace.
7. **Signals all the way.** Stores expose read-only signals. Components use `computed()`. Zoneless change detection with OnPush (Angular 22 defaults).
8. **Integer money, decimal at the boundary.** Prices are cents (`u32` in Wasm, safe integers in TS). The VWAP numerator `Σ(cents×qty)` is accumulated exactly. The only division (VWAP) runs once per snapshot in a decimal library with an explicit rounding mode. Results cross the thread boundary as decimal strings, never as floats (§5.6).
9. **Fail loudly and recoverably.** Typed error events, an `error` producer state and a user-visible Retry action. No silent swallowing.

### 4.3 Where things live (decision summary)

| Concern | Location | Rationale |
|---|---|---|
| PRNG, price/qty/book evolution | Rust → Wasm | Required by the task. Deterministic and fast. |
| Metric aggregation (volume, VWAP, last, book) | TS in Worker (`MarketAggregator`) | Off the main thread. Pure TS keeps metric tests in the same toolchain as the UI. Wasm stays a pure data generator (single responsibility). |
| Derived metrics (spread, OBI, VWAP division) | Pure TS functions (`metrics.ts`), evaluated in the worker at snapshot time. VWAP division uses `decimal.js`. | One implementation, unit-tested against the worked example. |
| Formatting (currency, signed OBI, "unavailable") | Main thread, pure formatter functions plus `Intl.NumberFormat`. Money is formatted from decimal **strings**. | Presentation concern, locale-aware, no float round-trip. |
| Run counter, settings | Main thread stores | UI owns intent. The worker obeys commands. |

---

## 5. Component specifications

### 5.1 Wasm library `market-gen` (Rust)

**Crate layout** (`wasm/market-gen/`):
- `rng.rs` — `Pcg32` (or `Xoshiro128**`), seedable with `u64`. Hand-written with no dependencies, so the randomness verifiably runs in Wasm.
- `model.rs` — `InstrumentState { mid_ticks, half_spread_ticks, bid_qty, ask_qty, anchor_ticks }`.
- `generator.rs` — `Generator { rng, instruments: Vec<InstrumentState>, out: Vec<Update> }`, plus `fn generate(&mut self, n) -> &[Update]`. This is pure Rust and testable with `cargo test`.
- `lib.rs` — a thin C ABI (`#[no_mangle] extern "C"`) over a single global `Generator`. No wasm-bindgen glue. See ADR-3.

**Simulation model (per update):**
1. Pick an instrument uniformly: `i = rng.below(instrumentCount)`.
2. Evolve the mid price with a mean-reverting random walk in integer ticks: `mid += step(±0..3 ticks) + reversion toward anchor`, clamped to `mid ≥ MIN_MID` (e.g. 100 cents).
3. Evolve the spread: `spread ∈ [1, 10]` ticks, as a random walk with clamping. Set `bid = mid − floor(spread/2)` and `ask = bid + spread`. This guarantees `bid ≥ 1` and `bid < ask`.
4. Evolve the book quantities with a random walk clamped to `[0, 10_000]`. Zero is allowed, which exercises the OBI "unavailable" path.
5. Trade: pick a side with `rng.bool()`. A buy aggressor trades at `ask`, a sell aggressor at `bid`. `qty = 1 + geometric-ish(rng)` clamped to `[1, 1_000]`.
6. Write the `Update` into the output buffer.

Initial state for each instrument is derived from the seed: anchor in $10–$500, spread 1–5 ticks, book qty 100–2000.

**Memory layout of output (AoS, `u32` × 7 stride, little-endian):**

| Offset (u32) | Field | Type / range |
|---|---|---|
| 0 | `instrument` | index `0..count-1` |
| 1 | `priceCents` | `> 0` |
| 2 | `tradeQty` | `1..=1000` |
| 3 | `bidCents` | `> 0` |
| 4 | `askCents` | `> bidCents` |
| 5 | `bidQty` | `0..=10000` |
| 6 | `askQty` | `0..=10000` |

**ABI (exports):**

| Export | Signature | Semantics |
|---|---|---|
| `abi_version` | `() -> u32` | Returns `1`. The worker checks it at load time (FR-P7). |
| `init` | `(seed_lo: u32, seed_hi: u32, instruments: u32, max_batch: u32) -> i32` | (Re)creates the generator and pre-allocates `max_batch × 7` u32. Returns `0` on success and a negative error code on invalid arguments. |
| `generate` | `(n: u32) -> u32` | Generates `n` updates and returns a pointer to the buffer, or `0` on error (not initialised, `n > max_batch`). |
| `update_stride` | `() -> u32` | Returns `7`. Lets JS validate the layout. |
| `memory` | exported memory | The worker creates a `Uint32Array` view after `init` and recreates it if `memory.buffer` changes (detached-view guard). |

Build: `cargo build --release --target wasm32-unknown-unknown`, with `opt-level="s"`, `lto=true`, `panic="abort"` and `codegen-units=1`. The `.wasm` file is copied to `public/wasm/market_gen.wasm`. `wasm-opt -Oz` (from the `binaryen` npm package) is optional.

### 5.2 Web Worker (`src/app/producer/worker/`)

**`market.worker.ts` (entry)** — wires `self.onmessage`, validates incoming commands (type guard plus settings limits; defense in depth) and delegates to `ProducerEngine`. Uncaught errors are converted to `{type:'error'}` events.

**`ProducerEngine`** — a state machine:

```
          load(wasmUrl)            start(run)              pause
 [idle] ───────────────► [ready] ─────────────► [running] ───────► [paused]
    │  fail                ▲           ▲  start(run)  ◄───────────    │
    ▼                      │           └──────────────── resume ──────┘
 [error] ── load (retry) ──┘                    start(run) from paused → running
```

- `start(run)` resets the aggregator, calls `generator.init(seed, count, updatesPerBatch)`, sets `currentRunId` and schedules ticks. It is valid from `ready`, `running` and `paused` (FR-S3).
- `pause()` cancels the pending timer. Generation is synchronous, so no batch is in flight. Then it emits `status: paused`.
- `resume()` schedules the next tick at `now + interval`. There is **no catch-up** for the paused period (FR-D6).
- **Tick:** `ptr = generate(n)`, `aggregator.ingest(view, n)`, then `seq++`. If the previous snapshot was acked, it emits a snapshot. Otherwise it marks `dirty` (conflation). On `ack`, if `dirty`, it emits the latest snapshot immediately.
- **Scheduler:** drift-compensated `setTimeout` (`next = scheduledAt + interval`). If the engine falls behind by more than one interval, it reschedules from `now` and does not burst. This avoids a death spiral. It counts `lateTicks` for status.
- Stats in each snapshot: `totalUpdates`, `batches`, `lastBatchGenMs` and `effectiveRate` (updates/s over a sliding 1 s EMA).

**`WasmMarketGenerator` (adapter)** — `load(url)` uses `WebAssembly.instantiateStreaming(fetch(url))` and falls back to `arrayBuffer` + `instantiate` when the MIME type is wrong. It verifies `abi_version`/`update_stride` and maps error codes to typed errors such as `WASM_FETCH_FAILED`, `WASM_COMPILE_FAILED`, `ABI_MISMATCH` and `INIT_REJECTED`.

**`MarketAggregator`** — fixed arrays sized `instrumentCount`:
- `last`, `bid`, `ask`, `bidQty`, `askQty` (Float64Array, NaN = no data yet)
- `volume` (Float64Array; max 20k×1000/s means about 2e7/s, which stays safe for more than 10 years)
- `notional`: an exact `Σ(cents×qty)`. Within a batch it accumulates in a per-instrument Float64 holding integers only (≤ 1000 updates × 2^32 × 1000, well under 2^53). After each batch it carries into a `BigInt` per instrument. That costs at most 50 BigInt adds per batch. **Exact for unbounded run length.**
- VWAP: at snapshot time, `new Dec(notional.toString()).div(volume).toFixed(4)`, where `Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN })`. A local clone keeps the global `Decimal` config untouched. That gives VWAP in cents with 4 extra decimals, e.g. `10150.0000` cents. It is emitted as a decimal **string** (§5.6).
- `snapshot()` produces SoA `Float64Array`s for the integer fields (last, bid, ask, spread in cents; bidQty, askQty, volume; obi), sent as **transferable** buffers, plus `vwapCents: (string | null)[]`. OBI is a dimensionless ratio, not money, so a float is correct for it.

### 5.3 Main-thread services (`@Service`, root singletons)

**`ProducerWorkerFactory`** (injection token) — `() => Worker`. The default creates `new Worker(new URL('./worker/market.worker', import.meta.url), { type: 'module' })`. Tests provide a `FakeWorker`.

**`MarketProducerClient`** — owns the **single** worker for the app's lifetime. Navigation cannot create another one because the client is a root singleton, not a component. It is created eagerly through `provideAppInitializer` so data flows before the first page renders.
- `load()` posts `{type:'load', wasmUrl}`. The wasm URL is resolved with `new URL('wasm/market_gen.wasm', document.baseURI)`, so it stays correct under any `base href`.
- It translates the commands `start/pause/resume/ack` and exposes `events$` as an Observable, bridged to signals in the store.
- `retry()` terminates the broken worker, creates a new one and replays `load` plus `start(currentRun)`.
- `DestroyRef.onDestroy` → `worker.terminate()` (FR-P8).

**`MarketStore`** — the state for the dashboard:
- `runId: Signal<number>` (owned here; incremented on apply)
- `status: Signal<ProducerStatus>`, `error: Signal<ProducerError | null>`, `stats: Signal<ProducerStats>`
- `rows: Signal<readonly InstrumentRow[]>`, built from the latest snapshot. Before the first snapshot, rows contain empty values (FR-D3).
- `applySnapshot(evt)` **drops** the event if `evt.runId !== runId()` (fencing). Otherwise it stores the event in a pending slot. A `requestAnimationFrame` flush commits at most one snapshot per frame to the signal and posts `ack` (coalescing plus backpressure).
- `pause() / resume() / startRun(settings)`. `startRun` increments `runId`, resets rows to empty for `settings.instrumentCount` synchronously (FR-S3 reset), then sends `start`.

**`SettingsStore`** — `applied: Signal<ProducerSettings>` (defaults on boot), `apply(settings)` → `MarketStore.startRun`. Domain constants (`DEFAULT_SETTINGS`, `SETTINGS_LIMITS`) live in `core/settings.ts` and are shared with the worker validator.

### 5.4 UI components

| Component | Responsibility | Notes |
|---|---|---|
| `AppShell` (`App`) | Header, primary nav (`routerLink` with `ariaCurrentWhenActive`), producer status badge, `<router-outlet>` | Skip-link to `<main>`. Focus moves to the page `<h1>` on navigation. |
| `ProducerStatusComponent` | Badge with state, run #, active settings, effective rate | `role="status"` / `aria-live="polite"`. It announces state changes only, not the ticking numbers. |
| `DashboardPage` (lazy) | Composes the controls and the table | Route title "Dashboard". |
| `ProducerControlsComponent` | Pause/Resume button | A single toggle `<button aria-pressed>`. Disabled while initializing or in error. |
| `MarketTableComponent` | `<table>` with `<caption>`, `<th scope="col">`, `@for (row of rows(); track row.symbol)` | Numeric cells right-aligned with tabular-nums. "Unavailable" is rendered as `—` with visually-hidden text "not available". Optional up/down tick flash, disabled under `prefers-reduced-motion`. |
| `SettingsPage` (lazy) | Signal Forms form with three integer fields, Apply and "Reset to defaults" | Inline errors linked with `aria-describedby`. After Apply, an `aria-live` confirmation is shown. The form is initialised from `applied()` and does not affect the producer until Apply. |
| `ErrorBanner` | Shows the init/runtime error with code, message and **Retry** | `role="alert"`. |

**Formatting** (`core/format.ts`, pure, tested): `formatMoney(minorUnits: number | string | null)`, `formatSpread`, `formatImbalance(v)` → `+0.20` / `−0.35` / `0.00`, `formatVolume` (grouping). Each one returns `'—'` for unavailable values. Money is converted from cents to a decimal string with `decimal.js` (`.div(100).toFixed(2, ROUND_HALF_EVEN)`). The string goes to `Intl.NumberFormat.format()`, which formats decimal strings exactly (Intl.NumberFormat v3). `Intl.NumberFormat` instances are cached.

### 5.5 Settings validation (Signal Forms)

- Model: `signal<ProducerSettings>({...applied})`, wrapped in `form(model, schema)`.
- Schema per field: `required`, `min`, `max` and a custom `integer` validator. Inputs are `type="number"` with `step="1"` and `inputmode="numeric"`.
- The same rules exist as a pure `validateSettings(s): ValidationResult` in `core/settings.ts`. The worker validator and unit tests reuse it, so the rules have one source of truth.

### 5.6 Money and numeric precision — decimal library analysis

**Where precision actually matters in this system**

| Operation | Frequency | Exact with integers? |
|---|---|---|
| Price, bid, ask (generation and storage) | per update (≤ 20k/s) | Yes. Integer cents from Wasm. |
| Spread `ask − bid` | per snapshot | Yes. Integer subtraction. |
| Notional `Σ(price × qty)` | per update | Yes. Integer multiply and add, made unbounded with a BigInt carry. |
| Volume `Σqty` | per update | Yes. |
| **VWAP `notional / volume`** | per snapshot (≤ 50 × ~20/s) | **No.** Division gives a non-terminating decimal, so it needs an explicit **scale and rounding mode**. |
| Display (cents → "$101.50") | per render | Rounding needs an explicit policy. |
| OBI | per snapshot | A dimensionless ratio, not money. A float is appropriate. |

So money in this system needs exact integer accumulation on the hot path and a **controlled division and rounding policy** at the edge. Arbitrary-precision decimal arithmetic for every operation isn't needed.

**Candidates**

| Option | Size (min+gz) | Model | Rounding modes | Division | Hot-path cost | Fit |
|---|---|---|---|---|---|---|
| Integer cents + `BigInt`, no library | 0 | Integer minor units | Hand-written | Hand-written BigInt division with half-even | Lowest, no allocation | Exact, but rounding code is hand-written and needs to be tested and reviewed. |
| big.js | ~3 kB | Arbitrary-precision decimal, small API | Down, half-up, half-even, up | Yes (`DP`, `RM`) | Allocates per op | Minimal and sufficient, but global `DP`/`RM` config and fewer rounding modes. |
| **decimal.js** (chosen) | ~12 kB | Arbitrary-precision decimal with significant-digit precision, plus math functions | 9 modes, including `ROUND_HALF_EVEN` | Yes | Allocates per op | **Chosen.** The de-facto JS decimal standard (used e.g. by Prisma's `Decimal`). `Decimal.clone()` gives an isolated, explicitly configured constructor, rounding mode can be passed per call (`toFixed(dp, rm)`), and the full rounding-mode set covers future needs (risk, fees, FX). |
| bignumber.js | ~8 kB | Arbitrary-precision decimal plus base conversion | 9 modes | Yes | Allocates per op | Comparable to decimal.js. Its base conversion is irrelevant here. |
| Dinero.js v2 | ~2–5 kB (tree-shaken) | **Money value object** (amount, currency, scale), immutable, `number`/`bigint` calculators | half-even and others | **No divide-by-scalar** (only `multiply` and `allocate`), so VWAP needs a workaround | Allocates per op | Excellent for currency-aware money (multi-currency, allocation, `toDecimal`). Overkill for one-currency display, and awkward for VWAP. |
| currency.js | ~1 kB | Float-backed with fixed precision | Fixed | Yes | Low | **Rejected.** Built on binary floats internally. |
| TC39 `Decimal` proposal | — | Native decimal128 | — | — | — | Not shipped in browsers. Listed as future work. |

**Decision (ADR-9): a hybrid with layered responsibilities**
1. **Hot path (worker, per update):** integers only, no library. Prices are `u32` cents, quantities are integers, and notional uses a Float64 integer accumulator with a per-batch BigInt carry. Every generated trade costs one integer multiply-add and creates no objects or GC pressure. At 20k updates/s a decimal library would allocate about 40k objects/s for no gain, because these operations are already exact.
2. **Boundary (worker, per snapshot):** **`decimal.js`** for the VWAP division, through a private constructor `Dec = Decimal.clone({ precision: 40, rounding: ROUND_HALF_EVEN })`. The output is cents with 4 extra decimals, using banker's rounding, which is the usual choice in finance because it avoids systematic rounding bias. The result is serialized as a decimal string.
   - *Why precision 40 is safe from double rounding:* `div` rounds to 40 significant digits before `toFixed(4)` rounds again. A wrong half-even tie would need the exact quotient to have a run of 0s or 9s beyond decimal 4 longer than `log10(volume)` (≤ 15) digits, which is impossible for a non-terminating `n/d` with `d ≤ 10^15`. VWAP has ≤ 10 integer digits, so 10 + 4 + 15 < 40.
3. **Presentation (main thread):** a `Money` helper in `core/money.ts` turns cents or decimal-string cents into a dollars string with `decimal.js` (`toFixed(2, ROUND_HALF_EVEN)`). `Intl.NumberFormat` formats that string. A JS `number` never holds a fractional money value.
4. **Encapsulation:** all `decimal.js` usage sits behind `core/money.ts`, with functions such as `vwapCents`, `centsToDecimalString` and `formatMoney`. Swapping it for Dinero.js or the native TC39 `Decimal` later is a one-file change.
5. **Evidence:** in Phase 2, a Vitest `bench` compares (a) the integer hot path with (b) the same aggregation using `decimal.js` per update, at 20k updates/s. The numbers go in the README as the justification for the hybrid.

**Tests:** the worked example gives a VWAP string of `"10150.0000"` and displays as `$101.50`. Half-even ties round both ways: `x.xx5` rounds to even. Exactness holds after 10^9 simulated trades through a synthetic large notional. An unavailable value (volume 0) gives `null` and displays as `—`.

---

## 6. Data model and contracts

```ts
// core/settings.ts
export interface ProducerSettings {
  readonly instrumentCount: number;  // int 1..50
  readonly updatesPerBatch: number;  // int 1..1000
  readonly batchIntervalMs: number;  // int 50..2000
}

// core/protocol.ts  (PROTOCOL_VERSION = 1)
export type ProducerCommand =
  | { type: 'load'; wasmUrl: string }
  | { type: 'start'; runId: number; settings: ProducerSettings; seed: [number, number] }
  | { type: 'pause'; runId: number }
  | { type: 'resume'; runId: number }
  | { type: 'ack'; runId: number; seq: number };

export type ProducerEvent =
  | { type: 'ready'; abiVersion: number }
  | { type: 'status'; runId: number; state: 'running' | 'paused' }
  | { type: 'snapshot'; runId: number; seq: number; stats: ProducerStats; data: SnapshotData; vwapCents: (string | null)[] }
  | { type: 'error'; runId: number | null; code: ProducerErrorCode; message: string; fatal: boolean };

export interface SnapshotData {           // SoA, all length = instrumentCount, NaN = unavailable
  last: Float64Array; bid: Float64Array; ask: Float64Array;   // integer cents
  spread: Float64Array;                                       // integer cents
  obi: Float64Array;                                          // ratio in [-1, 1]
  bidQty: Float64Array; askQty: Float64Array; volume: Float64Array; // integers
}
// VWAP travels separately as decimal strings in cents (e.g. "10150.0000"), null = unavailable.
```

Symbols are produced by a deterministic table of 50 four-letter symbols in `core/symbols.ts` (`ALFA, BETA, GAMA, DELT, …`). The Wasm library deals only in indices.

---

## 7. Key flows

**Boot**
1. The app initializer creates `MarketProducerClient`, which spawns the worker → `load(wasmUrl)`.
2. The worker fetches and instantiates the Wasm and checks the ABI → `ready`. On failure → `error(fatal)` and the UI shows the banner with Retry.
3. On `ready`, `MarketStore.startRun(DEFAULT_SETTINGS)` sets `runId=1`, sets empty rows and sends `start`.

**Steady state**
Tick → Wasm `generate(n)` → aggregator ingests a zero-copy view → snapshot (if acked) → main thread pending slot → rAF flush → signal set → table re-renders → `ack`.

**Pause/Resume**
`pause` → the engine clears its timer → `status paused`. `resume` → next tick at `now + interval`. Totals are kept and no back-fill happens.

**Apply (new run)**
`runId++`, rows reset synchronously → `start{runId, settings, seed}` → the engine resets the aggregator and Wasm state and reschedules. Any snapshot of the old run already in flight arrives with the old `runId` and is **dropped** by the store.

**Retry after error**
Terminate the worker → spawn a new one → `load` → on `ready`, `startRun(applied settings)`.

---

## 8. Cross-cutting concerns

- **Performance:** the hot path never allocates. Typed-array views are reused and snapshot buffers are transferred, not cloned. Rendering is coalesced to rAF and there are no per-update `postMessage` calls. `track row.symbol` keeps DOM nodes stable. Zoneless signals mean only the affected bindings update. At most 50 rows means no virtualization is needed; it is listed as future work for larger universes.
- **Precision:** integer cents and an exact BigInt notional. The one division (VWAP) uses `decimal.js` with half-even rounding. Money is formatted from decimal strings. A unit test asserts `$101.50` for the worked example and exactness for large accumulations (§5.6).
- **Error handling:** typed error codes. `worker.onerror` and `onmessageerror` map to the `error` state. Wasm traps (`RuntimeError`) are caught per tick, the engine stops, and it emits a fatal error.
- **Security:** Render serves the security headers from `render.yaml`, which is stronger than a `<meta>` CSP because it covers `frame-ancestors` and applies before HTML parsing. The CSP is `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. The other headers are HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a restrictive `Permissions-Policy`. There are no third-party runtime scripts, and dependency versions are pinned with a lockfile. `npm audit` and `cargo audit` run in CI (non-blocking at first).
- **Accessibility:** AXE checks in component tests (`axe-core` run against rendered fixtures), a semantic table, visible focus styles, contrast tokens checked against AA, and reduced-motion support. Status changes are announced politely; the high-frequency numbers are not announced.
- **Observability (lightweight):** producer stats panel (rate, gen time, late ticks). `ErrorHandler` via `provideBrowserGlobalErrorListeners`. A `console` logger with levels sits behind a `Logger` service and can later be swapped for Sentry or OpenTelemetry.
- **Code quality:** TS `strict`, ESLint (`angular-eslint`), Prettier, `cargo fmt` and `cargo clippy -D warnings`. Conventional commits.

---

## 9. Testing strategy

| Layer | Tool | Key cases |
|---|---|---|
| Rust generator | `cargo test` | Batch size exactly `n` for n ∈ {1, 7, 1000}. All invariants hold over 100k updates × many seeds. Determinism: same seed gives the same sequence. Prices evolve (|Δmid| per step bounded) rather than being i.i.d. State persists across `generate` calls. Every instrument index is `< count`. `init` rejects 0 or >50 instruments and `n > max_batch`. |
| Wasm contract | Vitest (Node) loading the built `.wasm` | `abi_version == 1`, stride 7, a batch of `n` decoded through a `Uint32Array` satisfies the invariants, and error codes work. |
| Money (pure) | Vitest + `bench` | Half-even rounding on ties, cents↔decimal-string conversion, formatting from strings, `null` gives `—`. A benchmark compares the integer hot path with `decimal.js` per update. |
| Metrics (pure) | Vitest | Worked example: LTP $102, volume 40, VWAP `"10150.0000"` cents shown as $101.50, spread $0.04, OBI 0.20. Zero denominators give unavailable values. The initial state is unavailable with volume 0. **Isolation**: trades on ALFA don't affect BETA. Large-sum exactness (BigInt carry). |
| Formatters | Vitest | Currency, signed imbalance, NaN → `—`. |
| ProducerEngine | Vitest + fake generator + fake scheduler/clock | Start generates per tick. Pause stops ticks. Resume does not back-fill (advance fake time by 10 intervals while paused → 0 batches). Start-while-paused → running. A start resets the aggregator. Conflation emits nothing until ack. A drift/late tick does not burst. A generator error gives a fatal error. |
| MarketStore | Vitest + fake client | Stale `runId` snapshot is **rejected**. `startRun` resets rows and volume to 0. Pause/resume send commands and preserve rows. rAF coalescing (fake rAF) applies the last of N snapshots. |
| Settings | Vitest + TestBed | Defaults. Validation (required, non-integer `1.5`, below min, above max, at the boundaries). Editing does not call the store. Apply with valid input calls `startRun` once with the new settings. Apply while invalid is blocked. Apply while paused leads to running. |
| Components | Vitest + TestBed + axe-core | The table renders unavailable values pre-data. The Pause button toggles `aria-pressed`. The error banner shows Retry. No AXE violations. |
| Navigation | Vitest + RouterTestingHarness | Navigate dashboard → settings → dashboard: the worker factory was called **once** and the paused state is preserved. |

There are no real-time waits: all timing goes through injected `Scheduler`/`Clock` or `vi.useFakeTimers()`.

---

## 10. Build, CI/CD pipeline and Render hosting

### 10.1 Local scripts (`package.json`)
- `build:wasm` — `cargo build --release --target wasm32-unknown-unknown --manifest-path wasm/market-gen/Cargo.toml`, then `node scripts/copy-wasm.mjs`, which copies the output to `public/wasm/` (cross-platform)
- `prestart` / `prebuild` / `pretest` → `build:wasm`
- `test` — `ng test --watch=false`. `test:wasm` — `cargo test`. `test:all` — both.
- `lint` — `ng lint && cargo fmt --check && cargo clippy -- -D warnings`
- `ci` — `lint`, then `test:all`, then `build`. One command reproduces CI locally.

### 10.2 Hosting on Render (Static Site)

A **Render Static Site** is free, served from a global CDN and has no cold starts. It is configured as **infrastructure-as-code** with a Blueprint file `render.yaml` at the repo root:

```yaml
services:
  - type: web
    runtime: static
    name: fintech-dashboard
    branch: main
    autoDeployTrigger: checksPass        # deploy only after GitHub CI checks pass on the commit
    buildCommand: bash scripts/render-build.sh
    staticPublishPath: dist/Fintech-dashboard/browser   # case-sensitive on Render (Linux); verified with ng build
    envVars:
      - key: SKIP_INSTALL_DEPS           # we run `npm ci` ourselves (lockfile-exact, no double install)
        value: "true"
    routes:
      - type: rewrite                    # SPA deep links: /settings → index.html
        source: /*
        destination: /index.html
    headers:
      - path: /*
        name: Content-Security-Policy
        value: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      - { path: /*, name: Strict-Transport-Security, value: "max-age=63072000; includeSubDomains" }
      - { path: /*, name: X-Content-Type-Options, value: nosniff }
      - { path: /*, name: Referrer-Policy, value: no-referrer }
      - { path: /*, name: Permissions-Policy, value: "camera=(), microphone=(), geolocation=()" }
      - { path: /*.js, name: Cache-Control, value: "public, max-age=31536000, immutable" }   # hashed bundles
      - { path: /index.html, name: Cache-Control, value: no-cache }
      - { path: /wasm/*, name: Cache-Control, value: "public, max-age=3600" }
```

**Deployment readiness: is a server (Express or similar) needed?** Verified on 2026-10-29, the answer is **no**.

| Check | Finding | Consequence |
|---|---|---|
| Rendering mode | `angular.json` has only `browser: src/main.ts`, with no `server`, `ssr` or `outputMode` keys. `ng build` emits only `dist/Fintech-dashboard/browser/` (index.html, hashed JS/CSS) and no `server/` folder. | Pure client-side app, so it deploys as a **Render Static Site** on the CDN. **No Express, no `server.ts`, no start command, no port binding.** An Express server is only needed for a **Web Service** or an **SSR** app (`ng add @angular/ssr` generates an Express `server.ts`). Neither is used here. Pick **Static Site / Blueprint**, never "Web Service". |
| Client-side routes | `/settings` does not exist as a file | The `routes` rewrite `/* → /index.html` is **required**. Without it a refresh on `/settings` returns 404. Real files (JS, CSS, `.wasm`) are still served as-is. |
| Node version | Angular CLI 22.2 requires Node `^22.22.3 \|\| ^24.15.0 \|\| >=26`. Render's documented default for new services is 24.14.1 in one doc and 24.21.0 in another. | **Must pin.** Add `.node-version` containing `24.22.0` (matches local). Render reads it, and CI uses the same file (`actions/setup-node` with `node-version-file: .node-version`). That gives one source of truth. |
| devDependencies | Render sets `NODE_ENV=production` only at **runtime**, not at build | `@angular/cli`, `@angular/build` and `typescript` install at build. Nothing extra is needed. |
| Dependency install | Render auto-runs `npm install` unless `SKIP_INSTALL_DEPS=true` | Set it, and run `npm ci` in the build script for a lockfile-exact, reproducible build. |
| Rust toolchain | **Not** in Render's preinstalled tools (Node, npm, curl, gcc, make, … but no `rustup`/`cargo`) | `scripts/render-build.sh` must install it (below). This is the only real extra work. |
| Output path | `dist/Fintech-dashboard/browser` with a capital **F**, from the project name | `staticPublishPath` must match exactly, because Render runs on case-sensitive Linux. |
| Blueprint usage | `render.yaml` only applies when the service is created through **New → Blueprint** | Create it that way. The GitHub account is already connected to Render. The service name is auto-generated from `name:`, which is fine. |
| Bundle budget | Current initial bundle is 217 kB raw / 60 kB transfer, below the 500 kB warning | No action. Keep it in mind when adding libraries (`decimal.js` adds ~12 kB gzipped, and is loaded in the worker and the main-thread formatter). |

**`scripts/render-build.sh` (planned):**
```bash
#!/usr/bin/env bash
set -euo pipefail
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
fi
source "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown
npm ci
npm run build:wasm
npx ng build --configuration production
```
A minimal rustup install adds about 30–60 s per build. The `.wasm` compile adds a few seconds. **This is verified in the Phase 7 spike.** If it proves unreliable, the fallbacks are in §10.5.

**Notes:**
- `base href` is `/`, so no sub-path tricks are needed. The `routes` rewrite handles deep links natively, so no `404.html` hack is needed.
- The `.wasm` file name is stable because it lives in `public/`, so it gets a short `max-age`. Content-hashing it is a possible improvement (§16).
- Because Render serves custom headers, `COOP`/`COEP` can be enabled later for `SharedArrayBuffer` (§16).

### 10.3 GitHub Actions CI (`.github/workflows/ci.yml`)

Trigger: `push` to any branch and `pull_request` to `main`. Concurrency: `ci-${{ github.ref }}` with `cancel-in-progress: true`.

| Job | Steps | Purpose |
|---|---|---|
| `wasm` | checkout → `dtolnay/rust-toolchain@stable` (targets: `wasm32-unknown-unknown`, components: `rustfmt, clippy`) → `Swatinem/rust-cache` → `cargo fmt --check` → `cargo clippy -D warnings` → `cargo test` → `cargo build --release --target wasm32-unknown-unknown` → size check (< 50 kB) → upload the `market_gen.wasm` artifact | Rust quality gate. Produces the binary once. |
| `web` (needs `wasm`) | checkout → `actions/setup-node` (`node-version-file: .node-version`, `cache: npm`) → `npm ci` → download the wasm artifact into `public/wasm/` → `npm run lint` → `ng test --watch=false --coverage` (includes the wasm contract test) → `ng build` → upload the `dist` and coverage artifacts | Angular quality gate and production build check, including budgets. |
| `audit` (non-blocking) | `npm audit --audit-level=high`, `cargo audit` | Supply-chain visibility. |

Branch protection on `main`: require the `wasm` and `web` checks, require a PR for changes (direct pushes allowed for the owner during the interview) and use linear history. Because Render's `autoDeployTrigger` is `checksPass`, **a red pipeline never reaches production**.

### 10.4 Pipeline roadmap (delivers task §5 "Submission and deployment")

| Step | Deliverable | Satisfies | Verify |
|---|---|---|---|
| R1 | Repository `Romanakiko/Fintech-dashboard`, branch `main`, incremental conventional commits per phase (§13) | 5.1 "keep the development commit history" | `git log` shows phase commits |
| R2 | `ci.yml` with the `wasm` and `web` jobs | 5.1 tests runnable, 5.2 build automation | A PR shows two green checks |
| R3 | `render.yaml` Blueprint plus `scripts/render-build.sh`. Render dashboard: **New → Blueprint** → connect the GitHub repo | 5.2 hosting connected to the repository | The first deploy is live at `https://fintech-dashboard.onrender.com` (or similar) |
| R4 | `autoDeployTrigger: checksPass` confirmed | 5.2 "each push … automatically build and redeploy" with no manual steps | Push a visible change (e.g. a footer version label) and it appears live without touching Render |
| R5 | Build metadata: inject the commit SHA and build time into the footer (`RENDER_GIT_COMMIT` env var at build) | Makes "is the live demo up to date?" checkable during the interview | The footer SHA matches `git rev-parse --short HEAD` |
| R6 | Branch protection plus required checks | Fintech change-control hygiene | A failing test blocks the merge and the deploy |
| R7 | README: live demo link, CI badge, local setup, architecture summary and link to `spec.md` | 5.1 README, 5.3 links | Links work from a logged-out browser |
| R8 | Rehearsal: change → push → live in under ~5 min | 5.4 "changes pushed during the interview are reflected" | Timed dry run |

### 10.5 Fallback deployment path

If installing Rust inside Render's build is slow or unreliable, CI becomes the **only** builder:
- **Option A (recommended fallback):** commit the release `.wasm` produced by CI to a `wasm-dist` location that Render's build copies, so Render needs only Node. The downside is a binary in git, mitigated by keeping it under 50 kB with the CI size check.
- **Option B:** the `web` job runs `curl "$RENDER_DEPLOY_HOOK_URL"` (a repository secret) after the build, with `autoDeployTrigger: off`. Render still builds, but deploys happen only after CI passes, with the trigger owned by CI.
- **Option C:** pick a Wasm toolchain that installs from npm (AssemblyScript, §12.1). Then Render needs only Node.

---

## 11. Repository layout

```
Fintech-dashboard/
├─ .github/workflows/ci.yml
├─ render.yaml             (Render Blueprint: static site, headers, rewrites)
├─ .node-version           (24.22.0, read by Render and CI)
├─ wasm/market-gen/
│  ├─ Cargo.toml
│  └─ src/{lib.rs, rng.rs, model.rs, generator.rs}   (+ #[cfg(test)] modules)
├─ scripts/{copy-wasm.mjs, render-build.sh}
├─ public/wasm/            (build output, git-ignored)
├─ src/app/
│  ├─ core/                (framework-free, shared by worker + UI)
│  │  ├─ settings.ts       defaults, limits, validateSettings()
│  │  ├─ protocol.ts       commands/events, type guards
│  │  ├─ money.ts          decimal.js wrapper: vwapCents(), centsToDecimal(), formatMoney()
│  │  ├─ metrics.ts        spread(), vwap(), imbalance()
│  │  ├─ aggregator.ts     MarketAggregator
│  │  ├─ symbols.ts
│  │  └─ format.ts
│  ├─ producer/
│  │  ├─ worker/{market.worker.ts, producer-engine.ts, wasm-market-generator.ts, scheduler.ts}
│  │  ├─ producer-worker.factory.ts
│  │  └─ market-producer.client.ts
│  ├─ state/{market.store.ts, settings.store.ts}
│  ├─ features/
│  │  ├─ dashboard/{dashboard.page.ts, market-table.ts, producer-controls.ts}
│  │  └─ settings/{settings.page.ts}
│  ├─ layout/{producer-status.ts, error-banner.ts}
│  ├─ app.ts, app.routes.ts, app.config.ts
├─ tsconfig.worker.json
├─ spec.md, README.md
```

---

## 12. Architecture decision records

| ADR | Decision | Alternatives | Why |
|---|---|---|---|
| ADR-1 | **Rust** for Wasm (pending confirmation, see §12.1) | AssemblyScript, C, C++/Emscripten, Zig, TinyGo, Kotlin/Wasm, .NET | Memory safety, first-class `wasm32` target, `cargo test`, tiny binaries. It is the industry standard for Wasm and a strong signal for a senior role. |
| ADR-2 | Aggregation in **TS inside the worker** | Aggregation in Rust | Keeps Wasm focused on generation (as the task frames it). Metrics are tested in the same toolchain as the UI. Off the main thread either way. Moving it to Rust is a contained future change (§16). |
| ADR-3 | **Raw C ABI**, no wasm-bindgen | wasm-bindgen / wasm-pack | No generated JS glue to bundle in the worker. Zero-copy typed-array views of a fixed layout. Explicit ABI versioning. Trade-off: hand-written adapter, which is small and tested. |
| ADR-4 | **Conflation + ack** backpressure | Fixed-rate throttle, post every batch | The UI never builds a backlog and always shows the latest state. Totals are never lost because the aggregation is cumulative in the worker. |
| ADR-5 | **runId fencing owned by main thread** | Terminate and recreate the worker per run | Reusing the worker avoids a Wasm re-download/compile per Apply. Fencing guarantees isolation even with in-flight messages. |
| ADR-6 | Single **root-scoped** producer client, eager initializer | Producer in a component | Survives navigation. It is created exactly once (FR-N2). |
| ADR-7 | **Signal Forms** for settings | Reactive Forms | Angular 22 stable API, signal-native and schema-validated (project guideline). |
| ADR-8 | **Render Static Site** via `render.yaml`, auto-deploy on `checksPass`. GitHub Actions is the CI gate. | GitHub Pages, Cloudflare Pages, Vercel | Owner's choice. Real HTTP headers (CSP, HSTS, future COOP/COEP), SPA rewrites, infrastructure as code, deploys gated on green CI, CDN. Trade-off: Render builds from source, so it needs the Rust toolchain (§10.2, fallback §10.5). |
| ADR-9 | **Hybrid money model:** integers on the hot path (per-batch BigInt carry for notional), **decimal.js** (private `Decimal.clone`, precision 40) for VWAP division and display rounding (`ROUND_HALF_EVEN`), and decimal strings across the thread boundary | Plain Number. All-BigInt with hand-written rounding. big.js. A decimal library or Dinero.js on every update. | Exact where exactness is free, explicit rounding policy where it isn't, no per-update allocation, and the de-facto standard decimal library (owner's choice) behind a one-file seam (§5.6). |

### 12.1 Wasm language options

The task lets the candidate choose the language. The generator is small: a PRNG, integer state per instrument and a buffer writer. So the deciding factors are **toolchain friction (local, CI, Render)**, **binary size**, **testability** and **what the choice signals**.

| Language / toolchain | Binary size (this generator) | Toolchain install | Testing | JS interop | Strengths | Weaknesses | Verdict |
|---|---|---|---|---|---|---|---|
| **Rust** (`wasm32-unknown-unknown`, raw ABI or wasm-bindgen) | ~10–30 kB | `rustup` (local, CI action, script on Render) | `cargo test`, `proptest`, `criterion` | Raw exports or wasm-bindgen | Memory safety, no GC, best-in-class Wasm tooling, widely used in fintech and infra, deterministic performance | Biggest learning curve. Needs Rust on Render. | **Recommended** (strongest engineering signal) |
| **AssemblyScript** | ~5–15 kB | `npm i -D assemblyscript`, nothing else | `as-pect` or Vitest against the compiled module | Generated ESM bindings | TypeScript-like syntax, readable by frontend reviewers, **pure npm toolchain** (trivial on CI and Render), fast compile | Smaller ecosystem. Subset of TS semantics (no closures or unions). Less of a senior signal. | **Recommended low-friction alternative** |
| **C** (clang `--target=wasm32` / WASI-SDK, no Emscripten) | ~2–10 kB | LLVM/clang or WASI-SDK | Native unit tests (e.g. Unity, cmocka) built for the host | Raw exports | Smallest binaries, total control, no runtime | Manual memory safety. More build plumbing. | Viable, minimalist |
| **C++ / Emscripten** | ~20–100 kB (+ JS glue) | `emsdk` (large) | GoogleTest natively | Embind | Mature, huge ecosystem, strong in trading systems (C++ is common in HFT) | Heavy SDK. JS glue complicates module workers. Larger output. | Viable, heavier |
| **Zig** | ~2–10 kB | Single binary download | `zig test` built in | Raw exports | Tiny output, simple cross-compilation, built-in tests, explicit allocators | Pre-1.0 language, API churn, smaller hiring pool | Interesting, modern |
| **Go (TinyGo)** | ~20–60 kB | TinyGo + LLVM | `go test` (host) | `syscall/js` or raw exports | Simple language, good tests | GC in Wasm, larger binaries, `syscall/js` overhead. Standard Go output is MBs. | Possible, not ideal |
| **Kotlin/Wasm** | ~100 kB+ | Gradle + Kotlin | JUnit/kotlin.test | Generated JS | JVM-familiar teams | Requires WasmGC, heavy build, large output | Not recommended here |
| **C# / .NET (Blazor/WASI)** | MBs (runtime) | .NET SDK | xUnit | JSImport/JSExport | Enterprise familiarity | Ships a runtime. Startup cost. Overkill for a worker generator. | Not recommended |

**Recommendation:** **Rust** as the primary choice (ADR-1). If Render build friction or delivery time becomes the constraint, **AssemblyScript** is the pragmatic alternative: the worker ABI (§5.1) and every layer above it stay the same, so only `wasm/market-gen` changes. With either choice, the generator sits behind the `MarketGenerator` port, so the TS side does not depend on the language.

---

## 13. Step-by-step delivery plan

Each step ends with a verifiable check and a commit, which keeps the development history meaningful.

### Phase 0 — Foundations (½ day)
1. **Toolchain.** Install `rustup`, the `stable` toolchain and `rustup target add wasm32-unknown-unknown`. → *verify:* `cargo --version`, `rustup target list --installed`.
2. **Workflow.** Work on the single `main` branch with small conventional commits per step (feature branches and PRs are optional once branch protection is on in Phase 7). → *verify:* `git log` is readable.
3. **Quality gates.** Add `angular-eslint`, confirm strict TS options in `tsconfig.json` (`strict: true`) and add a `lint` script. → *verify:* `npm run lint` passes on the scaffold.
3a. **Pin Node.** Add `.node-version` with `24.22.0`. Angular 22 rejects Render's possible default 24.14.1 (§10.2). → *verify:* `node -v` matches locally, and CI picks it up.
3b. **Early CI skeleton.** Add `.github/workflows/ci.yml` with the `web` job only (lint, test, build) so every later commit is gated from day one. → *verify:* a green check on GitHub.
4. **Commit** `chore: tooling, lint and CI skeleton`.

### Phase 1 — Wasm generator (1 day)
5. Scaffold `wasm/market-gen` (lib, `crate-type = ["cdylib", "rlib"]`, release profile). → *verify:* `cargo build --target wasm32-unknown-unknown --release`.
6. Implement `rng.rs` (PCG32), with a test for known output for seed X. → *verify:* `cargo test rng`.
7. Implement `model.rs` + `generator.rs` (pure Rust) with tests for batch size, invariants over many seeds, determinism, evolution bounds, state persistence and argument validation. → *verify:* `cargo test` is green and `clippy -D warnings` is clean.
8. Implement the `lib.rs` C ABI (`abi_version`, `init`, `generate`, `update_stride`, error codes). → *verify:* the wasm builds and is < 50 kB.
9. Add `scripts/copy-wasm.mjs` and the npm scripts `build:wasm`, `prestart` and `prebuild`. Git-ignore `public/wasm/`. → *verify:* `npm run build:wasm` produces `public/wasm/market_gen.wasm`.
10. Write the Vitest **contract test** that loads the built `.wasm` and validates the ABI and invariants. → *verify:* `npm test`.
11. **Commit** `feat(wasm): seeded market update generator`.

### Phase 2 — Domain core (½ day)
12. `core/settings.ts`: types, defaults, limits and `validateSettings`, with tests (boundaries, non-integers, NaN).
12a. `npm i decimal.js` (ships its own types). `core/money.ts` (the only module that imports `decimal.js`): `vwapCents(notional: bigint, volume: number): string | null`, `centsToDecimal`, `formatMoney`, all with `ROUND_HALF_EVEN`. Tests cover half-even ties, null handling and string formatting. Add a Vitest `bench` comparing the integer hot path with `decimal.js` per update, and record the result for the README.
13. `core/metrics.ts`: `spread`, `vwap` (delegates to `money.ts`), `imbalance`, with "unavailable" on zero denominators. Tests cover the worked example and zero denominators.
14. `core/aggregator.ts`: `ingest(view, n)`, `snapshot()`, `reset(count)` with BigInt carry. Tests cover the worked example via a hand-built `Uint32Array`, isolation between instruments, initial state, exactness at large magnitudes and reset.
15. `core/format.ts` + `core/symbols.ts`, with tests.
16. `core/protocol.ts` with type guards and tests for rejecting malformed commands.
17. **Commit** `feat(core): metrics, aggregator, settings validation`.

### Phase 3 — Worker and engine (1 day)
18. Add `tsconfig.worker.json` (`lib: ["es2022","webworker"]`) and register it in `angular.json` (the `ng g web-worker` approach).
19. `scheduler.ts` (drift-compensated, injectable clock) with tests using fake timers.
20. `producer-engine.ts` with ports (`MarketGenerator`, `Scheduler`, `EventSink`). Tests cover start, tick, pause, resume without back-fill, start while paused, reset on start, conflation/ack, errors and late ticks.
21. `wasm-market-generator.ts` adapter: load with streaming fallback, ABI checks, view refresh on memory growth and error mapping.
22. `market.worker.ts` entry: routing and validation.
23. **Commit** `feat(worker): producer engine with conflation and run fencing`.

### Phase 4 — Main-thread integration (½ day)
24. `ProducerWorkerFactory` token and `MarketProducerClient` (single worker, `DestroyRef` cleanup, retry).
25. `MarketStore` (runId fencing, rAF coalescing, ack, pause/resume/startRun) with tests: stale snapshot rejection, reset on startRun, pause/resume, coalescing.
26. `SettingsStore` (applied settings, apply → startRun) with tests.
27. Wire up `provideAppInitializer` (create the client, start the run on `ready`) and confirm zoneless change detection is configured.
28. **Commit** `feat(state): market and settings stores`.

### Phase 5 — UI (1 day)
29. Routes: lazy `loadComponent` for `dashboard` and `settings`, a `''` redirect, a `**` fallback and page titles.
30. App shell: header, nav, skip link, status component, error banner and focus management on navigation.
31. Dashboard: `ProducerControls` and `MarketTable`, responsive layout (horizontal scroll container for the table on narrow screens), tabular numbers and reduced-motion-safe tick flash.
32. Settings page with Signal Forms: integer, min/max and required validation; Apply; Reset to defaults; live confirmation. Tests for validation, the "editing has no effect" rule and Apply behaviour.
33. Component tests with axe-core, plus a navigation test that checks the worker factory was called once and state is preserved.
34. Design tokens (CSS custom properties), light/dark themes and an AA contrast check.
35. **Commit** `feat(ui): dashboard and settings pages`.

### Phase 6 — Hardening (½ day)
36. Manual perf check at 50 instruments × 1000 per 50 ms: Chrome Performance panel, no long tasks from the data path, stable memory.
37. Error paths: rename the wasm file locally to get the fetch error, corrupt the bytes to get the compile error. Both should show the banner, and Retry should recover.
38. Verify the CSP locally: serve `dist/` with the same headers as `render.yaml` (e.g. a tiny static server script) and confirm that Wasm (`'wasm-unsafe-eval'`) and the worker (`worker-src 'self'`) load with no console violations.
39. Lighthouse accessibility check (target 100) and a keyboard-only walkthrough.
40. **Commit** `chore: hardening, csp, a11y fixes`.

### Phase 7 — CI/CD on GitHub and hosting on Render (½–1 day), following the pipeline roadmap in §10.4
41. Extend `ci.yml` to the full `wasm` → `web` (+ `audit`) pipeline from §10.3, with the wasm artifact handed between jobs and a size check. → *verify:* green checks on push.
42. **Render spike:** write `scripts/render-build.sh` (with rustup detection and install) and `render.yaml` (Static Site, `staticPublishPath: dist/Fintech-dashboard/browser`, `SKIP_INSTALL_DEPS`, SPA rewrite, headers). In Render: **New → Blueprint** → select the repo. Do not use "Web Service": no server is needed (§10.2). → *verify:* the first deploy succeeds and the build log shows the Rust target installed. If it fails or is too slow, switch to §10.5 Option A or B.
43. Set `autoDeployTrigger: checksPass` and confirm Render waits for the GitHub checks. → *verify:* a commit with a failing test is **not** deployed, and a green one is.
44. Check the headers on the live site (`curl -I`, securityheaders.com) and the deep link `/settings` (rewrite). → *verify:* CSP, HSTS and nosniff are present, and the deep link loads the app.
45. Show build metadata (commit SHA from `RENDER_GIT_COMMIT`, build time) in the footer. → *verify:* it matches `git rev-parse --short HEAD`.
46. Turn on branch protection for `main` with the required checks `wasm` and `web`.
47. Write the README: overview, live demo link, CI badge, architecture summary, prerequisites (Node 24, Rust stable + wasm target), `npm ci`, `npm start`, `npm test`, `npm run test:wasm`, `npm run ci`, how deploys work (Render + checks) and a link to this spec.
48. Make a visible change, push it and confirm that it goes live with no manual action. → *verify:* timed end to end.
49. **Commits** `ci: full pipeline`, `chore(deploy): render blueprint`, `docs: README`.

### Phase 8 — Interview readiness
50. Prepare a 5-minute architecture walkthrough using §4, §5.6, §12 and the trade-offs.
51. Rehearse likely extension requests (see §16): add a column, change a formula, add an instrument filter, move aggregation into Rust, add a chart. Make sure each one is a small, local change.

**Estimated total: ~5–6 working days.**

---

## 14. Requirements traceability matrix

| Requirement (task) | Spec | Implementation | Tests |
|---|---|---|---|
| Table with 5 metrics | FR-D1/2 | `MarketTableComponent`, `metrics.ts` | metrics.spec, market-table.spec |
| Cumulative volume and VWAP, every trade counted once | FR-D2, NFR-2 | `MarketAggregator` | aggregator.spec |
| Unavailable before data and on zero denominators | FR-D3/4 | `metrics.ts`, `format.ts` | metrics.spec, format.spec |
| Currency and imbalance formats | FR-D5 | `format.ts` | format.spec |
| Pause/Resume without back-fill | FR-D6 | `ProducerEngine` | producer-engine.spec, market.store.spec |
| Producer status | FR-D7 | `ProducerStatusComponent` | component spec |
| Validated integer settings with ranges | FR-S1/4 | Settings page, `validateSettings` | settings.spec |
| Editing doesn't affect producer, Apply resets and starts | FR-S2/3 | `SettingsStore`, `MarketStore.startRun` | settings.page.spec, market.store.spec |
| Navigation preserves the run, single producer | FR-N2 | Root `MarketProducerClient` | navigation.spec |
| Old run results rejected | FR-S3, ADR-5 | runId fencing | market.store.spec, producer-engine.spec |
| Wasm generates updates with state, evolution and invariants | FR-P1–P5 | `wasm/market-gen` | cargo tests, wasm contract test |
| Worker hosts Wasm | FR-P6 | `market.worker.ts` | engine spec, manual |
| Init errors and cleanup | FR-P7/8 | adapter error mapping, `DestroyRef`, retry | client spec, engine spec |
| UI usable at high rate | NFR-1 | conflation, rAF, zero-copy | engine spec, manual perf |
| Integer cents, rounding only for display | NFR-2, ADR-9 | Integer hot path, `core/money.ts` (decimal.js, half-even) | money.spec, aggregator.spec |
| Auto deploy on every push | NFR-9, §10.4 | GitHub Actions CI + Render `checksPass` | pipeline run, R4/R8 rehearsal |

---

## 15. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Rust toolchain not installed locally or in CI | Build blocked | Phase 0 install. CI uses `dtolnay/rust-toolchain`. README prerequisites. |
| Rust unavailable or slow in Render's build image | Deploy blocked or slow | `render-build.sh` installs a minimal toolchain. Early spike (step 42). Fallbacks in §10.5. |
| Render free tier limits (build minutes, bandwidth) | Deploy delays | A static site has no spin-down. Keep builds lean (minimal rustup profile, npm cache). Monitor usage. |
| Decimal library cost on the hot path | Jank at high rate | Library used only per snapshot (§5.6). The benchmark proves the budget. |
| Angular worker bundling of shared `core/` code | Build errors | Keep `core/` free of Angular imports. Use a dedicated `tsconfig.worker.json`. |
| SPA deep links 404 on the host | Broken refresh on `/settings` | Render `routes` rewrite `/* → /index.html`. The wasm URL is resolved against `document.baseURI`. |
| Signal Forms API differences between minor versions | Rework | Pin the Angular version. Verify the API against the current docs before implementation. |
| A detached Wasm memory view after growth | Silent corruption or crash | Pre-allocate at `init`. Re-create the view when `memory.buffer` identity changes. Cover this with a test. |
| Floating-point drift in VWAP | Wrong numbers | Exact integer/BigInt notional. Divide only at snapshot time. |

---

## 16. Future development proposals

**Product / domain**
1. **Price charts:** a per-instrument sparkline (last N conflated points in a ring buffer) and a detail view with candles (OHLC per interval), rendered on Canvas/WebGL for throughput.
2. **Richer market model:** multi-level order book (L2 depth ladder), regime switching (volatility bursts), correlated instruments and trading-halt simulation.
3. **More metrics:** rolling-window VWAP/volume (1 m, 5 m) through time-bucketed ring buffers, realised volatility, mid-price, micro-price, trade count, high/low and % change since run start.
4. **Real data adapter:** use the same `ProducerEvent` protocol with a WebSocket (or SSE) source from a real feed. The generator becomes one implementation of a `MarketSource` port.
5. **Replay and audit:** seed and settings are recorded per run, so any run can be replayed deterministically. Export snapshots or events to CSV/Parquet.
6. **Watchlists, sorting, filtering and column customisation**, persisted per user.
7. **Alerts:** threshold rules on metrics (e.g. OBI > 0.6), evaluated in the worker, with notifications.

**Engineering / scale**
8. **Aggregation in Rust:** move `MarketAggregator` into Wasm with `u128` notional so the worker posts only snapshots. Benchmark both approaches.
9. **SharedArrayBuffer + Atomics** snapshot ring for lock-free, zero-copy UI reads. It needs the `COOP: same-origin` and `COEP: require-corp` headers, which can be added to `render.yaml` directly.
10. **Virtualized table** (CDK virtual scroll) for thousands of instruments. A **Canvas grid** for extreme update rates.
11. **Multi-worker sharding** by instrument partition for very large universes.
12. **Persistence:** settings and layout in `localStorage`/IndexedDB, optionally synced to a backend.
13. **Observability:** OpenTelemetry web traces, Sentry error reporting, a Web Vitals dashboard, and producer metrics (gen time, late ticks) exported.
14. **Quality:** Playwright e2e plus visual regression, Rust property-based tests (`proptest`), mutation testing (Stryker), Wasm benchmarks (`criterion`) in CI with regression thresholds, and bundle-size budget checks per PR.
15. **Security and compliance:** Trusted Types (`require-trusted-types-for 'script'` in the CSP), CSP violation reporting (`report-to`), SRI, Dependabot/Renovate, SBOM generation, `cargo deny`, signed commits and releases, and a content-hashed `.wasm` with `immutable` caching.
16. **i18n and accessibility:** Angular i18n for multiple locales, plus a screen-reader "summary mode" that announces selected instruments on demand.
17. **Platform:** PWA/offline shell, **Render PR preview environments** (`pullRequestPreviewsEnabled: true`) so reviewers get a URL per PR, a staging and production pair of Render services (a `staging` branch, then promotion to `main`), and an Nx monorepo if more apps or libraries are added (shared `core` as a library).
18. **Multi-currency money:** if instruments get different currencies or exponents (JPY has 0 decimals, crypto has 8+), adopt **Dinero.js v2** (`dinero.js/bigint`) as the `Money` value object behind `core/money.ts`. Currency-aware scale, allocation and formatting come with it. When the TC39 `Decimal` proposal ships in browsers, replace `decimal.js` with the native type.
19. **Backend evolution on Render:** a Render Web Service (Node/Rust) streaming real or simulated data over WebSocket, Render Key Value (Redis-compatible) for the latest snapshots, Render Postgres for run history and audit, and Render Cron Jobs for end-of-day reports. All of it goes in the same `render.yaml` Blueprint.

---

## 17. Open questions

Resolved:
- ~~Wasm language~~: **Rust** confirmed (ADR-1). It still needs installing locally (Phase 0).
- ~~Apply button enablement~~: **always enabled when the form is valid.** Re-applying the same settings starts a fresh run (FR-S3).
- ~~Render account~~: GitHub is already connected to Render. The default service name and `onrender.com` URL are fine.
- ~~Server needed for deployment?~~: **No.** It is a pure static client-side build, deployed as a Static Site. The extra work is limited to `.node-version`, `render.yaml` (rewrite and publish path) and the Rust install in `render-build.sh` (§10.2).

- ~~Money library~~: **decimal.js** (owner's choice), used only at the boundary (§5.6).
