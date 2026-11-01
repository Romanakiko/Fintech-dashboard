import { MarketAggregator } from '../../core/aggregator';
import type {
  ProducerCommand,
  ProducerErrorCode,
  ProducerEvent,
  ProducerStats,
  Seed,
} from '../../core/protocol';
import type { ProducerSettings } from '../../core/settings';

/** Port: the source of market updates (the Wasm module in production). */
export interface MarketGenerator {
  /** Starts a fresh stream for `instrumentCount` instruments and batches of up to `maxBatch`. */
  init(seed: Seed, instrumentCount: number, maxBatch: number): void;
  /** Returns `count` updates in the UPDATE_STRIDE layout, valid until the next call. */
  generate(count: number): Uint32Array;
}

/** Port: a repeating timer. */
export interface Scheduler {
  /**
   * Calls `tick` every `intervalMs`, the first time one interval from now, and replaces
   * any running schedule. `late` marks a tick that fell behind and was re-anchored.
   */
  start(intervalMs: number, tick: (late: boolean) => void): void;
  stop(): void;
}

export interface ProducerEngineDeps {
  readonly loadGenerator: (wasmUrl: string) => Promise<MarketGenerator>;
  readonly scheduler: Scheduler;
  readonly emit: (event: ProducerEvent) => void;
  readonly now: () => number;
}

/** An anticipated failure, reported to the main thread with its code. */
export class ProducerError extends Error {
  constructor(
    readonly code: ProducerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProducerError';
  }
}

const RATE_WINDOW_MS = 1000;

/** Everything that belongs to one run; a new run gets a new instance, which is the reset. */
class Run {
  readonly aggregator: MarketAggregator;
  paused = false;
  batches = 0;
  totalUpdates = 0;
  lateTicks = 0;
  lastBatchMs = 0;
  updatesPerSecond = 0;
  rateWindowStart = 0;
  rateWindowUpdates = 0;
  /** Seq of the last published snapshot. */
  publishedSeq = 0;
  /** True until the main thread acknowledges the last published snapshot. */
  awaitingAck = false;

  constructor(
    readonly id: number,
    readonly settings: ProducerSettings,
    readonly generator: MarketGenerator,
  ) {
    this.aggregator = new MarketAggregator(settings.instrumentCount);
  }

  stats(): ProducerStats {
    return {
      totalUpdates: this.totalUpdates,
      batches: this.batches,
      lastBatchMs: this.lastBatchMs,
      updatesPerSecond: this.updatesPerSecond,
      lateTicks: this.lateTicks,
    };
  }
}

/**
 * The worker-side producer: loads the generator once, runs one run at a time and
 * publishes conflated snapshots.
 *
 * Every batch is aggregated as soon as it is generated, but at most one snapshot is
 * unacknowledged at any time. Batches produced meanwhile are folded into the next
 * snapshot, which is published as soon as the ack arrives. A busy or hidden UI therefore
 * slows the snapshot rate, never generation, and no trade is lost from the totals.
 */
export class ProducerEngine {
  private loadRequested = false;
  /** Set once loaded; cleared for good by a fatal error. */
  private generator: MarketGenerator | null = null;
  private run: Run | null = null;

  constructor(private readonly deps: ProducerEngineDeps) {}

  async handle(command: ProducerCommand): Promise<void> {
    switch (command.type) {
      case 'load':
        await this.load(command.wasmUrl);
        break;
      case 'start':
        this.start(command.runId, command.settings, command.seed);
        break;
      case 'pause':
        this.pause(command.runId);
        break;
      case 'resume':
        this.resume(command.runId);
        break;
      case 'ack':
        this.ack(command.runId, command.seq);
        break;
    }
  }

  private async load(wasmUrl: string): Promise<void> {
    if (this.loadRequested) {
      return this.reject(null, 'The generator is already loaded');
    }
    this.loadRequested = true;
    try {
      this.generator = await this.deps.loadGenerator(wasmUrl);
    } catch (error) {
      return this.fail(null, error, 'WASM_COMPILE_FAILED');
    }
    this.deps.emit({ type: 'ready' });
  }

