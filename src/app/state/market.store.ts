import { Service, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type InstrumentTotals, MarketAggregator } from '../core/aggregator';
import { type InstrumentMetrics, computeMetrics } from '../core/metrics';
import type { ProducerEvent, ProducerStats, Seed } from '../core/protocol';
import { DEFAULT_SETTINGS, type ProducerSettings } from '../core/settings';
import { symbolOf } from '../core/symbols';
import { MarketProducerClient } from '../producer/market-producer.client';
import { REQUEST_FRAME } from './request-frame';

export type ProducerStatus = 'initializing' | 'running' | 'paused' | 'error';
export type ProducerFailure = Extract<ProducerEvent, { type: 'error' }>;
type Snapshot = Extract<ProducerEvent, { type: 'snapshot' }>;

export interface MarketRow extends InstrumentMetrics {
  readonly symbol: string;
}

const NO_STATS: ProducerStats = {
  totalUpdates: 0,
  batches: 0,
  lastBatchMs: 0,
  updatesPerSecond: 0,
  lateTicks: 0,
};

/** Totals of a run that has received no data yet. */
const emptyTotals = (instrumentCount: number): readonly InstrumentTotals[] =>
  new MarketAggregator(instrumentCount).snapshot();

function randomSeed(): Seed {
  const [lo, hi] = crypto.getRandomValues(new Uint32Array(2));
  return [lo, hi];
}

/**
 * The state of the active run, and the only owner of run ids.
 *
 * Every snapshot and status is checked against the current run id, so results of a
 * previous run cannot overwrite the new one. Snapshots are committed in an animation
 * frame and acknowledged from there, which ties the worker's publishing rate to what
 * the UI actually renders.
 */
@Service()
export class MarketStore {
  private readonly client = inject(MarketProducerClient);
  private readonly requestFrame = inject(REQUEST_FRAME);

  private readonly runIdState = signal(0);
  private readonly settingsState = signal(DEFAULT_SETTINGS);
  private readonly statusState = signal<ProducerStatus>('initializing');
  private readonly errorState = signal<ProducerFailure | null>(null);
  private readonly statsState = signal(NO_STATS);
  private readonly totals = signal(emptyTotals(DEFAULT_SETTINGS.instrumentCount));

  private pendingSnapshot: Snapshot | null = null;
  private frameRequested = false;

  readonly runId = this.runIdState.asReadonly();
  /** The settings of the active run. */
  readonly settings = this.settingsState.asReadonly();
  readonly status = this.statusState.asReadonly();
  readonly error = this.errorState.asReadonly();
  readonly stats = this.statsState.asReadonly();
  readonly rows = computed<readonly MarketRow[]>(() =>
    this.totals().map((totals, index) => ({ symbol: symbolOf(index), ...computeMetrics(totals) })),
  );

  constructor() {
    this.client.events.pipe(takeUntilDestroyed()).subscribe((event) => this.handle(event));
  }

  /** Starts the producer, or replaces a failed one (Retry). A run begins once it is ready. */
  connect(): void {
    this.statusState.set('initializing');
    this.errorState.set(null);
    this.client.connect();
  }

  /** Applies settings: clears the previous run at once and starts a new one, even if paused. */
  startRun(settings: ProducerSettings): void {
    const runId = this.runIdState() + 1;
    this.runIdState.set(runId);
    this.settingsState.set(settings);
    this.totals.set(emptyTotals(settings.instrumentCount));
    this.statsState.set(NO_STATS);
    this.errorState.set(null);
    this.pendingSnapshot = null;

    switch (this.statusState()) {
      case 'initializing':
        break; // Handled by 'ready', which starts the latest settings.
      case 'error':
        this.connect();
        break;
      default:
        this.statusState.set('running');
        this.client.send({ type: 'start', runId, settings, seed: randomSeed() });
    }
  }

  pause(): void {
    this.client.send({ type: 'pause', runId: this.runIdState() });
  }

  resume(): void {
    this.client.send({ type: 'resume', runId: this.runIdState() });
  }

  private handle(event: ProducerEvent): void {
    switch (event.type) {
      case 'ready':
        this.statusState.set('running');
        this.startRun(this.settingsState());
        break;
      case 'status':
        if (event.runId === this.runIdState()) {
          this.statusState.set(event.state);
        }
        break;
      case 'snapshot':
        if (event.runId === this.runIdState()) {
          this.queue(event);
        }
        break;
      case 'error':
        // Not fenced by run: a fatal error ends the worker, whichever run it hit.
        this.errorState.set(event);
        if (event.fatal) {
          this.statusState.set('error');
          this.pendingSnapshot = null;
        }
        break;
    }
  }

  private queue(snapshot: Snapshot): void {
    this.pendingSnapshot = snapshot;
    if (!this.frameRequested) {
      this.frameRequested = true;
      this.requestFrame(() => this.commit());
    }
  }

  private commit(): void {
    this.frameRequested = false;
    const snapshot = this.pendingSnapshot;
    if (snapshot === null) {
      return; // Discarded by a new run after the frame was requested.
    }
    this.pendingSnapshot = null;
    this.totals.set(snapshot.instruments);
    this.statsState.set(snapshot.stats);
    this.client.send({ type: 'ack', runId: snapshot.runId, seq: snapshot.seq });
  }
}
