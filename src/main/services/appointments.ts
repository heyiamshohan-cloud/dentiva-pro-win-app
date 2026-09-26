// Dentiva Pro - appointments & queue services.
import { err } from '../../shared/errors';
import { uuid } from '../../shared/ids';
import { nowIso, clinicLocalToIso, todayClinic, addDays as addDaysStr } from '../../shared/dates';
import { makePage } from '../../shared/validation/common';
import { AppointmentInput, AppointmentListQuery, CalendarQuery } from '../../shared/validation/scheduling';
import { AppointmentStatus } from '../../shared/constants';
import { Ctx, tx } from './context';
import { nextSeq } from '../db/connection';
import { getPatient } from './patients';

export interface AppointmentRow {
  id: string; patient_id: string; dentist_id: string | null; chair: string; starts_at: string; ends_at: string;
  type: string; status: string; reason: string; notes: string; version: number; created_at: string; updated_at: string;
  patient_name?: string; patient_code?: string;
}

function timesFor(ctx: Ctx, input: AppointmentInput): { startsAt: string; endsAt: string } {
  const tz = ctx.clinic().timezone;
  const startsAt = clinicLocalToIso(input.date, input.startTime, tz);
  const endsAt = new Date(new Date(startsAt).getTime() + input.durationMin * 60_000).toISOString();
  return { startsAt, endsAt };
}

/** Overlap check for the same dentist or same chair among active appointments. */
function findConflict(ctx: Ctx, startsAt: string, endsAt: string, dentistId: string | null, chair: string, excludeId?: string): { id: string; starts_at: string; patient_name: string } | null {
  const row = ctx.db
    .prepare(
      `SELECT a.id, a.starts_at, p.name AS patient_name FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.status NOT IN ('cancelled','no_show')
         AND a.starts_at < @end AND a.ends_at > @start
         AND ((@dentist IS NOT NULL AND a.dentist_id = @dentist)
              OR (@chair <> '' AND a.chair = @chair AND a.chair <> ''))
         ${excludeId ? 'AND a.id != @exclude' : ''}
       ORDER BY a.starts_at LIMIT 1`,
    )
    .get({ start: startsAt, end: endsAt, dentist: dentistId, chair: chair ?? '', ...(excludeId ? { exclude: excludeId } : {}) }) as
    { id: string; starts_at: string; patient_name: string } | undefined;
  return row ?? null;
}

