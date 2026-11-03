import { DOCUMENT, DestroyRef, Service, inject } from '@angular/core';
import { Subject } from 'rxjs';
import type { ProducerCommand, ProducerEvent } from '../core/protocol';
import { PRODUCER_WORKER_FACTORY } from './producer-worker.factory';

const WASM_PATH = 'wasm/market_gen.wasm';

/**
 * Owns the app's single producer worker. As a root service it outlives every page, so
 * navigation can neither create a second producer nor stop the current one.
 */
@Service()
export class MarketProducerClient {
  private readonly createWorker = inject(PRODUCER_WORKER_FACTORY);
  private readonly document = inject(DOCUMENT);
  private readonly stream = new Subject<ProducerEvent>();
  private worker: Worker | null = null;

  readonly events = this.stream.asObservable();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.disconnect());
  }

  /** Replaces any current worker with a new one and loads the generator into it. */
  connect(): void {
    this.disconnect();
    try {
      this.worker = this.createWorker();
    } catch (error) {
      this.crash(`The producer worker could not be created: ${String(error)}`);
      return;
    }
    this.worker.onmessage = ({ data }: MessageEvent<ProducerEvent>) => this.dispatch(data);
    // A worker script that fails to load raises a plain Event without a message.
    this.worker.onerror = ({ message }) =>
      this.crash(message || 'The producer worker could not be loaded');
    this.worker.onmessageerror = () =>
      this.crash('A message from the producer worker could not be read');
    this.send({ type: 'load', wasmUrl: new URL(WASM_PATH, this.document.baseURI).href });
  }

  send(command: ProducerCommand): void {
    this.worker?.postMessage(command);
  }

  private disconnect(): void {
    if (this.worker === null) {
      return;
    }
    // Detached first: messages already queued from this worker must not reach the app.
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  private dispatch(event: ProducerEvent): void {
    if (event.type === 'error' && event.fatal) {
      this.disconnect();
    }
    this.stream.next(event);
  }

  private crash(message: string): void {
    this.dispatch({ type: 'error', runId: null, code: 'WORKER_CRASHED', message, fatal: true });
  }
}
