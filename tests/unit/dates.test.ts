import { describe, it, expect } from 'vitest';
import { clinicLocalToIso, clinicDay, ageOn, isValidDateStr, monthRange, addDays, formatDate } from '../../src/shared/dates';

const TZ = 'Asia/Dhaka';

describe('dates: clinicLocalToIso / clinicDay round-trip', () => {
  it('converts clinic time to UTC correctly (+06:00, no DST)', () => {
    expect(clinicLocalToIso('2026-03-15', '10:30', TZ)).toBe('2026-03-15T04:30:00.000Z');
  });
  it('clinicDay shows the clinic-calendar date even when UTC is previous day', () => {
    // 00:30 in Dhaka = 18:30 UTC the day before
    const iso = clinicLocalToIso('2026-03-15', '00:30', TZ);
    expect(iso).toBe('2026-03-14T18:30:00.000Z');
    expect(clinicDay(iso, TZ)).toBe('2026-03-15');
  });
  it('round-trips midnight boundary', () => {
    for (const t of ['00:00', '06:00', '23:59', '12:00']) {
      expect(clinicDay(clinicLocalToIso('2026-12-31', t, TZ), TZ)).toBe('2026-12-31');
    }
  });
  it('rejects invalid input', () => {
    expect(() => clinicLocalToIso('2026-13-01', '10:00', TZ)).toThrow();
    expect(() => clinicLocalToIso('2026-01-01', '25:00', TZ)).toThrow();
  });
});

describe('dates: validators', () => {
  it('validates real dates only', () => {
    expect(isValidDateStr('2026-02-28')).toBe(true);
    expect(isValidDateStr('2026-02-30')).toBe(false);
    expect(isValidDateStr('2026-13-01')).toBe(false);
    expect(isValidDateStr('15-02-2026')).toBe(false);
    expect(isValidDateStr('')).toBe(false);
  });
});

describe('dates: ageOn', () => {
  it('computes age relative to clinic today', () => {
    const today = new Date();
    const dob = `${today.getUTCFullYear() - 30}-01-01`;
    const age = ageOn(dob, TZ);
    expect(age === 29 || age === 30).toBe(true);
  });
  it('returns null for future/absurd dates', () => {
    expect(ageOn('2999-01-01', TZ)).toBeNull();
  });
});

describe('dates: ranges', () => {
  it('monthRange crosses year boundary', () => {
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2027-01-01' });
  });
  it('addDays works across months', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('formatDate renders stably', () => {
    expect(formatDate('2026-03-05T10:00:00.000Z', 'UTC')).toBe('05 Mar 2026');
  });
});
