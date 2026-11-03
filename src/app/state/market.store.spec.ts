import { TestBed } from '@angular/core/testing';
import { MarketAggregator } from '../core/aggregator';
import type { ProducerCommand, ProducerEvent, ProducerStats } from '../core/protocol';
import { DEFAULT_SETTINGS, type ProducerSettings } from '../core/settings';
import { FakeWorker, provideFakeWorkers } from '../../testing/fake-worker';
import { encodeUpdates, workedExampleUpdates } from '../../testing/market-updates';
import { MarketStore } from './market.store';
import { REQUEST_FRAME } from './request-frame';

type StartCommand = Extract<ProducerCommand, { type: 'start' }>;

const NEXT_SETTINGS: ProducerSettings = {
  instrumentCount: 3,
  updatesPerBatch: 10,
  batchIntervalMs: 50,
};
const STATS: ProducerStats = {
  totalUpdates: 2,
  batches: 1,
  lastBatchMs: 1,
  updatesPerSecond: 4,
  lateTicks: 0,
};
const FATAL: ProducerEvent = {
  type: 'error',
  runId: 1,
  code: 'WASM_FETCH_FAILED',
  message: 'Could not fetch wasm/market_gen.wasm: HTTP 404',
  fatal: true,
};

/** A snapshot with the task's worked example on the first instrument. */
function snapshot(runId: number, seq = 1, instrumentCount = 5): ProducerEvent {
  const aggregator = new MarketAggregator(instrumentCount);
  aggregator.ingest(encodeUpdates(workedExampleUpdates(0)), 2);
  return { type: 'snapshot', runId, seq, stats: STATS, instruments: aggregator.snapshot() };
}

