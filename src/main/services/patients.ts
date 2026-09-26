// Dentiva Pro - patient management service (stable codes, dedupe, 360, timeline, merge).
import { err } from '../../shared/errors';
import { uuid, patientCode } from '../../shared/ids';
import { nowIso } from '../../shared/dates';
import { Page, makePage } from '../../shared/validation/common';
import { PatientInput, PatientListQuery, MedicalItemInput } from '../../shared/validation/patients';
import { Ctx, tx } from './context';
import { nextSeq } from '../db/connection';

export function digits(s: string): string {
  return s.replace(/\D/g, '');
}

export interface PatientRow {
  id: string; code: string; name: string; title: string; gender: string | null; dob: string | null;
  phone: string; alt_phone: string; email: string; address: string;
  emergency_contact_name: string; emergency_contact_phone: string;
  occupation: string; referral_source: string; notes: string; custom_fields: string; blood_group: string;
  created_at: string; updated_at: string; archived_at: string | null; created_by: string | null;
}

function insertTags(ctx: Ctx, patientId: string, tags: string[]): void {
  const stmt = ctx.db.prepare('INSERT OR IGNORE INTO patient_tags(patient_id, tag) VALUES (?, ?)');
  for (const t of tags) stmt.run(patientId, t);
}

export function getTags(ctx: Ctx, patientId: string): string[] {
  return (ctx.db.prepare('SELECT tag FROM patient_tags WHERE patient_id = ? ORDER BY tag').all(patientId) as { tag: string }[]).map((r) => r.tag);
}

export function createPatient(ctx: Ctx, input: PatientInput): PatientRow {
  return tx(ctx.db, () => {
    const dupes = findDuplicates(ctx, {
      name: input.name, phone: input.phone, email: input.email, dob: input.dob ?? '',
    });
    // Hard-block only on exact phone match (when provided); others are surfaced as warnings by the UI
    // via patients.duplicates before submission.
    if (input.phone && dupes.some((d) => d.matchKinds.includes('phone'))) {
      const d = dupes.find((x) => x.matchKinds.includes('phone'))!;
      throw err.duplicate(
        `A patient with this phone number already exists: ${d.code} — ${d.name}. Open the existing record instead of creating a duplicate.`,
        { existingId: d.id },
      );
    }
    const id = uuid();
    const code = patientCode(nextSeq(ctx.db, 'patient'));
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO patients(id, code, name, name_lower, title, gender, dob, phone, phone_digits, alt_phone, email, email_lower,
          blood_group, address, emergency_contact_name, emergency_contact_phone, occupation, referral_source, notes, custom_fields,
          created_at, updated_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, code, input.name, input.name.toLowerCase(), input.title, input.gender, input.dob,
        input.phone, digits(input.phone), input.altPhone, input.email, input.email.toLowerCase(),
        input.bloodGroup, input.address, input.emergencyContactName, input.emergencyContactPhone, input.occupation,
        input.referralSource, input.notes, JSON.stringify(input.customFields), now, now, ctx.user?.id ?? null,
      );
    insertTags(ctx, id, input.tags);
    ctx.audit('patients.create', 'patients', id, { code });
    return getPatient(ctx, id)!;
  });
}

export function updatePatient(ctx: Ctx, input: PatientInput & { id: string }): PatientRow {
  const existing = getPatient(ctx, input.id);
  if (!existing) throw err.notFound('Patient');
  if (existing.archived_at) throw err.invalidState('Archived patients cannot be edited. Restore the record first.');
  return tx(ctx.db, () => {
    ctx.db
      .prepare(
        `UPDATE patients SET name=?, name_lower=?, title=?, gender=?, dob=?, phone=?, phone_digits=?, alt_phone=?,
          email=?, email_lower=?, blood_group=?, address=?, emergency_contact_name=?, emergency_contact_phone=?, occupation=?,
          referral_source=?, notes=?, custom_fields=?, updated_at=? WHERE id=?`,
      )
      .run(
        input.name, input.name.toLowerCase(), input.title, input.gender, input.dob, input.phone,
        digits(input.phone), input.altPhone, input.email, input.email.toLowerCase(), input.bloodGroup, input.address,
        input.emergencyContactName, input.emergencyContactPhone, input.occupation,
        input.referralSource, input.notes, JSON.stringify(input.customFields), nowIso(), input.id,
      );
    ctx.db.prepare('DELETE FROM patient_tags WHERE patient_id = ?').run(input.id);
    insertTags(ctx, input.id, input.tags);
    ctx.audit('patients.update', 'patients', input.id, { code: existing.code });
    return getPatient(ctx, input.id)!;
  });
}

