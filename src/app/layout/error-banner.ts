import { Component, DOCUMENT, inject } from '@angular/core';
import type { ProducerErrorCode } from '../core/protocol';
import { MarketStore } from '../state/market.store';
import { focusMainHeading } from './focus-main';

const HEADLINES: Record<ProducerErrorCode, string> = {
  WASM_FETCH_FAILED: 'The market data generator could not be downloaded.',
  WASM_COMPILE_FAILED: 'The market data generator could not be loaded.',
  ABI_MISMATCH:
    'The market data generator does not match this version of the app. Reload the page.',
  INIT_REJECTED: 'The market data generator rejected the settings.',
  GENERATION_FAILED: 'The market data generator stopped unexpectedly.',
  INVALID_COMMAND: 'The producer rejected a command.',
  WORKER_CRASHED: 'The background producer stopped unexpectedly.',
};

/** Explains a producer failure and, when the producer is down, offers Retry. */
@Component({
  selector: 'app-error-banner',
  template: `
    @if (error(); as error) {
      <div class="banner" role="alert">
        <p class="banner__title">{{ headlines[error.code] }}</p>
        <p class="banner__detail">{{ error.message }} ({{ error.code }})</p>
        @if (error.fatal) {
          <button type="button" class="button" (click)="retry()">Retry</button>
        }
      </div>
    }
  `,
  styles: `
    .banner {
      display: grid;
      gap: var(--space-2);
      justify-items: start;
      margin-block-end: var(--space-6);
      padding: var(--space-4);
      color: var(--color-danger);
      background: var(--color-danger-surface);
      border: 1px solid currentColor;
      border-radius: var(--radius);
    }

    .banner__title,
    .banner__detail {
      margin: 0;
    }

    .banner__title {
      font-weight: 700;
    }

    .banner__detail {
      overflow-wrap: anywhere;
    }
  `,
})
export class ErrorBanner {
  private readonly market = inject(MarketStore);
  private readonly document = inject(DOCUMENT);

  protected readonly error = this.market.error;
  protected readonly headlines = HEADLINES;

  protected retry(): void {
    this.market.connect();
    // The banner, and the focused Retry button with it, disappears with the error.
    focusMainHeading(this.document);
  }
}
