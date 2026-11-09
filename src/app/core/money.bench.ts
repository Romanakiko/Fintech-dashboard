// Evidence for ADR-9 (spec §5.6): exact money on the per-update hot path with integers versus
// decimal.js, and what decimal.js costs where it is used, once per snapshot. `npm run bench`.
// One batch is the largest the settings allow (1,000 updates over 50 instruments); the
// maximum rate is 20 such batches per second, i.e. 20,000 updates/s.
import { Decimal } from 'decimal.js';
import { expect, test } from 'vitest';
import { type TestUpdate, encodeUpdates } from '../../testing/market-updates';
import { MarketAggregator } from './aggregator';
import { formatMoney } from './format';
import { UPDATE_STRIDE, UpdateField } from './market-update';
import { computeMetrics } from './metrics';

const INSTRUMENTS = 50;
const BATCH_SIZE = 1000;
const BATCHES_PER_SECOND = 20;

/** A deterministic batch with the generator's ranges: $10–$500, quantities 1–1,000. */
function sampleBatch(): Uint32Array {
  let state = 42;
  const below = (n: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % n;
  };
  const updates: TestUpdate[] = Array.from({ length: BATCH_SIZE }, () => {
    const bidCents = 1_000 + below(49_000);
    const askCents = bidCents + 1 + below(10);
    return {
      instrument: below(INSTRUMENTS),
      priceCents: below(2) === 0 ? bidCents : askCents,
      tradeQty: 1 + below(1000),
      bidCents,
      askCents,
      bidQty: below(10_001),
      askQty: below(10_001),
    };
  });
  return encodeUpdates(updates);
}

/**
 * The rejected alternative: MarketAggregator's loop with the notional summed in decimal.js on
 * every update. Lives only here; the app keeps decimal.js behind core/money.ts.
 */
class DecimalAggregator {
  private static readonly Money = Decimal.clone({
    precision: 40,
    rounding: Decimal.ROUND_HALF_EVEN,
  });
  private readonly book = new Float64Array(INSTRUMENTS * 5);
  private readonly volume = new Float64Array(INSTRUMENTS);
  private readonly notional = Array.from(
    { length: INSTRUMENTS },
    () => new DecimalAggregator.Money(0),
  );

  ingest(updates: Uint32Array, count: number): void {
    // Locals, as in MarketAggregator.ingest: imports are getters under Vitest's module runner.
    const stride = UPDATE_STRIDE;
    const field = UpdateField;
    const Money = DecimalAggregator.Money;
    for (let offset = 0; offset < count * stride; offset += stride) {
      const i = updates[offset + field.instrument];
      const price = updates[offset + field.priceCents];
      const qty = updates[offset + field.tradeQty];
      this.book[i * 5] = price;
      this.book[i * 5 + 1] = updates[offset + field.bidCents];
      this.book[i * 5 + 2] = updates[offset + field.askCents];
      this.book[i * 5 + 3] = updates[offset + field.bidQty];
      this.book[i * 5 + 4] = updates[offset + field.askQty];
      this.volume[i] += qty;
      this.notional[i] = this.notional[i].plus(new Money(price).times(qty));
    }
  }
}

/** Mean time per run, and the share of one core it takes at `perSecond` runs. */
function describeCost(name: string, meanMs: number, perSecond: number): string {
  const share = ((meanMs * perSecond) / 1000) * 100;
  return `${name}: ${meanMs.toFixed(4)} ms each, ${share.toFixed(2)}% of one core at ${perSecond}/s`;
}

const batch = sampleBatch();

test('money on the hot path: integers versus decimal.js per update', async ({ bench }) => {
  const integer = new MarketAggregator(INSTRUMENTS);
  const decimal = new DecimalAggregator();

  const result = await bench.compare(
    bench('integer cents + bigint carry (MarketAggregator)', () =>
      integer.ingest(batch, BATCH_SIZE),
    ),
    bench('decimal.js per update', () => decimal.ingest(batch, BATCH_SIZE)),
  );

  const integerResult = result.get('integer cents + bigint carry (MarketAggregator)');
  const decimalResult = result.get('decimal.js per update');
  expect(integerResult).toBeFasterThan(decimalResult);
  console.log(
    [
      describeCost('integer batch', integerResult.latency.mean, BATCHES_PER_SECOND),
      describeCost('decimal.js batch', decimalResult.latency.mean, BATCHES_PER_SECOND),
      `decimal.js is ${(decimalResult.latency.mean / integerResult.latency.mean).toFixed(1)}× slower`,
    ].join('\n'),
  );
});

test('decimal.js where it is used: one snapshot of 50 rows', async ({ bench }) => {
  const aggregator = new MarketAggregator(INSTRUMENTS);
  aggregator.ingest(batch, BATCH_SIZE);
  const snapshot = aggregator.snapshot();

  // What the main thread does per snapshot: derive metrics (VWAP division) and format the
  // money columns (one half-even rounding each), as MarketTable does.
  const result = await bench('metrics + money formatting, 50 rows', () => {
    for (const totals of snapshot) {
      const metrics = computeMetrics(totals);
      formatMoney(metrics.lastPriceCents);
      formatMoney(metrics.spreadCents);
      formatMoney(metrics.vwapCents);
    }
  }).run();

  console.log(describeCost('snapshot', result.latency.mean, BATCHES_PER_SECOND));
});
