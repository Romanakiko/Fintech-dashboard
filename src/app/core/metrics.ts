import type { InstrumentTotals } from './aggregator';
import { type CentsDecimal, vwapCents } from './money';

/** Dashboard metrics of one instrument; null means "unavailable". */
export interface InstrumentMetrics {
  readonly lastPriceCents: number | null;
  readonly spreadCents: number | null;
  readonly volume: number;
  readonly vwapCents: CentsDecimal | null;
  /** In [-1, 1]. */
  readonly imbalance: number | null;
}

export function spreadCents(bidCents: number | null, askCents: number | null): number | null {
  return bidCents === null || askCents === null ? null : askCents - bidCents;
}

export function orderBookImbalance(bidQty: number | null, askQty: number | null): number | null {
  if (bidQty === null || askQty === null || bidQty + askQty === 0) {
    return null;
  }
  return (bidQty - askQty) / (bidQty + askQty);
}

export function computeMetrics(totals: InstrumentTotals): InstrumentMetrics {
  return {
    lastPriceCents: totals.lastPriceCents,
    spreadCents: spreadCents(totals.bidCents, totals.askCents),
    volume: totals.volume,
    vwapCents: vwapCents(totals.notionalCents, totals.volume),
    imbalance: orderBookImbalance(totals.bidQty, totals.askQty),
  };
}