export function createAppointment(ctx: Ctx, input: AppointmentInput): AppointmentRow {
  if (!getPatient(ctx, input.patientId)) throw err.notFound('Patient');
  const { startsAt, endsAt } = timesFor(ctx, input);
  if (new Date(endsAt) <= new Date(startsAt)) throw err.validation('The appointment end time must be after its start time.');
  return tx(ctx.db, () => {
    const conflict = findConflict(ctx, startsAt, endsAt, input.dentistId, input.chair);
    if (conflict) {
      throw err.conflict(
        `This time overlaps an existing appointment for ${conflict.patient_name} at ${conflict.starts_at.slice(11, 16)}. Choose a different time or resource.`,
        { conflictId: conflict.id },
      );
    }
    const id = uuid();
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO appointments(id, patient_id, dentist_id, chair, starts_at, ends_at, type, status, reason, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'scheduled', ?,?,?,?)`,
      )
      .run(id, input.patientId, input.dentistId, input.chair, startsAt, endsAt, input.type, input.reason, input.notes, now, now);
    ctx.audit('appointments.create', 'appointments', id, { patientId: input.patientId, startsAt });
    return getAppointment(ctx, id)!;
  });
}

export function updateAppointment(ctx: Ctx, input: AppointmentInput & { id: string }): AppointmentRow {
  const existing = ctx.db.prepare('SELECT * FROM appointments WHERE id = ?').get(input.id) as AppointmentRow | undefined;
  if (!existing) throw err.notFound('Appointment');
  if (['completed', 'cancelled', 'no_show'].includes(existing.status)) {
    throw err.invalidState(`A ${existing.status.replace('_', '-')} appointment cannot be edited.`);
  }
  const { startsAt, endsAt } = timesFor(ctx, input);
  return tx(ctx.db, () => {
    const conflict = findConflict(ctx, startsAt, endsAt, input.dentistId, input.chair, input.id);
    if (conflict) {
      throw err.conflict(`This time overlaps an existing appointment for ${conflict.patient_name}. Choose a different time or resource.`, { conflictId: conflict.id });
    }
    ctx.db
      .prepare(
        `UPDATE appointments SET patient_id=?, dentist_id=?, chair=?, starts_at=?, ends_at=?, type=?, reason=?, notes=?,
         version=version+1, updated_at=? WHERE id=?`,
      )
      .run(input.patientId, input.dentistId, input.chair, startsAt, endsAt, input.type, input.reason, input.notes, nowIso(), input.id);
    ctx.audit('appointments.update', 'appointments', input.id, {});
    return getAppointment(ctx, input.id)!;
  });
}

const VALID_STATUS_TRANSITIONS: Record<string, AppointmentStatus[]> = {
  scheduled: ['confirmed', 'arrived', 'cancelled', 'no_show', 'rescheduled'],
  confirmed: ['arrived', 'cancelled', 'no_show', 'rescheduled'],
  arrived: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [], cancelled: [], no_show: [], rescheduled: ['scheduled', 'confirmed', 'cancelled'],
};

export function setAppointmentStatus(ctx: Ctx, id: string, status: AppointmentStatus): void {
  const existing = ctx.db.prepare('SELECT status FROM appointments WHERE id = ?').get(id) as { status: string } | undefined;
  if (!existing) throw err.notFound('Appointment');
  if (!VALID_STATUS_TRANSITIONS[existing.status]?.includes(status)) {
    throw err.invalidState(`An appointment that is ${existing.status.replace('_', ' ')} cannot be moved to ${status.replace('_', ' ')}.`);
  }
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE appointments SET status=?, version=version+1, updated_at=? WHERE id=?').run(status, nowIso(), id);
    ctx.audit('appointments.status', 'appointments', id, { status });
  });
}

export function getAppointment(ctx: Ctx, id: string): AppointmentRow | null {
  return (ctx.db
    .prepare('SELECT a.*, p.name AS patient_name, p.code AS patient_code FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?')
    .get(id) as AppointmentRow | undefined) ?? null;
}

export function listAppointments(ctx: Ctx, q: AppointmentListQuery) {
  const tz = ctx.clinic().timezone;
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.from) { where.push('a.ends_at > @from'); params.from = clinicLocalToIso(q.from, '00:00', tz); }
  if (q.to) { where.push('a.starts_at < @to'); params.to = clinicLocalToIso(addDaysStr(q.to, 1), '00:00', tz); }
  if (q.dentistId) { where.push('a.dentist_id = @dentist'); params.dentist = q.dentistId; }
  if (q.patientId) { where.push('a.patient_id = @pid'); params.pid = q.patientId; }
  if (q.status) { where.push('a.status = @status'); params.status = q.status; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM appointments a ${whereSql}`).get(params) as { c: number }).c;
  const rows = ctx.db
    .prepare(
      `SELECT a.*, p.name AS patient_name, p.code AS patient_code
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       ${whereSql} ORDER BY a.starts_at DESC, a.id LIMIT @lim OFFSET @off`,
    )
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize }) as AppointmentRow[];
  return makePage(rows, total, q.page, q.pageSize);
}

/** Calendar window fetch - bounded by range (day/week/month views), not by hidden row limits. */
export function calendarAppointments(ctx: Ctx, q: CalendarQuery): AppointmentRow[] {
  const tz = ctx.clinic().timezone;
  const params: Record<string, unknown> = {
    from: clinicLocalToIso(q.from, '00:00', tz),
    to: clinicLocalToIso(addDaysStr(q.to, 1), '00:00', tz),
  };
  let dentist = '';
  if (q.dentistId) { dentist = 'AND a.dentist_id = @dentist'; params.dentist = q.dentistId; }
  return ctx.db
    .prepare(
      `SELECT a.*, p.name AS patient_name, p.code AS patient_code
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.ends_at > @from AND a.starts_at < @to ${dentist}
       ORDER BY a.starts_at`,
    )
    .all(params) as AppointmentRow[];
}