export function archivePatient(ctx: Ctx, id: string): void {
  const p = getPatient(ctx, id);
  if (!p) throw err.notFound('Patient');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE patients SET archived_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
    ctx.audit('patients.archive', 'patients', id, { code: p.code });
  });
}

export function restorePatient(ctx: Ctx, id: string): void {
  const p = getPatient(ctx, id);
  if (!p) throw err.notFound('Patient');
  if (!p.archived_at) throw err.invalidState('Patient is not archived.');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE patients SET archived_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
    ctx.audit('patients.restore', 'patients', id, { code: p.code });
  });
}

/** Hard-delete is only permitted when the patient has zero clinical/financial history. */
export function deletePatient(ctx: Ctx, id: string): void {
  const p = getPatient(ctx, id);
  if (!p) throw err.notFound('Patient');
  const counts = ['visits', 'invoices', 'payments', 'appointments', 'queue_entries', 'prescriptions', 'treatment_plans', 'adjustments', 'attachments']
    .map((t) => ({ t, c: (ctx.db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE patient_id = ?`).get(id) as { c: number }).c }));
  const linked = counts.filter((x) => x.c > 0);
  if (linked.length > 0) {
    throw err.invalidState(
      `This patient has existing records (${linked.map((l) => `${l.c} ${l.t}`).join(', ')}). Archive the patient instead of deleting — clinical and financial history must be preserved.`,
    );
  }
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM patients WHERE id = ?').run(id);
    ctx.audit('patients.delete', 'patients', id, { code: p.code });
  });
}

export function getPatient(ctx: Ctx, id: string): PatientRow | null {
  const row = ctx.db.prepare('SELECT * FROM patients WHERE id = ?').get(id) as PatientRow | undefined;
  return row ?? null;
}

export function getPatientWithTags(ctx: Ctx, id: string): (PatientRow & { tags: string[] }) | null {
  const p = getPatient(ctx, id);
  if (!p) return null;
  return { ...p, tags: getTags(ctx, id) };
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

export function listPatients(ctx: Ctx, q: PatientListQuery): Page<PatientRow & { tags: string[] }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.archived) where.push('archived_at IS NOT NULL');
  else where.push('archived_at IS NULL');
  if (q.tag) { where.push('id IN (SELECT patient_id FROM patient_tags WHERE tag = ?)'); params.push(q.tag); }
  if (q.q) {
    const needle = `%${likeEscape(q.q.toLowerCase())}%`;
    const d = digits(q.q);
    where.push(`(name_lower LIKE ? ESCAPE '\\' OR code LIKE ? OR phone_digits LIKE ? OR email_lower LIKE ?)`);
    params.push(needle, `%${likeEscape(q.q)}%`, `%${d || likeEscape(q.q)}%`, needle);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortCol = { name: 'name_lower', code: 'code', created_at: 'created_at', phone: 'phone_digits' }[q.sortBy];
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM patients ${whereSql}`).get(...params) as { c: number }).c;
  const rows = ctx.db
    .prepare(`SELECT * FROM patients ${whereSql} ORDER BY ${sortCol} ${q.sortDir === 'desc' ? 'DESC' : 'ASC'}, id
              LIMIT ? OFFSET ?`)
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as PatientRow[];
  const tagStmt = ctx.db.prepare('SELECT tag FROM patient_tags WHERE patient_id = ? ORDER BY tag');
  const withTags = rows.map((r) => ({ ...r, tags: (tagStmt.all(r.id) as { tag: string }[]).map((t) => t.tag) }));
  return makePage(withTags, total, q.page, q.pageSize);
}

/** FTS-backed search (used by global search + patient picker). */
export function searchPatientsFts(ctx: Ctx, q: string, limit: number): { id: string; code: string; name: string; phone: string }[] {
  const cleaned = q.trim();
  if (!cleaned) return [];
  const exact = ctx.db
    .prepare('SELECT id, code, name, phone FROM patients WHERE (code = ? OR phone_digits = ?) AND archived_at IS NULL LIMIT 5')
    .all(cleaned, digits(cleaned)) as { id: string; code: string; name: string; phone: string }[];
  if (exact.length) return exact;
  const terms = cleaned.split(/\s+/).filter(Boolean).map((t) => `${t.replace(/[^\w+\-]/g, '')}*`).filter((t) => t.length > 1);
  if (!terms.length) return [];
  try {
    return ctx.db
      .prepare(
        `SELECT p.id, p.code, p.name, p.phone FROM patients_fts f
         JOIN patients p ON p.id = f.patient_id
         WHERE patients_fts MATCH ? AND p.archived_at IS NULL
         ORDER BY rank LIMIT ?`,
      )
      .all(terms.join(' '), limit) as { id: string; code: string; name: string; phone: string }[];
  } catch {
    return [];
  }
}

export interface DuplicateCandidate {
  id: string; code: string; name: string; phone: string; dob: string | null; email: string; matchKinds: string[];
}

export function findDuplicates(
  ctx: Ctx,
  probe: { name: string; phone: string; email: string; dob: string },
  excludeId?: string,
): DuplicateCandidate[] {
  const found = new Map<string, DuplicateCandidate>();
  const add = (rows: { id: string; code: string; name: string; phone: string; dob: string | null; email: string }[], kind: string) => {
    for (const r of rows) {
      if (excludeId && r.id === excludeId) continue;
      const cur = found.get(r.id) ?? { ...r, matchKinds: [] as string[] };
      if (!cur.matchKinds.includes(kind)) cur.matchKinds.push(kind);
      found.set(r.id, cur);
    }
  };
  const dPhone = digits(probe.phone);
  if (dPhone.length >= 6) {
    add(ctx.db.prepare('SELECT id, code, name, phone, dob, email FROM patients WHERE phone_digits = ? AND archived_at IS NULL LIMIT 10').all(dPhone) as never[], 'phone');
  }
  if (probe.email) {
    add(ctx.db.prepare('SELECT id, code, name, phone, dob, email FROM patients WHERE email_lower = ? AND archived_at IS NULL LIMIT 10').all(probe.email.toLowerCase()) as never[], 'email');
  }
  if (probe.name && probe.dob) {
    add(
      ctx.db.prepare('SELECT id, code, name, phone, dob, email FROM patients WHERE name_lower = ? AND dob = ? AND archived_at IS NULL LIMIT 10')
        .all(probe.name.toLowerCase(), probe.dob) as never[],
      'name+dob',
    );
  }
  return [...found.values()];
}

// ---- medical record items ----

export function listMedical(ctx: Ctx, patientId: string) {
  return ctx.db
    .prepare('SELECT * FROM patient_medical WHERE patient_id = ? ORDER BY kind, created_at')
    .all(patientId);
}

export function addMedical(ctx: Ctx, patientId: string, item: MedicalItemInput): { id: string } {
  if (!getPatient(ctx, patientId)) throw err.notFound('Patient');
  return tx(ctx.db, () => {
    const id = uuid();
    ctx.db
      .prepare('INSERT INTO patient_medical(id, patient_id, kind, value, notes, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, patientId, item.kind, item.value, item.notes, item.active ? 1 : 0, nowIso(), nowIso());
    ctx.audit('patients.medical.add', 'patients', patientId, { kind: item.kind });
    return { id };
  });
}

export function updateMedical(ctx: Ctx, input: MedicalItemInput & { id: string }): void {
  const row = ctx.db.prepare('SELECT id, patient_id FROM patient_medical WHERE id = ?').get(input.id) as { id: string; patient_id: string } | undefined;
  if (!row) throw err.notFound('Medical record item');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE patient_medical SET kind=?, value=?, notes=?, active=?, updated_at=? WHERE id=?')
      .run(input.kind, input.value, input.notes, input.active ? 1 : 0, nowIso(), input.id);
    ctx.audit('patients.medical.update', 'patients', row.patient_id, {});
  });
}

export function removeMedical(ctx: Ctx, id: string): void {
  const row = ctx.db.prepare('SELECT id, patient_id FROM patient_medical WHERE id = ?').get(id) as { id: string; patient_id: string } | undefined;
  if (!row) throw err.notFound('Medical record item');
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM patient_medical WHERE id = ?').run(id);
    ctx.audit('patients.medical.remove', 'patients', row.patient_id, {});
  });
}

