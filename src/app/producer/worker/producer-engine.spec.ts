import type { InstrumentTotals } from '../../core/aggregator';
import type { ProducerCommand, ProducerEvent, Seed } from '../../core/protocol';
import type { ProducerSettings } from '../../core/settings';
import { ManualScheduler } from '../../../testing/manual-scheduler';
import { encodeUpdates } from '../../../testing/market-updates';
import { type MarketGenerator, ProducerEngine, ProducerError } from './producer-engine';

type Snapshot = Extract<ProducerEvent, { type: 'snapshot' }>;

/** Every update trades 1 unit at 100 cents; instruments are visited round-robin. */
class FakeGenerator implements MarketGenerator {
  readonly inits: [Seed, number, number][] = [];
  failure: Error | null = null;
  generationMs = 0;
  private instrumentCount = 0;
  private next = 0;

  constructor(private readonly clock: { now: number }) {}

  init(seed: Seed, instrumentCount: number, maxBatch: number): void {
    this.inits.push([seed, instrumentCount, maxBatch]);
    this.instrumentCount = instrumentCount;
    this.next = 0;
  }

  generate(count: number): Uint32Array {
    if (this.failure) {
      throw this.failure;
    }
    this.clock.now += this.generationMs;
    return encodeUpdates(
      Array.from({ length: count }, () => ({
        instrument: this.next++ % this.instrumentCount,
        priceCents: 100,
        tradeQty: 1,
        bidCents: 99,
        askCents: 100,
        bidQty: 10,
        askQty: 30,
      })),
    );
  }
}

const SEED: Seed = [1, 2];
const SETTINGS: ProducerSettings = { instrumentCount: 2, updatesPerBatch: 4, batchIntervalMs: 500 };

/** Totals of an instrument that received `trades` fake updates. */
function totalsAfter(trades: number): InstrumentTotals {
  return {
    lastPriceCents: 100,
    bidCents: 99,
    askCents: 100,
    bidQty: 10,
    askQty: 30,
    volume: trades,
    notionalCents: BigInt(trades * 100),
  };
}

