import { TestBed } from '@angular/core/testing';
import type { ProducerEvent } from '../core/protocol';
import { FakeWorker, provideFakeWorkers } from '../../testing/fake-worker';
import { MarketProducerClient } from './market-producer.client';
import { PRODUCER_WORKER_FACTORY } from './producer-worker.factory';

describe('MarketProducerClient', () => {
  let workers: FakeWorker[];
  let events: ProducerEvent[];
  let client: MarketProducerClient;

  function createClient(): void {
    client = TestBed.inject(MarketProducerClient);
    client.events.subscribe((event) => events.push(event));
  }

  const crashedWith = (message: unknown) => ({
    type: 'error',
    runId: null,
    code: 'WORKER_CRASHED',
    message,
    fatal: true,
  });

  beforeEach(() => {
    workers = [];
    events = [];
    TestBed.configureTestingModule({ providers: [provideFakeWorkers(workers)] });
  });

  it('creates no worker until connect() is called', () => {
    createClient();
    expect(workers).toEqual([]);
  });

  it('creates a worker and loads the generator from a URL based on the document', () => {
    createClient();
    client.connect();

    expect(workers).toHaveLength(1);
    expect(workers[0].posted).toEqual([
      { type: 'load', wasmUrl: new URL('wasm/market_gen.wasm', document.baseURI).href },
    ]);
  });

  it('forwards worker events and sends commands to the worker', () => {
    createClient();
    client.connect();
    workers[0].emit({ type: 'ready' });
    client.send({ type: 'pause', runId: 1 });

    expect(events).toEqual([{ type: 'ready' }]);
    expect(workers[0].posted.at(-1)).toEqual({ type: 'pause', runId: 1 });
  });

  it('keeps one worker: reconnecting terminates the old one and ignores its late events', () => {
    createClient();
    client.connect();
    const [first] = workers;
    const lateEvent = first.onmessage;

    client.connect();
    lateEvent?.(new MessageEvent('message', { data: { type: 'ready' } }));
    first.emit({ type: 'ready' });

    expect(workers).toHaveLength(2);
    expect(first.terminated).toBe(true);
    expect(first.onmessage).toBeNull();
    expect(workers[1].terminated).toBe(false);
  });

  it('terminates the worker when the application is destroyed', () => {
    createClient();
    client.connect();
    TestBed.resetTestingModule();

    expect(workers[0].terminated).toBe(true);
  });

  describe('failures', () => {
    it('releases the worker after a fatal error from the engine', () => {
      createClient();
      client.connect();
      const failure: ProducerEvent = {
        type: 'error',
        runId: 1,
        code: 'GENERATION_FAILED',
        message: 'trap',
        fatal: true,
      };
      workers[0].emit(failure);

      expect(events).toEqual([failure]);
      expect(workers[0].terminated).toBe(true);
    });

    it('keeps the worker after a non-fatal error', () => {
      createClient();
      client.connect();
      workers[0].emit({
        type: 'error',
        runId: null,
        code: 'INVALID_COMMAND',
        message: 'Rejected a malformed command',
        fatal: false,
      });

      expect(workers[0].terminated).toBe(false);
    });

    it('reports a crash when the worker cannot be created', () => {
      TestBed.overrideProvider(PRODUCER_WORKER_FACTORY, {
        useValue: () => {
          throw new DOMException('Blocked by CSP', 'SecurityError');
        },
      });
      createClient();
      client.connect();

      expect(events).toEqual([crashedWith(expect.stringContaining('Blocked by CSP'))]);
    });

    it('reports an uncaught worker error and releases the worker', () => {
      createClient();
      client.connect();
      workers[0].onerror?.({ message: 'Uncaught TypeError: boom' });

      expect(events).toEqual([crashedWith('Uncaught TypeError: boom')]);
      expect(workers[0].terminated).toBe(true);
    });

    it('explains a worker script that failed to load', () => {
      createClient();
      client.connect();
      workers[0].onerror?.({});

      expect(events).toEqual([crashedWith('The producer worker could not be loaded')]);
    });

    it('reports a message that could not be deserialized', () => {
      createClient();
      client.connect();
      workers[0].onmessageerror?.();

      expect(events).toEqual([crashedWith(expect.stringContaining('could not be read'))]);
    });
  });
});