// ---- Patient 360 ----

export function patientOverview(ctx: Ctx, id: string) {
  const p = getPatientWithTags(ctx, id);
  if (!p) throw err.notFound('Patient');
  const c = (sql: string, ...params: unknown[]) => (ctx.db.prepare(sql).get(...params) as { c: number }).c;
  const due = ctx.db
    .prepare("SELECT COALESCE(SUM(total_paisa - paid_paisa), 0) AS d FROM invoices WHERE patient_id = ? AND status = 'final'")
    .get(id) as { d: number };
  const adj = ctx.db.prepare('SELECT COALESCE(SUM(amount_paisa), 0) AS a FROM adjustments WHERE patient_id = ?').get(id) as { a: number };
  const lastVisit = ctx.db.prepare('SELECT started_at FROM visits WHERE patient_id = ? ORDER BY started_at DESC LIMIT 1').get(id) as { started_at: string } | undefined;
  const nextAppt = ctx.db
    .prepare("SELECT starts_at FROM appointments WHERE patient_id = ? AND status IN ('scheduled','confirmed') AND starts_at >= ? ORDER BY starts_at LIMIT 1")
    .get(id, nowIso()) as { starts_at: string } | undefined;
  const alerts = ctx.db
    .prepare("SELECT kind, value FROM patient_medical WHERE patient_id = ? AND active = 1 AND kind IN ('allergy','condition') ORDER BY kind, value")
    .all(id) as { kind: string; value: string }[];
  return {
    patient: p,
    counts: {
      visits: c('SELECT COUNT(*) AS c FROM visits WHERE patient_id = ?', id),
      prescriptions: c('SELECT COUNT(*) AS c FROM prescriptions WHERE patient_id = ?', id),
      invoices: c('SELECT COUNT(*) AS c FROM invoices WHERE patient_id = ?', id),
      payments: c('SELECT COUNT(*) AS c FROM payments WHERE patient_id = ?', id),
      appointments: c('SELECT COUNT(*) AS c FROM appointments WHERE patient_id = ?', id),
      attachments: c('SELECT COUNT(*) AS c FROM attachments WHERE patient_id = ?', id),
      activePlans: c("SELECT COUNT(*) AS c FROM treatment_plans WHERE patient_id = ? AND status IN ('draft','proposed','accepted')", id),
    },
    outstandingPaisa: due.d - adj.a,
    lastVisitAt: lastVisit?.started_at ?? null,
    nextAppointmentAt: nextAppt?.starts_at ?? null,
    alerts,
  };
}

