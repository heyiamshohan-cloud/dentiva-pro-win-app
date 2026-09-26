// Dentiva Pro - CSV import (preview + transactional commit) and full-fidelity export.
import { err, DomainError, fail } from '../../shared/errors';
import { parseCsv, toCsv } from '../util/csv';
import { ImportInput } from '../../shared/validation/system';
import { patientInput, PatientInput } from '../../shared/validation/patients';
import { itemInput } from '../../shared/validation/inventory';
import { Ctx, tx } from './context';
import { createPatient, findDuplicates } from './patients';
import { createItem } from './inventory';
import { digits } from './patients';

export interface ImportResult {
  dryRun: boolean;
  totalRows: number;
  valid: number;
  inserted: number;
  skipped: number;
  errors: { row: number; message: string }[];
  duplicates: { row: number; matched: string }[];
  preview: Record<string, string>[];
}

const PATIENT_FIELDS = ['name', 'phone', 'altPhone', 'email', 'dob', 'gender', 'address', 'occupation', 'notes'] as const;
const ITEM_FIELDS = ['sku', 'name', 'category', 'unit', 'purchasePricePaisa', 'salePricePaisa', 'reorderLevel'] as const;

export function runImport(ctx: Ctx, input: ImportInput): ImportResult {
  const rows = parseCsv(input.csv);
  if (rows.length < 2) throw err.validation('The CSV file is empty or has no data rows.');
  const header = rows[0]!.map((h) => h.trim());
  const data = rows.slice(1);
  const fields = input.entity === 'patients' ? PATIENT_FIELDS : ITEM_FIELDS;
  // mapping: csvHeader -> field
  const colFor = new Map<string, number>();
  for (const [csvHeader, field] of Object.entries(input.mapping)) {
    const idx = header.findIndex((h) => h === csvHeader);
    if (idx >= 0) colFor.set(field, idx);
  }
  const unmapped = fields.filter((f) => (input.entity === 'patients' ? f === 'name' : f === 'sku' || f === 'name') && !colFor.has(f));
  if (unmapped.length) throw err.validation(`Required column(s) not mapped: ${unmapped.join(', ')}.`);

  const get = (row: string[], field: string) => (colFor.has(field) ? (row[colFor.get(field)!] ?? '').trim() : '');
  const errors: { row: number; message: string }[] = [];
  const duplicates: { row: number; matched: string }[] = [];
  const prepared: { rowNo: number; run: () => 'inserted' | 'skipped' }[] = [];
  const preview: Record<string, string>[] = [];

  data.forEach((row, i) => {
    const rowNo = i + 2;
    try {
      if (input.entity === 'patients') {
        const p: PatientInput = patientInput.parse({
          name: get(row, 'name'), phone: get(row, 'phone'), altPhone: get(row, 'altPhone'),
          email: get(row, 'email'), dob: get(row, 'dob') || null,
          gender: (get(row, 'gender') || null) as PatientInput['gender'],
          address: get(row, 'address'), occupation: get(row, 'occupation'), notes: get(row, 'notes'),
        });
        const dupes = findDuplicates(ctx, { name: p.name, phone: p.phone, email: p.email, dob: p.dob ?? '' });
        const hardDupe = dupes.find((d) => d.matchKinds.includes('phone'));
        if (hardDupe) {
          duplicates.push({ row: rowNo, matched: `${hardDupe.code} ${hardDupe.name}` });
          if (input.mode === 'error') {
            errors.push({ row: rowNo, message: `phone matches existing patient ${hardDupe.code}` });
            return;
          }
          prepared.push({ rowNo, run: () => 'skipped' });
        } else {
          prepared.push({
            rowNo,
            run: () => {
              try { createPatient(ctx, p); return 'inserted'; } catch (e) {
                if (e instanceof DomainError && e.code === 'DUPLICATE') return 'skipped';
                throw e;
              }
            },
          });
        }
        if (preview.length < 10) preview.push({ row: String(rowNo), name: p.name, phone: digits(p.phone) || '—' });
      } else {
        const item = itemInput.parse({
          sku: get(row, 'sku'), name: get(row, 'name'), category: get(row, 'category') || 'General',
          unit: get(row, 'unit') || 'pcs',
          purchasePricePaisa: Number.isFinite(Number(get(row, 'purchasePricePaisa'))) ? Math.round(Number(get(row, 'purchasePricePaisa'))) : 0,
          salePricePaisa: Number.isFinite(Number(get(row, 'salePricePaisa'))) ? Math.round(Number(get(row, 'salePricePaisa'))) : 0,
          reorderLevel: Number.isInteger(Number(get(row, 'reorderLevel'))) ? Number(get(row, 'reorderLevel')) : 0,
        });
        prepared.push({ rowNo, run: () => { createItem(ctx, item); return 'inserted'; } });
        if (preview.length < 10) preview.push({ row: String(rowNo), sku: item.sku, name: item.name });
      }
    } catch (e) {
      const msg = e instanceof DomainError ? e.message : (e as Error).message.slice(0, 200);
      errors.push({ row: rowNo, message: msg });
    }
  });

  const result: ImportResult = {
    dryRun: input.dryRun, totalRows: data.length, valid: prepared.length, inserted: 0,
    skipped: errors.length + duplicates.length, errors, duplicates, preview,
  };
  if (input.dryRun || (errors.length > 0 && input.mode === 'error')) return result;

  // Commit: single outer transaction; per-row savepoints let 'skip' continue after a row failure.
  tx(ctx.db, () => {
    for (const p of prepared) {
      const savepoint = `import_row_${p.rowNo}`;
      ctx.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const outcome = p.run();
        ctx.db.exec(`RELEASE ${savepoint}`);
        if (outcome === 'inserted') result.inserted += 1;
      } catch (e) {
        ctx.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        if (input.mode === 'error') throw e;
        result.errors.push({ row: p.rowNo, message: fail(e).error?.message ?? 'row failed' });
      }
    }
    ctx.audit('import.run', input.entity, '', { inserted: result.inserted, skipped: result.errors.length });
  });
  result.skipped = result.errors.length + result.duplicates.filter((d) => !result.errors.some((e) => e.row === d.row)).length;
  return result;
}

