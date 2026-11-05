import type { Provider } from '@angular/core';
import { MarketAggregator } from '../app/core/aggregator';
import type { ProducerCommand, ProducerStats } from '../app/core/protocol';
import type { MarketStore } from '../app/state/market.store';
import { REQUEST_FRAME } from '../app/state/request-frame';
import { FakeWorker, provideFakeWorkers } from './fake-worker';
import { encodeUpdates, workedExampleUpdates } from './market-updates';

/** A fake producer for component tests: fake workers and animation frames the test runs. */
export class TestProducer {
  readonly workers: FakeWorker[] = [];
  readonly frames: (() => void)[] = [];
  readonly providers: Provider[] = [
    provideFakeWorkers(this.workers),
    { provide: REQUEST_FRAME, useValue: (frame: () => void) => this.frames.push(frame) },
  ];

  get worker(): FakeWorker {
    const worker = this.workers.at(-1);
    if (worker === undefined) {
      throw new Error('No producer worker has been created');
    }
    return worker;
  }

  /** Lets the worker report ready and a running first run. */
  boot(store: MarketStore): void {
    if (this.workers.length === 0) {
      store.connect();
    }
    this.worker.emit({ type: 'ready' });
    this.worker.emit({ type: 'status', runId: store.runId(), state: 'running' });
  }

  runFrames(): void {
    this.frames.splice(0).forEach((frame) => frame());
  }

  /** Publishes the task's worked example on the first instrument and commits it. */
  publishWorkedExample(store: MarketStore): void {
    const aggregator = new MarketAggregator(store.settings().instrumentCount);
    aggregator.ingest(encodeUpdates(workedExampleUpdates(0)), 2);
    this.worker.emit({
      type: 'snapshot',
      runId: store.runId(),
      seq: 1,
      stats: WORKED_EXAMPLE_STATS,
      instruments: aggregator.snapshot(),
    });
    this.runFrames();
  }

  /** Commands of one type posted to any worker, oldest first. */
  sent(type: ProducerCommand['type']): ProducerCommand[] {
    return this.workers
      .flatMap((worker) => worker.posted)
      .filter((command) => command.type === type);
  }
}

export const WORKED_EXAMPLE_STATS: ProducerStats = {
  totalUpdates: 1_234,
  batches: 12,
  lastBatchMs: 0.4,
  updatesPerSecond: 199.6,
  lateTicks: 0,
};
