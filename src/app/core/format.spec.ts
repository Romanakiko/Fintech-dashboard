import { UNAVAILABLE, formatImbalance, formatMoney, formatQuantity } from './format';

describe('format', () => {
  describe('formatMoney', () => {
    it('formats integer cents as USD', () => {
      expect(formatMoney(10_200)).toBe('$102.00');
      expect(formatMoney(4)).toBe('$0.04');
      expect(formatMoney(123_456_789)).toBe('$1,234,567.89');
    });

    it('formats exact decimal cents, rounding only here', () => {
      expect(formatMoney('10150')).toBe('$101.50');
      expect(formatMoney('10150.3333333333')).toBe('$101.50');
      expect(formatMoney('10150.5000000001')).toBe('$101.51');
    });

    it('shows unavailable values', () => {
      expect(formatMoney(null)).toBe(UNAVAILABLE);
    });
  });

  describe('formatImbalance', () => {
    it('shows a signed value with two decimals', () => {
      expect(formatImbalance(0.2)).toBe('+0.20');
      expect(formatImbalance(-0.35)).toBe('-0.35');
      expect(formatImbalance(1)).toBe('+1.00');
      expect(formatImbalance(-1)).toBe('-1.00');
    });

    it('shows no sign for values that round to zero', () => {
      expect(formatImbalance(0)).toBe('0.00');
      expect(formatImbalance(-0.004)).toBe('0.00');
    });

    it('shows unavailable values', () => {
      expect(formatImbalance(null)).toBe(UNAVAILABLE);
    });
  });

  describe('formatQuantity', () => {
    it('groups thousands', () => {
      expect(formatQuantity(0)).toBe('0');
      expect(formatQuantity(40)).toBe('40');
      expect(formatQuantity(1_234_567)).toBe('1,234,567');
    });

    it('shows unavailable values', () => {
      expect(formatQuantity(null)).toBe(UNAVAILABLE);
    });
  });
});
