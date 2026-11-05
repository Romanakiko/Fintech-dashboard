import { Component, computed, inject } from '@angular/core';
import { formatQuantity } from '../../core/format';
import { MarketStore } from '../../state/market.store';
import { MarketTable } from './market-table';
import { ProducerControls } from './producer-controls';

@Component({
  selector: 'app-dashboard-page',
  imports: [MarketTable, ProducerControls],
  template: `
    <div class="heading">
      <h1 tabindex="-1">Market dashboard</h1>
      <app-producer-controls />
    </div>

    <dl class="summary">
      <div>
        <dt>Instruments</dt>
        <dd>{{ settings().instrumentCount }}</dd>
      </div>
      <div>
        <dt>Batches</dt>
        <dd>
          {{ quantity(settings().updatesPerBatch) }} updates every
          {{ quantity(settings().batchIntervalMs) }} ms
        </dd>
      </div>
      <div>
        <dt>Updates this run</dt>
        <dd>{{ quantity(stats().totalUpdates) }}</dd>
      </div>
      <div>
        <dt>Effective rate</dt>
        <dd>{{ rate() }} updates/s</dd>
      </div>
    </dl>

    <app-market-table [rows]="rows()" />
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-4);
    }

    .heading {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-4);
      align-items: center;
      justify-content: space-between;
    }

    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-8);
      margin: 0;
    }

    dt {
      font-size: 0.875rem;
      color: var(--color-text-muted);
    }

    dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class DashboardPage {
  private readonly market = inject(MarketStore);

  protected readonly rows = this.market.rows;
  protected readonly settings = this.market.settings;
  protected readonly stats = this.market.stats;
  protected readonly quantity = formatQuantity;

  /** The last measured rate is stale once generation stops, so show what is happening now. */
  protected readonly rate = computed(() =>
    formatQuantity(
      this.market.status() === 'running' ? Math.round(this.stats().updatesPerSecond) : 0,
    ),
  );
}
