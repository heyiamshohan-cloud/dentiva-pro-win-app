// Dentiva Pro - prescription service (clinical document only - never contains financial data).
import { err } from '../../shared/errors';
import { uuid, prescriptionNo } from '../../shared/ids';
import { nowIso } from '../../shared/dates';
import { Page, makePage } from '../../shared/validation/common';
import { PrescriptionInput } from '../../shared/validation/clinical';
import { Ctx, tx } from './context';
import { nextSeq } from '../db/connection';
import { getPatient } from './patients';

export interface PrescriptionRow {
  id: string; rx_no: string; patient_id: string; visit_id: string | null; dentist_id: string | null;
  date: string; cc: string; oe: string; re: string; advice: string; follow_up_date: string | null;
  finalized_at: string | null; version: number; created_at: string; updated_at: string;
}

function insertItems(ctx: Ctx, rxId: string, items: PrescriptionInput['items']): void {
  const stmt = ctx.db.prepare(
    `INSERT INTO prescription_items(id, rx_id, drug_name, strength, dose, frequency, duration, route, instructions, seq)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  items.forEach((it, i) => {
    stmt.run(uuid(), rxId, it.drugName, it.strength, it.dose, it.frequency, it.duration, it.route || 'oral', it.instructions, i);
  });
}

export interface RxItemRow {
  id: string; rx_id: string; drug_name: string; strength: string; dose: string;
  frequency: string; duration: string; route: string; instructions: string; seq: number;
}

export function getPrescription(ctx: Ctx, id: string) {
  const rx = ctx.db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(id) as PrescriptionRow | undefined;
  if (!rx) return null;
  const items = ctx.db.prepare('SELECT * FROM prescription_items WHERE rx_id = ? ORDER BY seq').all(id) as RxItemRow[];
  const p = ctx.db.prepare('SELECT name, code, gender, dob FROM patients WHERE id = ?').get(rx.patient_id) as { name: string; code: string; gender: string | null; dob: string | null };
  return { ...rx, cc: JSON.parse(rx.cc) as string[], oe: JSON.parse(rx.oe) as string[], items, patient: p };
}

export function createPrescription(ctx: Ctx, input: PrescriptionInput) {
  if (!getPatient(ctx, input.patientId)) throw err.notFound('Patient');
  if (input.visitId) {
    const v = ctx.db.prepare('SELECT id FROM visits WHERE id = ? AND patient_id = ?').get(input.visitId, input.patientId);
    if (!v) throw err.validation('The linked visit does not belong to this patient.');
  }
  return tx(ctx.db, () => {
    const id = uuid();
    const no = prescriptionNo(nextSeq(ctx.db, 'prescription'));
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO prescriptions(id, rx_no, patient_id, visit_id, dentist_id, date, cc, oe, re, advice, follow_up_date,
          finalized_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, no, input.patientId, input.visitId, input.dentistId, now, JSON.stringify(input.cc), JSON.stringify(input.oe),
        input.re, input.advice, input.followUpDate, input.finalize ? now : null, now, now);
    insertItems(ctx, id, input.items);
    ctx.audit('prescriptions.create', 'prescriptions', id, { rxNo: no, patientId: input.patientId, finalized: input.finalize });
    return getPrescription(ctx, id);
  });
}

export function updatePrescription(ctx: Ctx, input: PrescriptionInput & { id: string }) {
  const existing = ctx.db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(input.id) as PrescriptionRow | undefined;
  if (!existing) throw err.notFound('Prescription');
  if (existing.finalized_at && !input.finalize) throw err.invalidState('A finalized prescription cannot be reopened. Create a new prescription instead.');
  if (existing.finalized_at) {
    // Finalized documents are immutable by design: edits create audit-visible version bumps only for corrections
    // BEFORE printing distribution. We block edits entirely to guarantee document integrity.
    throw err.invalidState('This prescription has been finalized and can no longer be edited. Create a corrected prescription for the patient instead.');
  }
  return tx(ctx.db, () => {
    ctx.db
      .prepare('UPDATE prescriptions SET cc=?, oe=?, re=?, advice=?, follow_up_date=?, finalized_at=?, version=version+1, updated_at=? WHERE id=?')
      .run(JSON.stringify(input.cc), JSON.stringify(input.oe), input.re, input.advice, input.followUpDate,
        input.finalize ? nowIso() : null, nowIso(), input.id);
    ctx.db.prepare('DELETE FROM prescription_items WHERE rx_id = ?').run(input.id);
    insertItems(ctx, input.id, input.items);
    ctx.audit('prescriptions.update', 'prescriptions', input.id, { rxNo: existing.rx_no, finalized: input.finalize });
    return getPrescription(ctx, input.id);
  });
}

export function listPrescriptions(ctx: Ctx, q: { patientId?: string; page: number; pageSize: number }): Page<unknown> {
  const where = q.patientId ? 'WHERE r.patient_id = @pid' : '';
  const params = q.patientId ? { pid: q.patientId } : {};
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM prescriptions r ${where}`).get(params) as { c: number }).c;
  const rows = ctx.db
    .prepare(
      `SELECT r.id, r.rx_no, r.date, r.finalized_at, r.visit_id, p.name AS patient_name, p.code AS patient_code,
              (SELECT COUNT(*) FROM prescription_items i WHERE i.rx_id = r.id) AS item_count
       FROM prescriptions r JOIN patients p ON p.id = r.patient_id
       ${where} ORDER BY r.created_at DESC, r.id LIMIT @lim OFFSET @off`,
    )
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize });
  return makePage(rows, total, q.page, q.pageSize);
}
