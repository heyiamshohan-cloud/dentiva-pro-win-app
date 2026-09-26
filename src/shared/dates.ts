// Dentiva Pro - timezone-aware date/time helpers. Storage: ISO-8601 UTC strings.
// Clinic-local presentation uses the configured clinic timezone (default Asia/Dhaka).

import { DEFAULT_TIMEZONE, DATE_FMT } from './constants';

export function nowIso(): string {
  return new Date().toISOString();
}

export function isValidIso(s: unknown): s is string {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

export function isValidDateStr(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_FMT.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Clinic-local calendar date (YYYY-MM-DD) of an ISO timestamp in the clinic timezone. */
export function clinicDay(iso: string, tz: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export function todayClinic(tz: string = DEFAULT_TIMEZONE): string {
  return clinicDay(nowIso(), tz);
}

export function formatDate(iso: string | null | undefined, tz: string = DEFAULT_TIMEZONE): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

export function formatTime(iso: string | null | undefined, tz: string = DEFAULT_TIMEZONE): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(d);
}

export function formatDateTime(iso: string | null | undefined, tz: string = DEFAULT_TIMEZONE): string {
  if (!iso) return '';
  return `${formatDate(iso, tz)} ${formatTime(iso, tz)}`.trim();
}

/** "YYYY-MM-DD" + "HH:mm" (clinic local) -> ISO UTC instant. Uses Intl round-trip, DST-safe. */
export function clinicLocalToIso(date: string, time: string, tz: string = DEFAULT_TIMEZONE): string {
  if (!isValidDateStr(date)) throw new Error(`Invalid date: ${date}`);
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`Invalid time: ${time}`);
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  if (h! > 23 || mi! > 59) throw new Error(`Invalid time: ${time}`);
  // Iterative offset resolution: guess UTC, measure local parts, adjust.
  let guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    const desired = Date.UTC(y!, mo! - 1, d!, h!, mi!);
    const diff = desired - localAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess).toISOString();
}

export function addDays(dateStr: string, days: number): string {
  if (!isValidDateStr(dateStr)) throw new Error(`Invalid date: ${dateStr}`);
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ageOn(dobIsoOrDate: string, tz: string = DEFAULT_TIMEZONE): number | null {
  const dob = dobIsoOrDate.length === 10 ? dobIsoOrDate : clinicDay(dobIsoOrDate, tz);
  if (!isValidDateStr(dob)) return null;
  const today = todayClinic(tz);
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let age = ty! - by!;
  if (tm! < bm! || (tm! === bm! && td! < bd!)) age -= 1;
  return age >= 0 && age <= 150 ? age : null;
}

export function monthRange(month: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Invalid month: ${month}`);
  const [y, m] = month.split('-').map(Number);
  const to = `${m === 12 ? y! + 1 : y}-${String(m === 12 ? 1 : m! + 1).padStart(2, '0')}-01`;
  return { from: `${month}-01`, to };
}
