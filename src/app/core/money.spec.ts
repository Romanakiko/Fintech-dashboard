import { Decimal } from 'decimal.js';
import { centsToDollars, vwapCents } from './money';

describe('money', () => {
  describe('vwapCents', () => {
    it('matches the worked example: (100 × 10 + 102 × 30) / 40 = $101.50', () => {
      const notional = 10_000n * 10n + 10_200n * 30n;
      expect(vwapCents(notional, 40)).toBe('10150');
    });

    it('is unavailable when nothing has traded', () => {
      expect(vwapCents(0n, 0)).toBeNull();
    });

    it('keeps full precision instead of rounding early', () => {
      expect(vwapCents(10n, 3)).toMatch(/^3\.3{30,}$/);
    });

    it('stays exact for notionals beyond Number.MAX_SAFE_INTEGER', () => {
      const notional = 2n ** 70n + 1n;
      expect(vwapCents(notional, 1)).toBe(notional.toString());
    });
  });

  describe('centsToDollars', () => {
    it('converts whole cents exactly', () => {
      expect(centsToDollars(0)).toBe('0.00');
      expect(centsToDollars(1)).toBe('0.01');
      expect(centsToDollars(10_196)).toBe('101.96');
    });

    it('rounds exact ties half-even (banker’s rounding)', () => {
      expect(centsToDollars('10150.5')).toBe('101.50');
      expect(centsToDollars('10151.5')).toBe('101.52');
    });

    it('rounds once, from the exact value', () => {
      // Pre-rounding to fewer decimals would turn this into a tie and give 101.50.
      expect(centsToDollars('10150.5000000001')).toBe('101.51');
    });
  });

  it('leaves the global Decimal configuration untouched', () => {
    expect(Decimal.precision).toBe(20);
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_UP);
  });
});
