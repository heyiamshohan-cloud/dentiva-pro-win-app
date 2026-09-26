// Dentiva Pro - visits & procedures service.
import { err } from '../../shared/errors';
import { uuid, visitNo } from '../../shared/ids';
import { nowIso, clinicLocalToIso, addDays } from '../../shared/dates';
import { Page, makePage } from '../../shared/validation/common';
import { VisitInput, VisitListQuery } from '../../shared/validation/clinical';
import { Ctx, tx } from './context';
import { nextSeq } from '../db/connection';
import { getPatient } from './patients';

export interface VisitRow {
  id: string; visit_no: string; patient_id: string; dentist_id: string | null; appointment_id: string | null;
  started_at: string; chief_complaint: string; reason: string; symptoms: string; findings: string;
  diagnosis: string; notes: string; follow_up_date: string | null; referral: string;
  status: 'open' | 'completed' | 'cancelled'; version: number; created_at: string; updated_at: string;
}

export function getVisit(ctx: Ctx, id: string): (VisitRow & { procedures: unknown[]; patient_name?: string; patient_code?: string }) | null {
  const v = ctx.db.prepare('SELECT * FROM visits WHERE id = ?').get(id) as VisitRow | undefined;
  if (!v) return null;
  const procedures = ctx.db.prepare('SELECT * FROM visit_procedures WHERE visit_id = ? ORDER BY created_at').all(id);
  const p = ctx.db.prepare('SELECT name, code FROM patients WHERE id = ?').get(v.patient_id) as { name: string; code: string };
  return { ...v, procedures, patient_name: p.name, patient_code: p.code };
}

export function createVisit(ctx: Ctx, input: VisitInput): VisitRow {
  if (!getPatient(ctx, input.patientId)) throw err.notFound('Patient');
  return tx(ctx.db, () => {
    const id = uuid();
    const no = visitNo(nextSeq(ctx.db, 'visit'));
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO visits(id, visit_no, patient_id, dentist_id, appointment_id, started_at, chief_complaint, reason,
          symptoms, findings, diagnosis, notes, follow_up_date, referral, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
      )
      .run(id, no, input.patientId, input.dentistId, input.appointmentId, now, input.chiefComplaint, input.reason,
        input.symptoms, input.findings, input.diagnosis, input.notes, input.followUpDate, input.referral, now, now);
    ctx.audit('visits.create', 'visits', id, { visitNo: no, patientId: input.patientId });
    return getVisit(ctx, id) as unknown as VisitRow;
  });
}

export function updateVisit(ctx: Ctx, input: VisitInput & { id: string }): VisitRow {
  const existing = ctx.db.prepare('SELECT * FROM visits WHERE id = ?').get(input.id) as VisitRow | undefined;
  if (!existing) throw err.notFound('Visit');
  if (existing.status === 'cancelled') throw err.invalidState('A cancelled visit cannot be edited.');
  return tx(ctx.db, () => {
    ctx.db
      .prepare(
        `UPDATE visits SET dentist_id=?, chief_complaint=?, reason=?, symptoms=?, findings=?, diagnosis=?, notes=?,
         follow_up_date=?, referral=?, version=version+1, updated_at=? WHERE id=?`,
      )
      .run(input.dentistId, input.chiefComplaint, input.reason, input.symptoms, input.findings, input.diagnosis,
        input.notes, input.followUpDate, input.referral, nowIso(), input.id);
    ctx.audit('visits.update', 'visits', input.id, { visitNo: existing.visit_no, version: existing.version + 1 });
    return getVisit(ctx, input.id) as unknown as VisitRow;
  });
}

export function setVisitStatus(ctx: Ctx, id: string, status: 'open' | 'completed' | 'cancelled'): void {
  const existing = ctx.db.prepare('SELECT visit_no FROM visits WHERE id = ?').get(id) as { visit_no: string } | undefined;
  if (!existing) throw err.notFound('Visit');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE visits SET status=?, version=version+1, updated_at=? WHERE id=?').run(status, nowIso(), id);
    ctx.audit('visits.status', 'visits', id, { visitNo: existing.visit_no, status });
  });
}

export function addProcedure(ctx: Ctx, input: {
  visitId: string; treatmentId: string | null; name: string; tooth: number | null; surface: string;
  qty: number; pricePaisa: number; anesthesia: string; notes: string;
}): { id: string } {
  const visit = ctx.db.prepare('SELECT id, status FROM visits WHERE id = ?').get(input.visitId) as { id: string; status: string } | undefined;
  if (!visit) throw err.notFound('Visit');
  if (visit.status !== 'open') throw err.invalidState('Procedures can only be added to an open visit.');
  if (input.treatmentId) {
    const t = ctx.db.prepare('SELECT id FROM treatments WHERE id = ?').get(input.treatmentId);
    if (!t) throw err.notFound('Treatment');
  }
  return tx(ctx.db, () => {
    const id = uuid();
    ctx.db
      .prepare(
        `INSERT INTO visit_procedures(id, visit_id, treatment_id, name, tooth, surface, qty, price_paisa, anesthesia, notes, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, input.visitId, input.treatmentId, input.name, input.tooth, input.surface, input.qty, input.pricePaisa, input.anesthesia, input.notes, nowIso());
    ctx.audit('visits.procedure.add', 'visits', input.visitId, { name: input.name, tooth: input.tooth });
    return { id };
  });
}

export function removeProcedure(ctx: Ctx, id: string): void {
  const row = ctx.db.prepare('SELECT p.id, p.visit_id, v.status FROM visit_procedures p JOIN visits v ON v.id = p.visit_id WHERE p.id = ?')
    .get(id) as { id: string; visit_id: string; status: string } | undefined;
  if (!row) throw err.notFound('Procedure');
  if (row.status !== 'open') throw err.invalidState('Procedures can only be removed while the visit is open.');
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM visit_procedures WHERE id = ?').run(id);
    ctx.audit('visits.procedure.remove', 'visits', row.visit_id, {});
  });
}

export function listVisits(ctx: Ctx, q: VisitListQuery): Page<VisitRow & { patient_name: string; patient_code: string }> {
  const tz = ctx.clinic().timezone;
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.patientId) { where.push('v.patient_id = @pid'); params.pid = q.patientId; }
  if (q.from) { where.push('v.started_at >= @from'); params.from = clinicLocalToIso(q.from, '00:00', tz); }
  if (q.to) { where.push('v.started_at < @to'); params.to = clinicLocalToIso(addDays(q.to, 1), '00:00', tz); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM visits v ${whereSql}`).get(params) as { c: number }).c;
  const rows = ctx.db
    .prepare(
      `SELECT v.*, p.name AS patient_name, p.code AS patient_code
       FROM visits v JOIN patients p ON p.id = v.patient_id
       ${whereSql} ORDER BY v.started_at DESC, v.id LIMIT @lim OFFSET @off`,
    )
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize }) as (VisitRow & { patient_name: string; patient_code: string })[];
  return makePage(rows, total, q.page, q.pageSize);
}
