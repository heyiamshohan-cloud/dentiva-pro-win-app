// Dentiva Pro - dental chart service (FDI notation, adult & primary, full audit history).
import { err } from '../../shared/errors';
import { uuid } from '../../shared/ids';
import { nowIso } from '../../shared/dates';
import { ADULT_TEETH, PRIMARY_TEETH, TOOTH_STATES, ToothState, Dentition } from '../../shared/constants';
import { Ctx, tx } from './context';
import { getPatient } from './patients';

export interface ChartTooth {
  tooth: number;
  state: ToothState;
  notes: string;
  visitId: string | null;
  updatedAt: string | null;
}

export function getChart(ctx: Ctx, patientId: string, dentition: Dentition): { dentition: Dentition; teeth: ChartTooth[] } {
  if (!getPatient(ctx, patientId)) throw err.notFound('Patient');
  const rows = ctx.db
    .prepare('SELECT tooth, state, notes, visit_id, updated_at FROM dental_chart WHERE patient_id = ? AND dentition = ?')
    .all(patientId, dentition) as { tooth: number; state: ToothState; notes: string; visit_id: string | null; updated_at: string }[];
  const map = new Map(rows.map((r) => [r.tooth, r]));
  const all = dentition === 'adult' ? ADULT_TEETH : PRIMARY_TEETH;
  return {
    dentition,
    teeth: all.map((t) => {
      const r = map.get(t);
      return { tooth: t, state: r?.state ?? 'sound', notes: r?.notes ?? '', visitId: r?.visit_id ?? null, updatedAt: r?.updated_at ?? null };
    }),
  };
}

export function chartHistory(ctx: Ctx, patientId: string, limit = 200) {
  return ctx.db
    .prepare('SELECT * FROM dental_chart_history WHERE patient_id = ? ORDER BY changed_at DESC, id LIMIT ?')
    .all(patientId, limit);
}

export function setTooth(ctx: Ctx, input: { patientId: string; dentition: Dentition; tooth: number; state: ToothState; notes: string; visitId: string | null }): void {
  const valid = input.dentition === 'adult' ? ADULT_TEETH : PRIMARY_TEETH;
  if (!valid.includes(input.tooth)) throw err.validation(`Tooth ${input.tooth} is not a valid ${input.dentition} FDI tooth number.`);
  if (!TOOTH_STATES.includes(input.state)) throw err.validation('Invalid tooth state.');
  if (!getPatient(ctx, input.patientId)) throw err.notFound('Patient');
  tx(ctx.db, () => {
    const prev = ctx.db
      .prepare('SELECT state FROM dental_chart WHERE patient_id = ? AND dentition = ? AND tooth = ?')
      .get(input.patientId, input.dentition, input.tooth) as { state: string } | undefined;
    const prevState = prev?.state ?? 'sound';
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO dental_chart(patient_id, dentition, tooth, state, notes, visit_id, updated_at, updated_by)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(patient_id, dentition, tooth)
         DO UPDATE SET state = excluded.state, notes = excluded.notes, visit_id = excluded.visit_id,
                       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(input.patientId, input.dentition, input.tooth, input.state, input.notes, input.visitId, now, ctx.user?.id ?? null);
    ctx.db
      .prepare(
        `INSERT INTO dental_chart_history(id, patient_id, dentition, tooth, prev_state, new_state, notes, visit_id, changed_at, changed_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(uuid(), input.patientId, input.dentition, input.tooth, prevState, input.state, input.notes, input.visitId, now, ctx.user?.id ?? null);
    ctx.audit('chart.setTooth', 'patients', input.patientId, { tooth: input.tooth, from: prevState, to: input.state });
  });
}