export interface TimelineEvent {
  kind: 'visit' | 'prescription' | 'invoice' | 'payment' | 'appointment' | 'procedure';
  id: string;
  parentId: string | null;
  at: string;
  title: string;
  detail: string;
  amountPaisa: number | null;
  ref: string;
}

const TIMELINE_CORE = `
  SELECT * FROM (
    SELECT 'visit' AS kind, v.id AS id, NULL AS parentId, v.started_at AS at,
           'Visit ' || v.visit_no AS title,
           COALESCE(NULLIF(TRIM(v.chief_complaint), ''), NULLIF(TRIM(v.diagnosis), ''), '') AS detail,
           NULL AS amountPaisa, v.visit_no AS ref
    FROM visits v WHERE v.patient_id = @pid
    UNION ALL
    SELECT 'prescription', r.id, r.visit_id, r.created_at, 'Prescription ' || r.rx_no,
           COALESCE((SELECT GROUP_CONCAT(drug_name, ', ') FROM (SELECT drug_name FROM prescription_items WHERE rx_id = r.id ORDER BY seq LIMIT 4)), ''),
           NULL, r.rx_no
    FROM prescriptions r WHERE r.patient_id = @pid
    UNION ALL
    SELECT 'invoice', i.id, i.visit_id, i.created_at,
           CASE i.status WHEN 'void' THEN 'Invoice ' || i.invoice_no || ' (void)' ELSE 'Invoice ' || i.invoice_no END,
           COALESCE((SELECT GROUP_CONCAT(description, ', ') FROM (SELECT description FROM invoice_items WHERE invoice_id = i.id LIMIT 4)), ''),
           i.total_paisa, i.invoice_no
    FROM invoices i WHERE i.patient_id = @pid
    UNION ALL
    SELECT 'payment', p.id, p.invoice_id, p.created_at,
           CASE p.direction WHEN 'refund' THEN 'Refund ' || p.receipt_no ELSE 'Payment ' || p.receipt_no END,
           p.method || COALESCE(' · ' || NULLIF(p.reference, ''), ''),
           CASE p.direction WHEN 'refund' THEN -p.amount_paisa ELSE p.amount_paisa END, p.receipt_no
    FROM payments p WHERE p.patient_id = @pid AND p.voided_at IS NULL
    UNION ALL
    SELECT 'appointment', a.id, NULL, a.starts_at,
           'Appointment · ' || a.type,
           a.status, NULL, a.status
    FROM appointments a WHERE a.patient_id = @pid
  ) AS e`;