export function runExport(ctx: Ctx, entity: string, range: { from?: string; to?: string }): { csv: string; rows: number } {
  const p: Record<string, unknown> = {};
  const dateWhere = (col: string) => {
    const parts: string[] = [];
    if (range.from) { parts.push(`${col} >= @from`); p.from = range.from; }
    if (range.to) { parts.push(`${col} <= @to`); p.to = range.to; }
    return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  };
  let rowsOut: (string | number)[][] = [];
  let count = 0;
  if (entity === 'patients') {
    const rows = ctx.db.prepare('SELECT code, name, gender, dob, phone, alt_phone, email, address, occupation, created_at FROM patients ORDER BY code').all() as Record<string, unknown>[];
    rowsOut = [['code', 'name', 'gender', 'dob', 'phone', 'alt_phone', 'email', 'address', 'occupation', 'created_at'],
      ...rows.map((r) => [r.code, r.name, r.gender ?? '', r.dob ?? '', r.phone, r.alt_phone, r.email, r.address, r.occupation, r.created_at] as (string | number)[])];
    count = rows.length;
  } else if (entity === 'invoices') {
    const rows = ctx.db.prepare(`SELECT i.invoice_no, i.date, p.code AS patient_code, p.name AS patient_name, i.status, i.subtotal_paisa, i.discount_paisa, i.tax_paisa, i.total_paisa, i.paid_paisa FROM invoices i JOIN patients p ON p.id = i.patient_id ${dateWhere('i.date')} ORDER BY i.date`).all(p) as Record<string, unknown>[];
    rowsOut = [['invoice_no', 'date', 'patient_code', 'patient_name', 'status', 'subtotal_paisa', 'discount_paisa', 'tax_paisa', 'total_paisa', 'paid_paisa'],
      ...rows.map((r) => [r.invoice_no, r.date, r.patient_code, r.patient_name, r.status, r.subtotal_paisa, r.discount_paisa, r.tax_paisa, r.total_paisa, r.paid_paisa] as (string | number)[])];
    count = rows.length;
  } else if (entity === 'payments') {
    const wh = ['py.voided_at IS NULL'];
    if (range.from) wh.push('py.date >= @from');
    if (range.to) wh.push('py.date <= @to');
    const rows2 = ctx.db
      .prepare(
        `SELECT py.receipt_no, py.date, pt.code AS patient_code, pt.name AS patient_name,
                COALESCE(i.invoice_no,'') AS invoice_no, py.method, py.direction, py.amount_paisa, py.reference
         FROM payments py JOIN patients pt ON pt.id = py.patient_id LEFT JOIN invoices i ON i.id = py.invoice_id
         WHERE ${wh.join(' AND ')} ORDER BY py.date, py.created_at`,
      )
      .all({ from: range.from ?? '', to: range.to ?? '' }) as Record<string, unknown>[];
    rowsOut = [['receipt_no', 'date', 'patient_code', 'patient_name', 'invoice_no', 'method', 'direction', 'amount_paisa', 'reference'],
      ...rows2.map((r) => [r.receipt_no, r.date, r.patient_code, r.patient_name, r.invoice_no, r.method, r.direction, r.amount_paisa, r.reference] as (string | number)[])];
    count = rows2.length;
  } else if (entity === 'inventory') {
    const rows = ctx.db.prepare('SELECT sku, name, category, unit, qty_on_hand, reorder_level, purchase_price_paisa, sale_price_paisa FROM inventory_items ORDER BY sku').all() as Record<string, unknown>[];
    rowsOut = [['sku', 'name', 'category', 'unit', 'qty_on_hand', 'reorder_level', 'purchase_price_paisa', 'sale_price_paisa'],
      ...rows.map((r) => [r.sku, r.name, r.category, r.unit, r.qty_on_hand, r.reorder_level, r.purchase_price_paisa, r.sale_price_paisa] as (string | number)[])];
    count = rows.length;
  } else if (entity === 'appointments') {
    const rows = ctx.db.prepare(`SELECT a.starts_at, a.ends_at, a.status, a.type, p.code AS patient_code, p.name AS patient_name FROM appointments a JOIN patients p ON p.id = a.patient_id ${dateWhere('substr(a.starts_at,1,10)')} ORDER BY a.starts_at`).all(p) as Record<string, unknown>[];
    rowsOut = [['starts_at', 'ends_at', 'status', 'type', 'patient_code', 'patient_name'],
      ...rows.map((r) => [r.starts_at, r.ends_at, r.status, r.type, r.patient_code, r.patient_name] as (string | number)[])];
    count = rows.length;
  } else if (entity === 'visits') {
    const rows = ctx.db.prepare(`SELECT v.visit_no, v.started_at, v.status, p.code AS patient_code, p.name AS patient_name, v.chief_complaint, v.diagnosis FROM visits v JOIN patients p ON p.id = v.patient_id ${dateWhere('substr(v.started_at,1,10)')} ORDER BY v.started_at`).all(p) as Record<string, unknown>[];
    rowsOut = [['visit_no', 'started_at', 'status', 'patient_code', 'patient_name', 'chief_complaint', 'diagnosis'],
      ...rows.map((r) => [r.visit_no, r.started_at, r.status, r.patient_code, r.patient_name, r.chief_complaint, r.diagnosis] as (string | number)[])];
    count = rows.length;
  } else {
    throw err.validation('Unknown export entity.');
  }
  ctx.audit('export.run', entity, '', { rows: count });
  return { csv: toCsv(rowsOut), rows: count };
}
