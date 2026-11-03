// Integration test: the store, the real engine and the compiled Wasm, wired through the
// worker protocol. Only the thread boundary is simulated, with structuredClone.
// @ts-expect-error TypeScript cannot type imports based on the `loader` attribute.
import wasmBytes from '../../../public/wasm/market_gen.wasm' with { loader: 'binary' };
import { TestBed } from '@angular/core/testing';
import { MarketAggregator } from '../core/aggregator';
import { computeMetrics } from '../core/metrics';
import type { ProducerCommand, Seed } from '../core/protocol';
import type { ProducerSettings } from '../core/settings';
import { symbolOf } from '../core/symbols';
import { ProducerEngine } from '../producer/worker/producer-engine';
import { loadWasmMarketGenerator } from '../producer/worker/wasm-market-generator';
import { FakeWorker, provideFakeWorkers } from '../../testing/fake-worker';
import { ManualScheduler } from '../../testing/manual-scheduler';
import { MarketStore } from './market.store';
import { REQUEST_FRAME } from './request-frame';

type StartCommand = Extract<ProducerCommand, { type: 'start' }>;

const SETTINGS: ProducerSettings = {
  instrumentCount: 7,
  updatesPerBatch: 250,
  batchIntervalMs: 50,
};

const loadGenerator = (url: string) =>
  loadWasmMarketGenerator(url, () =>
    Promise.resolve(
      new Response(wasmBytes as Uint8Array<ArrayBuffer>, {
        headers: { 'Content-Type': 'application/wasm' },
      }),
    ),
  );

/** The real engine and generator behind the Worker interface, on the test's thread. */
class LoopbackWorker extends FakeWorker {
  readonly scheduler = new ManualScheduler();
  private readonly engine = new ProducerEngine({
    loadGenerator,
    scheduler: this.scheduler,
    emit: (event) => this.emit(structuredClone(event)),
    now: () => 0,
  });

  override postMessage(command: ProducerCommand): void {
    super.postMessage(command);
    void this.engine.handle(structuredClone(command));
  }
}

describe('market data flow', () => {
  let workers: LoopbackWorker[];
  let frames: (() => void)[];
  let store: MarketStore;

  const worker = () => workers[workers.length - 1];
  const runFrames = () => frames.splice(0).forEach((frame) => frame());

  const lastStart = () =>
    worker()
      .posted.filter((command): command is StartCommand => command.type === 'start')
      .at(-1);

  /** Folds `batches` of the seeded stream directly, without the engine or the store. */
  async function replay(seed: Seed, settings: ProducerSettings, batches: number) {
    const generator = await loadGenerator('replay.wasm');
    const aggregator = new MarketAggregator(settings.instrumentCount);
    generator.init(seed, settings.instrumentCount, settings.updatesPerBatch);
    for (let batch = 0; batch < batches; batch++) {
      aggregator.ingest(generator.generate(settings.updatesPerBatch), settings.updatesPerBatch);
    }
    return aggregator
      .snapshot()
      .map((totals, index) => ({ symbol: symbolOf(index), ...computeMetrics(totals) }));
  }

  beforeEach(async () => {
    workers = [];
    frames = [];
    TestBed.configureTestingModule({
      providers: [
        provideFakeWorkers(workers, () => new LoopbackWorker()),
        { provide: REQUEST_FRAME, useValue: (frame: () => void) => frames.push(frame) },
      ],
    });
    store = TestBed.inject(MarketStore);
    store.connect();
    await vi.waitFor(() => expect(store.runId()).toBe(1));
    store.startRun(SETTINGS);
  });

  it('counts every generated trade, however few frames the UI renders', async () => {
    for (let batch = 1; batch <= 60; batch++) {
      worker().scheduler.fire();
      if (batch % 7 === 0) {
        runFrames();
      }
    }
    // One frame commits the snapshot in flight; its ack releases the latest totals.
    runFrames();
    runFrames();

    const start = lastStart();
    expect(start).toBeDefined();
    expect(store.stats()).toMatchObject({ batches: 60, totalUpdates: 60 * 250 });
    expect(store.rows()).toEqual(await replay(start?.seed ?? [0, 0], SETTINGS, 60));
  });

  it('never lets results of the previous run reach the new one', () => {
    worker().scheduler.fire(); // Published, but the frame has not happened yet.
    worker().scheduler.fire();

    const next: ProducerSettings = { ...SETTINGS, instrumentCount: 2, updatesPerBatch: 10 };
    store.startRun(next);
    expect(store.rows().map((row) => row.volume)).toEqual([0, 0]);

    runFrames();
    expect(store.rows().map((row) => row.volume)).toEqual([0, 0]);

    worker().scheduler.fire();
    runFrames();
    expect(store.rows()).toHaveLength(2);
    expect(store.stats()).toMatchObject({ batches: 1, totalUpdates: 10 });
  });

  it('keeps totals across pause and resume without back-filling', () => {
    worker().scheduler.fire();
    runFrames();
    const before = store.rows();

    store.pause();
    expect(store.status()).toBe('paused');
    expect(worker().scheduler.running).toBe(false);

    store.resume();
    expect(store.status()).toBe('running');
    runFrames();
    expect(store.rows()).toEqual(before);
    expect(store.stats().batches).toBe(1);
  });
});