/** Keyset-paginated patient timeline - never truncates history, pages deterministically. */
export function patientTimeline(ctx: Ctx, patientId: string, cursor: string | undefined, limit: number): { events: TimelineEvent[]; nextCursor: string | null } {
  if (!getPatient(ctx, patientId)) throw err.notFound('Patient');
  const [cursorAt, cursorId] = cursor ? cursor.split('|') : ['', ''];
  const list = cursorAt
    ? (ctx.db.prepare(`${TIMELINE_CORE} WHERE e.at < @cat OR (e.at = @cat AND e.id < @cid) ORDER BY e.at DESC, e.id DESC LIMIT @lim`)
      .all({ pid: patientId, cat: cursorAt, cid: cursorId, lim: limit + 1 }) as TimelineEvent[])
    : (ctx.db.prepare(`${TIMELINE_CORE} ORDER BY e.at DESC, e.id DESC LIMIT @lim`).all({ pid: patientId, lim: limit + 1 }) as TimelineEvent[]);
  const events = list.slice(0, limit);
  const last = events[events.length - 1];
  const nextCursor = list.length > limit && last ? `${last.at}|${last.id}` : null;
  return { events, nextCursor };
}

// ---- merge (explicit confirmation by user in UI before calling) ----

const MERGE_TABLES = [
  'visits', 'prescriptions', 'invoices', 'payments', 'appointments', 'queue_entries',
  'treatment_plans', 'adjustments', 'attachments', 'patient_medical', 'patient_tags', 'dental_chart',
];

export function mergePatients(ctx: Ctx, keepId: string, removeId: string): void {
  if (keepId === removeId) throw err.validation('Cannot merge a patient into itself.');
  const keep = getPatient(ctx, keepId);
  const remove = getPatient(ctx, removeId);
  if (!keep || !remove) throw err.notFound('Patient');
  tx(ctx.db, () => {
    for (const t of MERGE_TABLES) {
      ctx.db.prepare(`UPDATE OR IGNORE ${t} SET patient_id = ? WHERE patient_id = ?`).run(keepId, removeId);
    }
    // clean up rows that could not move due to unique constraints (tags, chart)
    ctx.db.prepare('DELETE FROM patient_tags WHERE patient_id = ?').run(removeId);
    ctx.db.prepare('DELETE FROM dental_chart WHERE patient_id = ?').run(removeId);
    const note = `[Merged] Record merged into ${keep.code} on ${nowIso()}.`;
    ctx.db
      .prepare("UPDATE patients SET archived_at = ?, notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END, updated_at = ? WHERE id = ?")
      .run(nowIso(), note, note, nowIso(), removeId);
    ctx.audit('patients.merge', 'patients', keepId, { mergedFrom: remove.code, removedId: removeId });
  });
}
