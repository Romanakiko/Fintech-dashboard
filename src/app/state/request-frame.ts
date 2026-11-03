import { InjectionToken } from '@angular/core';

/** Runs a callback before the next paint. Injectable so tests decide when frames happen. */
export const REQUEST_FRAME = new InjectionToken<(callback: () => void) => void>('REQUEST_FRAME', {
  providedIn: 'root',
  factory: () => (callback) => {
    requestAnimationFrame(callback);
  },
});
