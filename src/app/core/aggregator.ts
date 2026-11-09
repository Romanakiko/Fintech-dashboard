import { UPDATE_STRIDE, UpdateField } from './market-update';

/** Cumulative state of one instrument for the current run. */
export interface InstrumentTotals {
  readonly lastPriceCents: number | null;
  readonly bidCents: number | null;
  readonly askCents: number | null;
  readonly bidQty: number | null;
  readonly askQty: number | null;
  /** Sum of trade quantities. */
  readonly volume: number;
  /** Exact sum of priceCents × tradeQty. */
  readonly notionalCents: bigint;
}

/**
 * Folds batches of market updates into per-instrument totals without keeping
 * any event history.
 *
 * The per-update path is integer-only and allocation-free. Notional is summed
 * per batch in a float64 accumulator (a batch adds at most
 * 1,000 × $100,000.10 × 1,000 ≈ 1e13 cents, well inside 2^53, so it stays
 * exact) and then carried into a bigint, which keeps the total exact for any
 * run length.
 */
export class MarketAggregator {
  private readonly lastPrice: Float64Array;
  private readonly bid: Float64Array;
  private readonly ask: Float64Array;
  private readonly bidQty: Float64Array;
  private readonly askQty: Float64Array;
  private readonly volume: Float64Array;
  private readonly batchNotional: Float64Array;
  private readonly notional: bigint[];

  constructor(readonly instrumentCount: number) {
    // NaN marks "no update received yet".
    this.lastPrice = new Float64Array(instrumentCount).fill(NaN);
    this.bid = new Float64Array(instrumentCount).fill(NaN);
    this.ask = new Float64Array(instrumentCount).fill(NaN);
    this.bidQty = new Float64Array(instrumentCount).fill(NaN);
    this.askQty = new Float64Array(instrumentCount).fill(NaN);
    this.volume = new Float64Array(instrumentCount);
    this.batchNotional = new Float64Array(instrumentCount);
    this.notional = new Array<bigint>(instrumentCount).fill(0n);
  }

  /** Applies `count` updates laid out as UPDATE_STRIDE u32 values each. */
  ingest(updates: Uint32Array, count: number): void {
    // Locals rather than imports in the per-update loop: module runners that wrap imports in
    // getters (Vitest's, used by `npm run bench`) would otherwise dominate what is measured.
    const stride = UPDATE_STRIDE;
    const field = UpdateField;
    if (updates.length < count * stride) {
      throw new RangeError(`Expected ${count} updates, got ${updates.length / stride}`);
    }
    for (let offset = 0; offset < count * stride; offset += stride) {
      const i = updates[offset + field.instrument];
      if (i >= this.instrumentCount) {
        throw new RangeError(`Instrument ${i} is outside 0..${this.instrumentCount - 1}`);
      }
      const price = updates[offset + field.priceCents];
      const qty = updates[offset + field.tradeQty];
      this.lastPrice[i] = price;
      this.bid[i] = updates[offset + field.bidCents];
      this.ask[i] = updates[offset + field.askCents];
      this.bidQty[i] = updates[offset + field.bidQty];
      this.askQty[i] = updates[offset + field.askQty];
      this.volume[i] += qty;
      this.batchNotional[i] += price * qty;
    }
    for (let i = 0; i < this.instrumentCount; i++) {
      if (this.batchNotional[i] !== 0) {
        this.notional[i] += BigInt(this.batchNotional[i]);
        this.batchNotional[i] = 0;
      }
    }
  }

  snapshot(): InstrumentTotals[] {
    return Array.from({ length: this.instrumentCount }, (_, i) => ({
      lastPriceCents: orNull(this.lastPrice[i]),
      bidCents: orNull(this.bid[i]),
      askCents: orNull(this.ask[i]),
      bidQty: orNull(this.bidQty[i]),
      askQty: orNull(this.askQty[i]),
      volume: this.volume[i],
      notionalCents: this.notional[i],
    }));
  }
}

function orNull(value: number): number | null {
  return Number.isNaN(value) ? null : value;
}
