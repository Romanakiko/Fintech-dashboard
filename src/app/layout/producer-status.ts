import { Component, computed, inject } from '@angular/core';
import { MarketStore, type ProducerStatus } from '../state/market.store';

const LABELS: Record<ProducerStatus, string> = {
  initializing: 'Starting',
  running: 'Running',
  paused: 'Paused',
  error: 'Stopped',
};

/**
 * The producer's lifecycle state. It is a polite live region, so screen readers announce
 * state and run changes. The fast-changing numbers live elsewhere and are not announced.
 */
@Component({
  selector: 'app-producer-status',
  template: `
    <p class="status" role="status" [attr.data-status]="status()">
      <span class="status__dot" aria-hidden="true"></span>
      Producer: {{ label() }}
      @if (runId() > 0) {
        · run {{ runId() }}
      }
    </p>
  `,
  styles: `
    .status {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      margin: 0;
      color: var(--color-text-muted);
    }

    .status__dot {
      width: 0.625rem;
      height: 0.625rem;
      background: var(--color-text-muted);
      border-radius: 50%;
    }

    [data-status='running'] .status__dot {
      background: var(--color-success);
    }

    [data-status='paused'] .status__dot {
      background: var(--color-warning);
    }

    [data-status='error'] .status__dot {
      background: var(--color-danger);
    }
  `,
})
export class ProducerStatusBadge {
  private readonly market = inject(MarketStore);

  protected readonly status = this.market.status;
  protected readonly runId = this.market.runId;
  protected readonly label = computed(() => LABELS[this.status()]);
}