  /** Replaces any current run, paused or not, with a fresh one (Apply). */
  private start(runId: number, settings: ProducerSettings, seed: Seed): void {
    const generator = this.generator;
    if (generator === null) {
      return this.reject(runId, 'Cannot start a run before the generator is loaded');
    }
    this.deps.scheduler.stop();
    this.run = null;
    try {
      generator.init(seed, settings.instrumentCount, settings.updatesPerBatch);
    } catch (error) {
      return this.fail(runId, error, 'INIT_REJECTED');
    }
    const run = new Run(runId, settings, generator);
    this.run = run;
    this.schedule(run);
    this.deps.emit({ type: 'status', runId, state: 'running' });
  }

  private pause(runId: number): void {
    const run = this.currentRun(runId);
    if (run === null) {
      return;
    }
    if (!run.paused) {
      this.deps.scheduler.stop();
      run.paused = true;
    }
    this.deps.emit({ type: 'status', runId, state: 'paused' });
  }

  /** Continues on a fresh schedule: the paused interval is not back-filled. */
  private resume(runId: number): void {
    const run = this.currentRun(runId);
    if (run === null) {
      return;
    }
    if (run.paused) {
      run.paused = false;
      this.schedule(run);
    }
    this.deps.emit({ type: 'status', runId, state: 'running' });
  }

  private ack(runId: number, seq: number): void {
    const run = this.currentRun(runId);
    if (run === null || !run.awaitingAck || seq !== run.publishedSeq) {
      return;
    }
    run.awaitingAck = false;
    if (run.batches > run.publishedSeq) {
      this.publish(run);
    }
  }

  /** Run-scoped commands for any other run are stale and ignored. */
  private currentRun(runId: number): Run | null {
    return this.run?.id === runId ? this.run : null;
  }

  private schedule(run: Run): void {
    run.rateWindowStart = this.deps.now();
    run.rateWindowUpdates = 0;
    this.deps.scheduler.start(run.settings.batchIntervalMs, (late) => this.tick(run, late));
  }

  private tick(run: Run, late: boolean): void {
    const count = run.settings.updatesPerBatch;
    const startedAt = this.deps.now();
    try {
      run.aggregator.ingest(run.generator.generate(count), count);
    } catch (error) {
      return this.fail(run.id, error, 'GENERATION_FAILED');
    }
    run.lastBatchMs = this.deps.now() - startedAt;
    run.batches++;
    run.totalUpdates += count;
    if (late) {
      run.lateTicks++;
    }
    run.rateWindowUpdates += count;
    const elapsed = startedAt - run.rateWindowStart;
    if (elapsed >= RATE_WINDOW_MS) {
      run.updatesPerSecond = (run.rateWindowUpdates * 1000) / elapsed;
      run.rateWindowStart = startedAt;
      run.rateWindowUpdates = 0;
    }
    if (!run.awaitingAck) {
      this.publish(run);
    }
  }

  private publish(run: Run): void {
    run.publishedSeq = run.batches;
    run.awaitingAck = true;
    this.deps.emit({
      type: 'snapshot',
      runId: run.id,
      seq: run.publishedSeq,
      stats: run.stats(),
      instruments: run.aggregator.snapshot(),
    });
  }

  /** Stops everything; only a new worker can recover. */
  private fail(runId: number | null, error: unknown, fallback: ProducerErrorCode): void {
    this.deps.scheduler.stop();
    this.generator = null;
    this.run = null;
    this.deps.emit({
      type: 'error',
      runId,
      code: error instanceof ProducerError ? error.code : fallback,
      message: error instanceof Error ? error.message : String(error),
      fatal: true,
    });
  }

  private reject(runId: number | null, message: string): void {
    this.deps.emit({ type: 'error', runId, code: 'INVALID_COMMAND', message, fatal: false });
  }
}
