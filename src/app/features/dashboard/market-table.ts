import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { UNAVAILABLE, formatImbalance, formatMoney, formatQuantity } from '../../core/format';
import type { MarketRow } from '../../state/market.store';

/** One row per instrument. Values are formatted (and money rounded) only here, for display. */
@Component({
  selector: 'app-market-table',
  imports: [NgTemplateOutlet],
  template: `
    <div class="scroll" role="region" aria-labelledby="market-table-caption" tabindex="0">
      <table>
        <caption id="market-table-caption">
          Instruments in the current run
        </caption>
        <thead>
          <tr>
            <th scope="col">Symbol</th>
            <th scope="col" class="num">Last price</th>
            <th scope="col" class="num">Bid–ask spread</th>
            <th scope="col" class="num">Volume</th>
            <th scope="col" class="num">VWAP</th>
            <th scope="col" class="num">Order-book imbalance</th>
          </tr>
        </thead>
        <tbody>
          @for (row of cells(); track row.symbol) {
            <tr>
              <th scope="row">{{ row.symbol }}</th>
              <td class="num">
                <ng-container *ngTemplateOutlet="value; context: { $implicit: row.lastPrice }" />
              </td>
              <td class="num">
                <ng-container *ngTemplateOutlet="value; context: { $implicit: row.spread }" />
              </td>
              <td class="num">{{ row.volume }}</td>
              <td class="num">
                <ng-container *ngTemplateOutlet="value; context: { $implicit: row.vwap }" />
              </td>
              <td class="num">
                <ng-container *ngTemplateOutlet="value; context: { $implicit: row.imbalance }" />
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>

    <!-- A bare dash is skipped or read as "dash" by screen readers, so say what it means. -->
    <ng-template #value let-text>
      @if (text === unavailable) {
        <span aria-hidden="true">{{ unavailable }}</span>
        <span class="visually-hidden">not available</span>
      } @else {
        {{ text }}
      }
    </ng-template>
  `,
  styles: `
    .scroll {
      overflow-x: auto;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius);
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    caption {
      padding: var(--space-3) var(--space-4);
      font-weight: 600;
      text-align: left;
    }

    th,
    td {
      padding: var(--space-2) var(--space-4);
      white-space: nowrap;
      border-top: 1px solid var(--color-border);
    }

    thead th {
      font-size: 0.875rem;
      color: var(--color-text-muted);
      background: var(--color-surface-alt);
    }

    th {
      text-align: left;
    }

    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class MarketTable {
  readonly rows = input.required<readonly MarketRow[]>();

  protected readonly unavailable = UNAVAILABLE;
  protected readonly cells = computed(() =>
    this.rows().map((row) => ({
      symbol: row.symbol,
      lastPrice: formatMoney(row.lastPriceCents),
      spread: formatMoney(row.spreadCents),
      volume: formatQuantity(row.volume),
      vwap: formatMoney(row.vwapCents),
      imbalance: formatImbalance(row.imbalance),
    })),
  );
}