describe('ProducerEngine', () => {
  let clock: { now: number };
  let generator: FakeGenerator;
  let scheduler: ManualScheduler;
  let events: ProducerEvent[];
  let engine: ProducerEngine;

  function createEngine(loadGenerator = () => Promise.resolve<MarketGenerator>(generator)) {
    engine = new ProducerEngine({
      loadGenerator,
      scheduler,
      emit: (event) => events.push(event),
      now: () => clock.now,
    });
  }

  const send = (command: ProducerCommand) => engine.handle(command);
  const start = (runId: number, settings = SETTINGS) =>
    send({ type: 'start', runId, settings, seed: SEED });
  const snapshots = () => events.filter((event): event is Snapshot => event.type === 'snapshot');
  const lastSnapshot = () => snapshots().at(-1);

  async function loadAndClear(): Promise<void> {
    await send({ type: 'load', wasmUrl: 'market_gen.wasm' });
    events.length = 0;
  }

  beforeEach(() => {
    clock = { now: 0 };
    generator = new FakeGenerator(clock);
    scheduler = new ManualScheduler();
    events = [];
    createEngine();
  });

  describe('loading', () => {
    it('reports ready once the generator is loaded', async () => {
      await send({ type: 'load', wasmUrl: 'market_gen.wasm' });
      expect(events).toEqual([{ type: 'ready' }]);
    });

    it('reports a load failure as fatal, with the loader’s error code', async () => {
      createEngine(() => Promise.reject(new ProducerError('WASM_FETCH_FAILED', 'HTTP 404')));
      await send({ type: 'load', wasmUrl: 'market_gen.wasm' });
      await start(1);

      expect(events).toEqual([
        { type: 'error', runId: null, code: 'WASM_FETCH_FAILED', message: 'HTTP 404', fatal: true },
        expect.objectContaining({ type: 'error', runId: 1, code: 'INVALID_COMMAND', fatal: false }),
      ]);
      expect(scheduler.running).toBe(false);
    });

    it('rejects a start before the generator is loaded', async () => {
      await start(1);

      expect(events).toEqual([
        expect.objectContaining({ type: 'error', runId: 1, code: 'INVALID_COMMAND', fatal: false }),
      ]);
      expect(generator.inits).toEqual([]);
    });
  });

  describe('a run', () => {
    beforeEach(loadAndClear);

    it('initialises the generator and schedules batches without generating yet', async () => {
      await start(1);

      expect(generator.inits).toEqual([[SEED, 2, 4]]);
      expect(scheduler.intervalMs).toBe(500);
      expect(events).toEqual([{ type: 'status', runId: 1, state: 'running' }]);
    });

    it('aggregates each batch and publishes it as a snapshot', async () => {
      await start(1);
      scheduler.fire();

      expect(lastSnapshot()).toEqual({
        type: 'snapshot',
        runId: 1,
        seq: 1,
        stats: expect.objectContaining({ totalUpdates: 4, batches: 1 }),
        instruments: [totalsAfter(2), totalsAfter(2)],
      });
    });

    it('reports batch duration, late ticks and throughput', async () => {
      generator.generationMs = 2;
      await start(1);
      clock.now = 500;
      scheduler.fire();
      await send({ type: 'ack', runId: 1, seq: 1 });
      clock.now = 1000;
      scheduler.fire(true);

      // 8 updates in the first 1000 ms of the run.
      expect(lastSnapshot()?.stats).toEqual({
        totalUpdates: 8,
        batches: 2,
        lastBatchMs: 2,
        updatesPerSecond: 8,
        lateTicks: 1,
      });
    });
  });

  describe('conflation', () => {
    beforeEach(async () => {
      await loadAndClear();
      await start(1);
    });

    it('keeps one snapshot in flight and publishes the latest totals on ack', async () => {
      scheduler.fire();
      scheduler.fire();
      scheduler.fire();
      expect(snapshots().map((snapshot) => snapshot.seq)).toEqual([1]);

      await send({ type: 'ack', runId: 1, seq: 1 });
      expect(snapshots().map((snapshot) => snapshot.seq)).toEqual([1, 3]);
      expect(lastSnapshot()?.instruments).toEqual([totalsAfter(6), totalsAfter(6)]);
    });

    it('publishes nothing on ack without new batches, then the next batch at once', async () => {
      scheduler.fire();
      await send({ type: 'ack', runId: 1, seq: 1 });
      expect(snapshots()).toHaveLength(1);

      scheduler.fire();
      expect(snapshots().map((snapshot) => snapshot.seq)).toEqual([1, 2]);
    });

    it('ignores acks for another run or another snapshot', async () => {
      scheduler.fire();
      scheduler.fire();
      await send({ type: 'ack', runId: 2, seq: 1 });
      await send({ type: 'ack', runId: 1, seq: 2 });

      expect(snapshots()).toHaveLength(1);
    });
  });

  describe('pause and resume', () => {
    beforeEach(async () => {
      await loadAndClear();
      await start(1);
      scheduler.fire();
      await send({ type: 'ack', runId: 1, seq: 1 });
    });

    it('pausing stops generation', async () => {
      await send({ type: 'pause', runId: 1 });

      expect(scheduler.running).toBe(false);
      expect(events.at(-1)).toEqual({ type: 'status', runId: 1, state: 'paused' });
    });

    it('resuming keeps the totals and does not back-fill the paused interval', async () => {
      await send({ type: 'pause', runId: 1 });
      clock.now = 60_000;
      await send({ type: 'resume', runId: 1 });

      expect(events.at(-1)).toEqual({ type: 'status', runId: 1, state: 'running' });
      expect(scheduler.intervalMs).toBe(500);
      expect(snapshots()).toHaveLength(1);

      scheduler.fire();
      expect(lastSnapshot()).toMatchObject({ seq: 2, stats: { totalUpdates: 8, batches: 2 } });
      expect(lastSnapshot()?.instruments).toEqual([totalsAfter(4), totalsAfter(4)]);
    });

    it('treats a repeated pause or resume as a status echo', async () => {
      events.length = 0;
      await send({ type: 'pause', runId: 1 });
      await send({ type: 'pause', runId: 1 });
      expect(scheduler.running).toBe(false);

      await send({ type: 'resume', runId: 1 });
      await send({ type: 'resume', runId: 1 });
      expect(scheduler.running).toBe(true);
      expect(events.map((event) => event.type === 'status' && event.state)).toEqual([
        'paused',
        'paused',
        'running',
        'running',
      ]);
    });
  });

  describe('a new run (Apply)', () => {
    const NEXT: ProducerSettings = { instrumentCount: 3, updatesPerBatch: 6, batchIntervalMs: 50 };

    beforeEach(async () => {
      await loadAndClear();
      await start(1);
      scheduler.fire();
      scheduler.fire();
    });

    it('resets the totals and starts generating even if the old run was paused', async () => {
      await send({ type: 'pause', runId: 1 });
      await start(2, NEXT);

      expect(generator.inits.at(-1)).toEqual([SEED, 3, 6]);
      expect(scheduler.intervalMs).toBe(50);
      expect(events.at(-1)).toEqual({ type: 'status', runId: 2, state: 'running' });

      // The new run does not wait for an ack of the old run's snapshot.
      scheduler.fire();
      expect(lastSnapshot()).toEqual({
        type: 'snapshot',
        runId: 2,
        seq: 1,
        stats: expect.objectContaining({ totalUpdates: 6, batches: 1, lateTicks: 0 }),
        instruments: [totalsAfter(2), totalsAfter(2), totalsAfter(2)],
      });
    });

    it('ignores commands addressed to the previous run', async () => {
      await start(2, NEXT);
      events.length = 0;
      await send({ type: 'pause', runId: 1 });
      await send({ type: 'ack', runId: 1, seq: 1 });

      expect(events).toEqual([]);
      expect(scheduler.running).toBe(true);
    });
  });

  describe('failures', () => {
    beforeEach(loadAndClear);

    it('stops for good when generation fails', async () => {
      await start(1);
      generator.failure = new RangeError('unreachable');
      scheduler.fire();

      expect(scheduler.running).toBe(false);
      expect(events.at(-1)).toEqual({
        type: 'error',
        runId: 1,
        code: 'GENERATION_FAILED',
        message: 'unreachable',
        fatal: true,
      });

      events.length = 0;
      await send({ type: 'resume', runId: 1 });
      await start(2);
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', runId: 2, code: 'INVALID_COMMAND' }),
      ]);
    });

    it('reports a rejected init as fatal', async () => {
      vi.spyOn(generator, 'init').mockImplementation(() => {
        throw new ProducerError('INIT_REJECTED', 'init failed with code -1');
      });
      await start(1);

      expect(scheduler.running).toBe(false);
      expect(events).toEqual([
        {
          type: 'error',
          runId: 1,
          code: 'INIT_REJECTED',
          message: 'init failed with code -1',
          fatal: true,
        },
      ]);
    });
  });
});
