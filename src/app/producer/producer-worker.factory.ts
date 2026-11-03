import { InjectionToken } from '@angular/core';

/** Creates the producer worker. Injectable because tests run without a real Worker. */
export const PRODUCER_WORKER_FACTORY = new InjectionToken<() => Worker>('PRODUCER_WORKER_FACTORY', {
  providedIn: 'root',
  factory: () => () =>
    new Worker(new URL('./worker/market.worker', import.meta.url), { type: 'module' }),
});
