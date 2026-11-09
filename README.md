# Realtime Fintech Dashboard

[![CI](https://github.com/Romanakiko/Fintech-dashboard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Romanakiko/Fintech-dashboard/actions/workflows/ci.yml)

A browser-only, real-time market data dashboard. A simulated market data producer, written in Rust and compiled to WebAssembly, runs in a Web Worker and generates up to 20,000 updates per second. The worker aggregates the stream into per-instrument metrics, and an Angular 22 UI shows them in a live table.

- **Live demo:** <https://fintech-dashboard.onrender.com>. The footer shows the commit the page was built from.
- **Specification:** [spec.md](spec.md) covers the requirements, architecture, decisions (ADRs), delivery plan and future work.

## Features

- A live table per instrument: last price, bid–ask spread, cumulative volume, VWAP and order-book imbalance. Values that are not available yet, or have a zero denominator, show as `—`.
- Pause and Resume. Resume keeps all totals and does not back-fill the paused time.
- Producer status in the header: state and run number. The dashboard also shows the run settings, total updates and effective rate.
- A settings page (instrument count, updates per batch, batch interval) with inline validation. **Apply** starts a new run from zero, even when paused.
- Initialization errors (download, compile, version mismatch) are explained in a banner with **Retry**.

## Architecture

```
Main thread (Angular 22, zoneless, signals)          Web Worker
┌──────────────────────────────┐                     ┌─────────────────────────────────────┐
│ Dashboard and Settings pages │                     │ message router and validation       │
│        ▲ signals             │  commands           │ ProducerEngine (timer, conflation)  │
│ MarketStore (run, settings)  │ ──────────────────► │   ├─ market_gen.wasm (Rust): PRNG,  │
│        ▲ one commit per frame│  snapshots          │   │  per-instrument price model     │
│ MarketProducerClient         │ ◄────────────────── │   └─ MarketAggregator: exact totals │
└──────────────────────────────┘                     └─────────────────────────────────────┘
```

- **Work happens off the main thread.** Wasm generates the updates and the worker aggregates them. The main thread only renders snapshots. The aggregator reads each batch from Wasm memory through a typed-array view and copies nothing.
- **Backpressure by conflation.** The worker posts at most one snapshot until the UI acknowledges it, and the UI commits at most one per animation frame. A slow screen never builds a backlog, and no trade is lost, because the totals are cumulative.
- **Run fencing.** The main thread owns a `runId` counter, and every message carries it. Apply starts a new run, and late results from the old run are dropped.
- **Exact money.** Prices are integer cents and the VWAP numerator is an exact `BigInt`. The one division (VWAP) uses `decimal.js` and is rounded once, half-even, for display.
- **One producer per app.** A root-scoped client owns the single worker, so navigation never creates another one.

The reasoning behind each choice is in the spec: architecture (§4), components (§5), money and precision (§5.6) and the ADRs (§12).

## Getting started

**Prerequisites**

- Node.js **24.22.0** (pinned in [`.node-version`](.node-version); Angular 22 needs `^22.22.3 || ^24.15.0 || >=26`).
- Rust stable with the Wasm target: install [rustup](https://rustup.rs), then `rustup target add wasm32-unknown-unknown`.

**Run it**

```bash
npm ci
npm start          # http://localhost:4200
```

`npm start`, `npm run build` and `npm test` compile the Wasm module first (npm `pre*` hooks), so each needs Rust. Calling `ng` directly skips that step.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Development server. |
| `npm test` | Angular unit tests (Vitest), including the contract test against the compiled `.wasm`. |
| `npm run test:wasm` | Rust unit tests (`cargo test`). |
| `npm run lint` | ESLint, plus type checks of the worker and spec code. |
| `npm run lint:wasm` | `cargo fmt --check` and `cargo clippy -D warnings`. |
| `npm run build` | Production build into `dist/Fintech-dashboard/browser`. Fails if the Wasm exceeds 50 kB. |
| `npm run ci` | All lints, both test suites and the build: the same gates as CI. |
| `npm run serve:dist` | Serves the last build with the routes and headers from `render.yaml` at <http://127.0.0.1:4300>. |
| `npm run check:csp` | Builds, then loads the app in headless Chrome under the production headers. Fails on any CSP violation or console error. Needs Chrome (`CHROME_PATH` overrides). |
| `npm run bench` | The money benchmark: integer hot path against `decimal.js`. |

## Deployment

```
git push ──► GitHub Actions: wasm · web · audit ──► all checks pass ──► Render builds and deploys
```

- **CI** ([`ci.yml`](.github/workflows/ci.yml)) runs on every push and on pull requests to `main`:
  - `wasm`: format, Clippy and Rust tests.
  - `web`: lint, unit tests and the production build. It compiles the Wasm the same way Render does.
  - `audit`: `npm audit` and `cargo audit`. Findings show as a warning on the run and never block a deploy.
- **Hosting** is a Render **Static Site**, defined as code in [`render.yaml`](render.yaml): the SPA rewrite for deep links, security headers (CSP, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`) and caching rules. There is no server.
- **Deploys are gated on CI.** `autoDeployTrigger: checksPass` makes Render build `main` only after every GitHub check on the commit passes, so a red pipeline never reaches production.
- **The Render build** ([`scripts/render-build.sh`](scripts/render-build.sh)) installs a minimal Rust toolchain, because Render's image has none. It then runs `npm ci`, builds the Wasm and the app, and stamps the commit and build time into the footer.

To deploy your own copy: in Render, choose **New → Blueprint** and select the repository. Render reads `render.yaml`. Don't use "Web Service", because there is no server.

## Quality

- **Tests.** The Rust tests check the generator's invariants over many seeds, its determinism and its argument validation. A contract test loads the compiled `.wasm` and checks its ABI. The Vitest suite covers the metrics, money rounding, the aggregator, the worker engine (with a fake clock and scheduler), the store, the components and navigation. An integration test runs the store against the real engine and Wasm and checks that every generated trade is counted.
- **Accessibility.** The target is WCAG 2.2 AA. Component tests run axe-core, and a test checks the contrast of the colour tokens for text, control borders and the focus ring in both themes. The Lighthouse accessibility score is 100 on both pages, and a keyboard-only walkthrough was done ([spec §8](spec.md#8-cross-cutting-concerns)).
- **Performance.** Measured on a production build at the maximum rate (50 instruments × 1,000 updates every 50 ms), the app sustained about 20,000 updates/s with no long tasks, 60 fps and flat memory.
- **Security.** The CSP allows no inline scripts. `npm run check:csp` verifies the policy in a real browser, including the worker and the Wasm compile.
- **Money benchmark** (`npm run bench`). The first two rows aggregate one maximum-size batch of 1,000 updates. The third prepares one snapshot of 50 rows for display. At the maximum rate, each runs 20 times a second.

  | Path | Mean per run | Share of one core at 20 runs/s |
  |---|---|---|
  | Integer cents + `BigInt` carry, per batch (used) | 0.07 ms | 0.14 % |
  | `decimal.js` per update, per batch (not used) | 0.8–1.0 ms | ≈ 2 % |
  | `decimal.js` per snapshot: VWAP and formatting for 50 rows (used) | ≈ 0.75 ms | ≈ 1.5 % |

## Project layout

```
wasm/market-gen/          Rust generator (PRNG, price model, C ABI) and its tests
src/app/core/             Framework-free domain code shared by the worker and the UI
src/app/producer/         Worker entry, engine, Wasm adapter, and the main-thread client
src/app/state/            MarketStore: run, settings, rows, fencing, frame coalescing
src/app/features/         Dashboard and Settings pages (lazy-loaded)
src/app/layout/           Status badge, error banner, build info
scripts/                  Wasm copy, local production server, CSP check, Render build
render.yaml               Render Blueprint: static site, rewrite, headers
```
