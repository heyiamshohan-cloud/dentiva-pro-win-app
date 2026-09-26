// Dentiva Pro - treatment catalog & treatment plans service.
import { err } from '../../shared/errors';
import { uuid } from '../../shared/ids';
import { nowIso } from '../../shared/dates';
import { Page, makePage } from '../../shared/validation/common';
import { TreatmentInput, TreatmentListQuery, PlanInput } from '../../shared/validation/clinical';
import { Ctx, tx } from './context';
import { getPatient } from './patients';
import { createVisit } from './visits';

export interface TreatmentRow {
  id: string; name: string; category: string; description: string; duration_min: number;
  price_paisa: number; active: number; clinical_notes: string; created_at: string; updated_at: string;
}

export function listTreatments(ctx: Ctx, q: TreatmentListQuery): Page<TreatmentRow> {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (!q.includeInactive) where.push('active = 1');
  if (q.q) { where.push('(name LIKE @q OR description LIKE @q)'); params.q = `%${q.q}%`; }
  if (q.category) { where.push('category = @cat'); params.cat = q.category; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM treatments ${whereSql}`).get(params) as { c: number }).c;
  const rows = ctx.db
    .prepare(`SELECT * FROM treatments ${whereSql} ORDER BY category, name LIMIT @lim OFFSET @off`)
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize }) as TreatmentRow[];
  return makePage(rows, total, q.page, q.pageSize);
}

export function createTreatment(ctx: Ctx, input: TreatmentInput): { id: string } {
  return tx(ctx.db, () => {
    const id = uuid();
    try {
      ctx.db
        .prepare(
          `INSERT INTO treatments(id, name, category, description, duration_min, price_paisa, active, clinical_notes, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, input.name, input.category, input.description, input.durationMin, input.pricePaisa, input.active ? 1 : 0, input.clinicalNotes, nowIso(), nowIso());
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw err.duplicate(`A treatment named "${input.name}" already exists.`);
      throw e;
    }
    ctx.audit('treatments.create', 'treatments', id, { name: input.name });
    return { id };
  });
}

export function updateTreatment(ctx: Ctx, input: TreatmentInput & { id: string }): void {
  const existing = ctx.db.prepare('SELECT id FROM treatments WHERE id = ?').get(input.id);
  if (!existing) throw err.notFound('Treatment');
  tx(ctx.db, () => {
    try {
      ctx.db
        .prepare('UPDATE treatments SET name=?, category=?, description=?, duration_min=?, price_paisa=?, active=?, clinical_notes=?, updated_at=? WHERE id=?')
        .run(input.name, input.category, input.description, input.durationMin, input.pricePaisa, input.active ? 1 : 0, input.clinicalNotes, nowIso(), input.id);
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw err.duplicate(`A treatment named "${input.name}" already exists.`);
      throw e;
    }
    ctx.audit('treatments.update', 'treatments', input.id, { name: input.name });
  });
}

// ---- treatment plans ----

export function listPlans(ctx: Ctx, patientId: string) {
  const plans = ctx.db
    .prepare('SELECT * FROM treatment_plans WHERE patient_id = ? ORDER BY created_at DESC')
    .all(patientId) as Record<string, unknown>[];
  const itemsStmt = ctx.db.prepare('SELECT * FROM treatment_plan_items WHERE plan_id = ? ORDER BY seq, rowid');
  return plans.map((p) => ({ ...p, items: itemsStmt.all(p.id as string) }));
}