describe('MarketStore', () => {
  let workers: FakeWorker[];
  let frames: (() => void)[];
  let store: MarketStore;

  const worker = () => workers[workers.length - 1];
  const runFrames = () => frames.splice(0).forEach((frame) => frame());
  const startCommands = () =>
    worker().posted.filter((command): command is StartCommand => command.type === 'start');
  const acks = () => worker().posted.filter((command) => command.type === 'ack');

  /** Boots the producer up to a running first run. */
  function boot(): void {
    store.connect();
    worker().emit({ type: 'ready' });
    worker().emit({ type: 'status', runId: 1, state: 'running' });
  }

  beforeEach(() => {
    workers = [];
    frames = [];
    TestBed.configureTestingModule({
      providers: [
        provideFakeWorkers(workers),
        { provide: REQUEST_FRAME, useValue: (frame: () => void) => frames.push(frame) },
      ],
    });
    store = TestBed.inject(MarketStore);
  });

  describe('before any data', () => {
    it('shows the default instruments as unavailable, with zero volume', () => {
      expect(store.status()).toBe('initializing');
      expect(store.rows().map((row) => row.symbol)).toEqual([
        'ALFA',
        'BETA',
        'GAMA',
        'DLTA',
        'EPSI',
      ]);
      expect(store.rows()[0]).toEqual({
        symbol: 'ALFA',
        lastPriceCents: null,
        spreadCents: null,
        volume: 0,
        vwapCents: null,
        imbalance: null,
      });
    });

    it('starts the first run with the default settings once the worker is ready', () => {
      store.connect();
      expect(startCommands()).toEqual([]);

      worker().emit({ type: 'ready' });

      expect(store.runId()).toBe(1);
      expect(store.status()).toBe('running');
      expect(startCommands()).toEqual([
        {
          type: 'start',
          runId: 1,
          settings: DEFAULT_SETTINGS,
          seed: [expect.any(Number), expect.any(Number)],
        },
      ]);
    });

    it('waits for the worker when settings are applied during startup', () => {
      store.connect();

      store.startRun(NEXT_SETTINGS);
      expect(store.status()).toBe('initializing');
      expect(store.rows()).toHaveLength(3);
      expect(startCommands()).toEqual([]);

      worker().emit({ type: 'ready' });
      expect(startCommands()).toEqual([expect.objectContaining({ settings: NEXT_SETTINGS })]);
    });
  });

  describe('snapshots', () => {
    beforeEach(boot);

    it('commits a snapshot in an animation frame, then acknowledges it', () => {
      worker().emit(snapshot(1));
      expect(store.rows()[0].volume).toBe(0);
      expect(acks()).toEqual([]);

      runFrames();

      expect(store.rows()[0]).toEqual({
        symbol: 'ALFA',
        lastPriceCents: 10_200,
        spreadCents: 4,
        volume: 40,
        vwapCents: '10150',
        imbalance: 0.2,
      });
      expect(store.stats()).toEqual(STATS);
      expect(acks()).toEqual([{ type: 'ack', runId: 1, seq: 1 }]);
    });

    it('keeps instruments isolated', () => {
      worker().emit(snapshot(1));
      runFrames();

      expect(store.rows()[1]).toMatchObject({ symbol: 'BETA', volume: 0, vwapCents: null });
    });

    it('coalesces snapshots that arrive within one frame into the latest', () => {
      worker().emit(snapshot(1, 1));
      worker().emit(snapshot(1, 2));

      expect(frames).toHaveLength(1);
      runFrames();
      expect(acks()).toEqual([{ type: 'ack', runId: 1, seq: 2 }]);
    });
  });

  describe('pause and resume', () => {
    beforeEach(boot);

    it('forwards the commands and follows the status the worker reports', () => {
      store.pause();
      expect(worker().posted.at(-1)).toEqual({ type: 'pause', runId: 1 });
      expect(store.status()).toBe('running');

      worker().emit({ type: 'status', runId: 1, state: 'paused' });
      expect(store.status()).toBe('paused');

      store.resume();
      expect(worker().posted.at(-1)).toEqual({ type: 'resume', runId: 1 });

      worker().emit({ type: 'status', runId: 1, state: 'running' });
      expect(store.status()).toBe('running');
    });

    it('keeps the totals across a pause', () => {
      worker().emit(snapshot(1));
      runFrames();
      worker().emit({ type: 'status', runId: 1, state: 'paused' });
      worker().emit({ type: 'status', runId: 1, state: 'running' });

      expect(store.rows()[0].volume).toBe(40);
    });
  });

  describe('applying settings', () => {
    beforeEach(boot);

    it('clears the previous run synchronously and starts a new one', () => {
      worker().emit(snapshot(1));
      runFrames();

      store.startRun(NEXT_SETTINGS);

      expect(store.runId()).toBe(2);
      expect(store.settings()).toEqual(NEXT_SETTINGS);
      expect(store.rows()).toHaveLength(3);
      expect(store.rows()[0]).toMatchObject({ volume: 0, lastPriceCents: null, vwapCents: null });
      expect(store.stats().totalUpdates).toBe(0);
      expect(startCommands().at(-1)).toMatchObject({ runId: 2, settings: NEXT_SETTINGS });
    });

    it('starts generating even if the previous run was paused', () => {
      worker().emit({ type: 'status', runId: 1, state: 'paused' });

      store.startRun(NEXT_SETTINGS);

      expect(store.status()).toBe('running');
      expect(startCommands().at(-1)).toMatchObject({ runId: 2 });
    });

    it('uses a new seed for every run', () => {
      store.startRun(NEXT_SETTINGS);
      const [first, second] = startCommands();

      expect(second.seed).not.toEqual(first.seed);
    });

    it('rejects a snapshot of the previous run', () => {
      store.startRun(NEXT_SETTINGS);
      worker().emit(snapshot(1));
      runFrames();

      expect(frames).toEqual([]);
      expect(store.rows()).toHaveLength(3);
      expect(store.rows()[0].volume).toBe(0);
      expect(acks()).toEqual([]);
    });

    it('discards a snapshot of the previous run that was waiting for a frame', () => {
      worker().emit(snapshot(1));
      store.startRun(NEXT_SETTINGS);
      runFrames();

      expect(store.rows()[0].volume).toBe(0);
      expect(acks()).toEqual([]);
    });

    it('commits the new run even when an old frame is still pending', () => {
      worker().emit(snapshot(1));
      store.startRun(NEXT_SETTINGS);
      worker().emit(snapshot(2, 1, 3));
      runFrames();

      expect(store.rows()).toHaveLength(3);
      expect(store.rows()[0].volume).toBe(40);
      expect(acks()).toEqual([{ type: 'ack', runId: 2, seq: 1 }]);
    });

    it('rejects a status of the previous run', () => {
      store.startRun(NEXT_SETTINGS);
      worker().emit({ type: 'status', runId: 1, state: 'paused' });

      expect(store.status()).toBe('running');
    });
  });

  describe('failures', () => {
    it('shows a fatal error and keeps the last values', () => {
      boot();
      worker().emit(snapshot(1));
      runFrames();
      worker().emit(FATAL);

      expect(store.status()).toBe('error');
      expect(store.error()).toEqual(FATAL);
      expect(store.rows()[0].volume).toBe(40);
    });

    it('shows a fatal error of a previous run: the worker is gone either way', () => {
      boot();
      store.startRun(NEXT_SETTINGS);
      worker().emit(FATAL);

      expect(store.status()).toBe('error');
    });

    it('drops a pending snapshot after a fatal error', () => {
      boot();
      worker().emit(snapshot(1));
      worker().emit(FATAL);
      runFrames();

      expect(store.rows()[0].volume).toBe(0);
    });

    it('shows a non-fatal error without changing the status', () => {
      boot();
      const warning: ProducerEvent = {
        type: 'error',
        runId: null,
        code: 'INVALID_COMMAND',
        message: 'Rejected a malformed command',
        fatal: false,
      };
      worker().emit(warning);

      expect(store.status()).toBe('running');
      expect(store.error()).toEqual(warning);
    });

    it('retries with a new worker and starts a new run with the same settings', () => {
      boot();
      store.startRun(NEXT_SETTINGS);
      const failed = worker();
      failed.emit(FATAL);

      store.connect();
      expect(store.status()).toBe('initializing');
      expect(store.error()).toBeNull();
      expect(workers).toHaveLength(2);
      expect(failed.terminated).toBe(true);

      worker().emit({ type: 'ready' });
      expect(startCommands()).toEqual([
        expect.objectContaining({ runId: 3, settings: NEXT_SETTINGS }),
      ]);
    });

    it('recovers when settings are applied after a fatal error', () => {
      boot();
      worker().emit(FATAL);

      store.startRun(NEXT_SETTINGS);
      expect(store.status()).toBe('initializing');
      expect(store.error()).toBeNull();
      expect(workers).toHaveLength(2);

      worker().emit({ type: 'ready' });
      expect(startCommands()).toEqual([expect.objectContaining({ settings: NEXT_SETTINGS })]);
    });
  });
});