// ---- queue ----

export function queueList(ctx: Ctx, date?: string) {
  const day = date ?? todayClinic(ctx.clinic().timezone);
  const entries = ctx.db
    .prepare(
      `SELECT q.*, p.name AS patient_name, p.code AS patient_code
       FROM queue_entries q JOIN patients p ON p.id = q.patient_id
       WHERE q.day = ? ORDER BY q.serial`,
    )
    .all(day);
  return { day, entries };
}

export function queueAdd(ctx: Ctx, input: { patientId: string; appointmentId: string | null; dentistId: string | null; date?: string }) {
  if (!getPatient(ctx, input.patientId)) throw err.notFound('Patient');
  const day = input.date ?? todayClinic(ctx.clinic().timezone);
  if (input.appointmentId) {
    const a = ctx.db.prepare('SELECT id, patient_id FROM appointments WHERE id = ?').get(input.appointmentId) as { id: string; patient_id: string } | undefined;
    if (!a) throw err.notFound('Appointment');
    if (a.patient_id !== input.patientId) throw err.validation('The appointment belongs to a different patient.');
  }
  return tx(ctx.db, () => {
    const existing = ctx.db
      .prepare("SELECT id, serial FROM queue_entries WHERE day = ? AND patient_id = ? AND status NOT IN ('completed','skipped')")
      .get(day, input.patientId) as { id: string; serial: number } | undefined;
    if (existing) throw err.duplicate(`This patient is already in today's queue at serial ${existing.serial}.`);
    const serial = nextSeq(ctx.db, `queue:${day}`);
    const id = uuid();
    const now = nowIso();
    ctx.db
      .prepare('INSERT INTO queue_entries(id, day, serial, patient_id, appointment_id, dentist_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, day, serial, input.patientId, input.appointmentId, input.dentistId, 'waiting', now, now);
    ctx.audit('queue.add', 'queue_entries', id, { day, serial, patientId: input.patientId });
    return { id, serial, day };
  });
}

const QUEUE_TRANSITIONS: Record<string, string[]> = {
  waiting: ['called', 'skipped', 'completed'],
  called: ['in_treatment', 'skipped', 'waiting'],
  in_treatment: ['completed', 'skipped'],
  skipped: ['waiting', 'completed'],
  completed: [],
};

export function queueSetStatus(ctx: Ctx, id: string, status: string): void {
  const entry = ctx.db.prepare('SELECT day, serial, status FROM queue_entries WHERE id = ?').get(id) as { day: string; serial: number; status: string } | undefined;
  if (!entry) throw err.notFound('Queue entry');
  if (!QUEUE_TRANSITIONS[entry.status]?.includes(status)) {
    throw err.invalidState(`A queue entry that is ${entry.status.replace('_', ' ')} cannot move to ${status.replace('_', ' ')}.`);
  }
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE queue_entries SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
    ctx.audit('queue.status', 'queue_entries', id, { day: entry.day, serial: entry.serial, status });
  });
}

export function queueRemove(ctx: Ctx, id: string): void {
  const entry = ctx.db.prepare('SELECT day, serial, status FROM queue_entries WHERE id = ?').get(id) as { status: string } | undefined;
  if (!entry) throw err.notFound('Queue entry');
  if (entry.status === 'in_treatment') throw err.invalidState('A patient currently in treatment cannot be removed from the queue.');
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM queue_entries WHERE id = ?').run(id);
    ctx.audit('queue.remove', 'queue_entries', id, {});
  });
}

export function appointmentsForDay(ctx: Ctx, day: string) {
  return calendarAppointments(ctx, { from: day, to: day });
}
