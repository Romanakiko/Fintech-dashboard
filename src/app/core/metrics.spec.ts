import { encodeUpdates, workedExampleUpdates } from '../../testing/market-updates';
import { MarketAggregator } from './aggregator';
import { computeMetrics, orderBookImbalance, spreadCents } from './metrics';

describe('metrics', () => {
  it('computes the worked example end to end', () => {
    const aggregator = new MarketAggregator(1);
    aggregator.ingest(encodeUpdates(workedExampleUpdates()), 2);

    expect(computeMetrics(aggregator.snapshot()[0])).toEqual({
      lastPriceCents: 10_200, // $102
      spreadCents: 4, // $102.00 − $101.96
      volume: 40,
      vwapCents: '10150', // $101.50
      imbalance: 0.2, // (600 − 400) / (600 + 400)
    });
  });

  it('reports every metric as unavailable before data arrives, with zero volume', () => {
    const [initial] = new MarketAggregator(1).snapshot();

    expect(computeMetrics(initial)).toEqual({
      lastPriceCents: null,
      spreadCents: null,
      volume: 0,
      vwapCents: null,
      imbalance: null,
    });
  });

  it('computes each instrument from its own trades only', () => {
    const aggregator = new MarketAggregator(2);
    aggregator.ingest(encodeUpdates(workedExampleUpdates(1)), 2);
    const [alfa, beta] = aggregator.snapshot().map(computeMetrics);

    expect(alfa.vwapCents).toBeNull();
    expect(alfa.volume).toBe(0);
    expect(beta.vwapCents).toBe('10150');
  });

  describe('spreadCents', () => {
    it('is ask minus bid', () => {
      expect(spreadCents(10_196, 10_200)).toBe(4);
    });

    it('is unavailable without a quote', () => {
      expect(spreadCents(null, 10_200)).toBeNull();
      expect(spreadCents(10_196, null)).toBeNull();
    });
  });

  describe('orderBookImbalance', () => {
    it('ranges from -1 to +1', () => {
      expect(orderBookImbalance(600, 400)).toBe(0.2);
      expect(orderBookImbalance(600, 0)).toBe(1);
      expect(orderBookImbalance(0, 400)).toBe(-1);
      expect(orderBookImbalance(500, 500)).toBe(0);
    });

    it('is unavailable when both sides are empty (zero denominator)', () => {
      expect(orderBookImbalance(0, 0)).toBeNull();
    });

    it('is unavailable without a book', () => {
      expect(orderBookImbalance(null, null)).toBeNull();
    });
  });
});
