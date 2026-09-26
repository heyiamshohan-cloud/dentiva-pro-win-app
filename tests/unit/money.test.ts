import { describe, it, expect } from 'vitest';
import { parsePaisa, formatPaisa, percentOf, computeInvoice } from '../../src/shared/money';

describe('money: parsePaisa', () => {
  it('parses whole amounts', () => { expect(parsePaisa('1234')).toBe(123400); });
  it('parses decimals', () => { expect(parsePaisa('12.34')).toBe(1234); });
  it('parses single decimal place', () => { expect(parsePaisa('12.3')).toBe(1230); });
  it('parses with separators and symbols', () => { expect(parsePaisa('৳1,234.50')).toBe(123450); });
  it('parses zero', () => { expect(parsePaisa('0')).toBe(0); });
  it('parses negative', () => { expect(parsePaisa('-50.25')).toBe(-5025); });
  it('rejects garbage', () => { expect(() => parsePaisa('abc')).toThrow(); });
  it('rejects >2dp', () => { expect(() => parsePaisa('1.234')).toThrow(); });
  it('rejects empty', () => { expect(() => parsePaisa('  ')).toThrow(); });
  it('rejects multiple dots', () => { expect(() => parsePaisa('1.2.3')).toThrow(); });
  it('number input converts via deterministic rounding', () => { expect(parsePaisa(12.34)).toBe(1234); expect(parsePaisa(0.1 + 0.2)).toBe(30); });
});

describe('money: formatPaisa', () => {
  it('formats positive', () => { expect(formatPaisa(123450)).toBe('1,234.50'); });
  it('formats with symbol', () => { expect(formatPaisa(123450, 'Tk ')).toBe('Tk 1,234.50'); });
  it('formats negative', () => { expect(formatPaisa(-5025)).toBe('-50.25'); });
  it('formats zero', () => { expect(formatPaisa(0)).toBe('0.00'); });
  it('round-trips', () => { expect(parsePaisa(formatPaisa(987654321))).toBe(987654321); });
});

describe('money: percentOf (deterministic half-up)', () => {
  it('15% of 10000', () => { expect(percentOf(10000, 1500)).toBe(1500); });
  it('rounds half up', () => { expect(percentOf(1, 5000)).toBe(1); }); // 0.5 → 1
  it('rounds below half down', () => { expect(percentOf(999, 5)).toBe(0); }); // 49.95/100... check: 999*5/10000=0.4995 → 0
  it('no float drift on odd values', () => { expect(percentOf(333, 1500)).toBe(50); }); // 49.95 → 50
  it('handles large amounts via BigInt', () => { expect(percentOf(Number.MAX_SAFE_INTEGER - 1, 1500)).toBe(Math.round((Number.MAX_SAFE_INTEGER - 1) * 0.15)); });
});

describe('money: computeInvoice (invoice equation)', () => {
  it('subtotal - discount + tax = total', () => {
    const r = computeInvoice({
      lines: [{ qty: 2, unitPricePaisa: 150000 }, { qty: 1, unitPricePaisa: 50000, discountPaisa: 5000 }],
      discountPaisa: 10000, taxBp: 1500,
    });
    expect(r.lineTotals).toEqual([300000, 45000]);
    expect(r.subtotalPaisa).toBe(345000);
    expect(r.totalPaisa).toBe(r.subtotalPaisa - r.discountPaisa + r.taxPaisa);
    expect(r.taxPaisa).toBe(percentOf(335000, 1500)); // 50250
    expect(r.totalPaisa).toBe(385250);
  });
  it('rejects discount above subtotal', () => {
    expect(() => computeInvoice({ lines: [{ qty: 1, unitPricePaisa: 100 }], discountPaisa: 200 })).toThrow();
  });
  it('rejects negative line discount overflow', () => {
    expect(() => computeInvoice({ lines: [{ qty: 1, unitPricePaisa: 100, discountPaisa: 101 }] })).toThrow();
  });
  it('rejects non-positive qty', () => {
    expect(() => computeInvoice({ lines: [{ qty: 0, unitPricePaisa: 100 }] })).toThrow();
  });
  it('absolute tax override works', () => {
    const r = computeInvoice({ lines: [{ qty: 1, unitPricePaisa: 1000 }], taxPaisa: 99 });
    expect(r.totalPaisa).toBe(1099);
  });
});
