import { encodeUpdates, type TestUpdate, workedExampleUpdates } from '../../testing/market-updates';
import { MarketAggregator } from './aggregator';

function update(overrides: Partial<TestUpdate>): TestUpdate {
  return {
    instrument: 0,
    priceCents: 1_000,
    tradeQty: 1,
    bidCents: 999,
    askCents: 1_000,
    bidQty: 10,
    askQty: 10,
    ...overrides,
  };
}

function ingest(aggregator: MarketAggregator, updates: TestUpdate[]): void {
  aggregator.ingest(encodeUpdates(updates), updates.length);
}

describe('MarketAggregator', () => {
  it('starts with unavailable prices and zero volume', () => {
    const snapshot = new MarketAggregator(3).snapshot();

    expect(snapshot).toHaveLength(3);
    for (const totals of snapshot) {
      expect(totals).toEqual({
        lastPriceCents: null,
        bidCents: null,
        askCents: null,
        bidQty: null,
        askQty: null,
        volume: 0,
        notionalCents: 0n,
      });
    }
  });

  it('accumulates the worked example', () => {
    const aggregator = new MarketAggregator(1);
    ingest(aggregator, workedExampleUpdates());

    expect(aggregator.snapshot()[0]).toEqual({
      lastPriceCents: 10_200,
      bidCents: 10_196,
      askCents: 10_200,
      bidQty: 600,
      askQty: 400,
      volume: 40,
      notionalCents: 406_000n,
    });
  });

  it('keeps totals across batches and counts every trade exactly once', () => {
    const aggregator = new MarketAggregator(1);
    const [first, second] = workedExampleUpdates();
    ingest(aggregator, [first]);
    ingest(aggregator, [second]);

    expect(aggregator.snapshot()[0].volume).toBe(40);
    expect(aggregator.snapshot()[0].notionalCents).toBe(406_000n);
  });

  it('isolates instruments from each other', () => {
    const aggregator = new MarketAggregator(3);
    ingest(aggregator, [
      update({ instrument: 1, priceCents: 5_000, tradeQty: 7, bidCents: 4_999, askCents: 5_000 }),
      ...workedExampleUpdates(2),
    ]);
    const [untouched, one, two] = aggregator.snapshot();

    expect(untouched.volume).toBe(0);
    expect(untouched.lastPriceCents).toBeNull();
    expect(one).toMatchObject({ lastPriceCents: 5_000, volume: 7, notionalCents: 35_000n });
    expect(two).toMatchObject({ lastPriceCents: 10_200, volume: 40, notionalCents: 406_000n });
  });

  it('uses the latest book quantities without adding them to volume', () => {
    const aggregator = new MarketAggregator(1);
    ingest(aggregator, [
      update({ tradeQty: 2, bidQty: 900, askQty: 100 }),
      update({ tradeQty: 3, bidQty: 0, askQty: 0 }),
    ]);

    expect(aggregator.snapshot()[0]).toMatchObject({ volume: 5, bidQty: 0, askQty: 0 });
  });

  it('only reads the first `count` updates of the buffer', () => {
    const aggregator = new MarketAggregator(1);
    aggregator.ingest(encodeUpdates(workedExampleUpdates()), 1);

    expect(aggregator.snapshot()[0]).toMatchObject({ volume: 10, lastPriceCents: 10_000 });
  });

  it('keeps notional exact beyond Number.MAX_SAFE_INTEGER', () => {
    const aggregator = new MarketAggregator(1);
    const largest = update({
      priceCents: 10_000_010,
      tradeQty: 1_000,
      bidCents: 10_000_000,
      askCents: 10_000_010,
    });
    const batch = encodeUpdates(Array.from({ length: 1_000 }, () => largest));
    for (let i = 0; i < 1_000; i++) {
      aggregator.ingest(batch, 1_000);
    }

    const expected = 10_000_010n * 1_000n * 1_000n * 1_000n;
    expect(expected).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(aggregator.snapshot()[0].notionalCents).toBe(expected);
  });

  it('rejects malformed input', () => {
    const aggregator = new MarketAggregator(2);

    expect(() => ingest(aggregator, [update({ instrument: 2 })])).toThrow(RangeError);
    expect(() => aggregator.ingest(encodeUpdates([update({})]), 2)).toThrow(RangeError);
  });
});