export function createPlan(ctx: Ctx, input: PlanInput): { id: string } {
  if (!getPatient(ctx, input.patientId)) throw err.notFound('Patient');
  for (const it of input.items) {
    if (it.treatmentId && !ctx.db.prepare('SELECT id FROM treatments WHERE id = ?').get(it.treatmentId)) throw err.notFound(`Treatment for "${it.name}"`);
  }
  return tx(ctx.db, () => {
    const id = uuid();
    const now = nowIso();
    ctx.db.prepare('INSERT INTO treatment_plans(id, patient_id, title, status, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.patientId, input.title, 'draft', input.notes, now, now);
    const stmt = ctx.db.prepare(
      'INSERT INTO treatment_plan_items(id, plan_id, treatment_id, name, tooth, qty, est_price_paisa, seq) VALUES (?,?,?,?,?,?,?,?)',
    );
    input.items.forEach((it, i) => stmt.run(uuid(), id, it.treatmentId, it.name, it.tooth, it.qty, it.estPricePaisa, it.seq || i));
    ctx.audit('plans.create', 'treatment_plans', id, { patientId: input.patientId, title: input.title });
    return { id };
  });
}

export function setPlanStatus(ctx: Ctx, id: string, status: 'draft' | 'proposed' | 'accepted' | 'rejected' | 'completed'): void {
  const plan = ctx.db.prepare('SELECT * FROM treatment_plans WHERE id = ?').get(id) as { id: string; status: string } | undefined;
  if (!plan) throw err.notFound('Treatment plan');
  const allowed: Record<string, string[]> = {
    draft: ['proposed', 'rejected'], proposed: ['accepted', 'rejected', 'draft'],
    accepted: ['completed', 'rejected'], rejected: ['draft'], completed: [],
  };
  if (!allowed[plan.status]?.includes(status)) {
    throw err.invalidState(`A ${plan.status} plan cannot move directly to ${status}.`);
  }
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE treatment_plans SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
    ctx.audit('plans.status', 'treatment_plans', id, { status });
  });
}

/** Explicit conversion of plan items into a visit's procedures. Never auto-bills. */
export function convertPlanItems(ctx: Ctx, planId: string, itemIds: string[], visitId: string | null): { converted: number; visitId: string } {
  const plan = ctx.db.prepare('SELECT * FROM treatment_plans WHERE id = ?').get(planId) as { id: string; patient_id: string; status: string } | undefined;
  if (!plan) throw err.notFound('Treatment plan');
  if (plan.status !== 'accepted') throw err.invalidState('Only an accepted treatment plan can be converted into treatment.');
  let targetVisit = visitId;
  if (targetVisit) {
    const v = ctx.db.prepare('SELECT id, patient_id FROM visits WHERE id = ?').get(targetVisit) as { id: string; patient_id: string } | undefined;
    if (!v) throw err.notFound('Visit');
    if (v.patient_id !== plan.patient_id) throw err.validation('The selected visit belongs to a different patient.');
  }
  return tx(ctx.db, () => {
    if (!targetVisit) {
      const v = createVisit(ctx, {
        patientId: plan.patient_id, dentistId: null, appointmentId: null, chiefComplaint: '', reason: 'Treatment plan conversion',
        symptoms: '', findings: '', diagnosis: '', notes: '', followUpDate: null, referral: '',
      });
      targetVisit = v.id;
    }
    const itemStmt = ctx.db.prepare("SELECT * FROM treatment_plan_items WHERE id = ? AND plan_id = ? AND status = 'planned'");
    const ins = ctx.db.prepare(
      `INSERT INTO visit_procedures(id, visit_id, treatment_id, name, tooth, surface, qty, price_paisa, anesthesia, notes, created_at)
       VALUES (?,?,?,?,?, '', ?, ?, '', ?, ?)`,
    );
    let converted = 0;
    for (const itemId of itemIds) {
      const item = itemStmt.get(itemId, planId) as { id: string; treatment_id: string | null; name: string; tooth: number | null; qty: number; est_price_paisa: number } | undefined;
      if (!item) continue;
      ins.run(uuid(), targetVisit, item.treatment_id, item.name, item.tooth, item.qty, item.est_price_paisa, 'From treatment plan', nowIso());
      ctx.db.prepare("UPDATE treatment_plan_items SET status = 'in_progress', visit_id = ? WHERE id = ?").run(targetVisit, itemId);
      converted += 1;
    }
    if (converted === 0) throw err.invalidState('No planned items remain to convert.');
    ctx.audit('plans.convert', 'treatment_plans', planId, { converted, visitId: targetVisit });
    return { converted, visitId: targetVisit! };
  });
}
