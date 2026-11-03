import type { Provider } from '@angular/core';
import type { ProducerCommand, ProducerEvent } from '../app/core/protocol';
import { PRODUCER_WORKER_FACTORY } from '../app/producer/producer-worker.factory';

/** Stands in for the producer Worker: records commands and emits events on demand. */
export class FakeWorker {
  onmessage: ((event: MessageEvent<ProducerEvent>) => void) | null = null;
  onerror: ((event: Partial<ErrorEvent>) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: ProducerCommand[] = [];
  terminated = false;

  postMessage(command: ProducerCommand): void {
    this.posted.push(command);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(event: ProducerEvent): void {
    this.onmessage?.(new MessageEvent('message', { data: event }));
  }
}

/** Makes the app create workers with `create`, and collects them in `workers`. */
export function provideFakeWorkers<T extends FakeWorker>(
  workers: T[],
  create: () => T = () => new FakeWorker() as T,
): Provider {
  return {
    provide: PRODUCER_WORKER_FACTORY,
    useValue: () => {
      const worker = create();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  };
}
