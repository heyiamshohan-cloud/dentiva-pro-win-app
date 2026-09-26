// Dentiva Pro - invoice engine. Integer-paisa math; invariant enforced at both
// domain level (computeInvoice) and DB level (CHECK constraints).
import { err, DomainError } from '../../shared/errors';
import { computeInvoice } from '../../shared/money';
import { uuid } from '../../shared/ids';
import { nowIso, todayClinic } from '../../shared/dates';
import { makePage } from '../../shared/validation/common';
import { InvoiceInput, InvoiceListQuery } from '../../shared/validation/finance';
import { Ctx, tx } from './context';
import { nextSeq } from '../db/connection';
import { getPatient } from './patients';

function safeCompute(input: Parameters<typeof computeInvoice>[0]): ReturnType<typeof computeInvoice> {
  try {
    return computeInvoice(input);
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw err.validation(e instanceof Error ? e.message : 'Invalid invoice amounts.');
  }
}

export interface InvoiceRow {
  id: string; invoice_no: string; patient_id: string; visit_id: string | null; date: string;
  status: 'draft' | 'final' | 'void'; subtotal_paisa: number; discount_paisa: number; tax_bp: number;
  tax_paisa: number; total_paisa: number; paid_paisa: number; notes: string; created_by: string | null;
  created_at: string; updated_at: string; void_reason: string | null; voided_at: string | null;
}

export function invoiceBalance(inv: Pick<InvoiceRow, 'total_paisa' | 'paid_paisa' | 'status'>): number {
  if (inv.status !== 'final') return 0;
  return inv.total_paisa - inv.paid_paisa;
}

export function getInvoice(ctx: Ctx, id: string) {
  const inv = ctx.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
  if (!inv) return null;
  const items = ctx.db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY rowid').all(id);
  const p = ctx.db.prepare('SELECT name, code, phone, address, dob, gender FROM patients WHERE id = ?').get(inv.patient_id) as Record<string, unknown>;
  const payments = ctx.db.prepare("SELECT id, receipt_no, date, method, amount_paisa, direction, reference, created_at FROM payments WHERE invoice_id = ? AND voided_at IS NULL ORDER BY created_at").all(id);
  return { ...inv, due_paisa: invoiceBalance(inv), items, patient: p, payments };
}

function numbered(ctx: Ctx): string {
  const prefix = ctx.clinic().invoicePrefix || 'INV';
  return `${prefix}-${String(nextSeq(ctx.db, 'invoice')).padStart(6, '0')}`;
}

function insertItems(ctx: Ctx, invoiceId: string, input: InvoiceInput, lineTotals: number[]): void {
  const stmt = ctx.db.prepare(
    `INSERT INTO invoice_items(id, invoice_id, item_type, ref_id, description, tooth, qty, unit_price_paisa, discount_paisa, line_total_paisa)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  input.lines.forEach((l, i) => {
    stmt.run(uuid(), invoiceId, l.itemType, l.refId, l.description, l.tooth, l.qty, l.unitPricePaisa, l.discountPaisa, lineTotals[i]);
  });
}

export function createInvoice(ctx: Ctx, input: InvoiceInput) {
  if (!getPatient(ctx, input.patientId)) throw err.notFound('Patient');
  if (input.visitId) {
    const v = ctx.db.prepare('SELECT patient_id FROM visits WHERE id = ?').get(input.visitId) as { patient_id: string } | undefined;
    if (!v) throw err.notFound('Visit');
    if (v.patient_id !== input.patientId) throw err.validation('The linked visit belongs to a different patient.');
  }
  if (input.discountPaisa > 0 && !ctx.user) throw err.forbidden();
  const math = safeCompute({
    lines: input.lines.map((l) => ({ qty: l.qty, unitPricePaisa: l.unitPricePaisa, discountPaisa: l.discountPaisa })),
    discountPaisa: input.discountPaisa, taxBp: input.taxBp,
  });
  const status = input.finalize ? 'final' : 'draft';
  return tx(ctx.db, () => {
    const id = uuid();
    const no = numbered(ctx);
    const now = nowIso();
    const date = input.date ?? todayClinic(ctx.clinic().timezone);
    ctx.db
      .prepare(
        `INSERT INTO invoices(id, invoice_no, patient_id, visit_id, date, status, subtotal_paisa, discount_paisa,
          tax_bp, tax_paisa, total_paisa, paid_paisa, notes, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
      )
      .run(id, no, input.patientId, input.visitId, date, status, math.subtotalPaisa, math.discountPaisa,
        input.taxBp, math.taxPaisa, math.totalPaisa, input.notes, ctx.user?.id ?? null, now, now);
    insertItems(ctx, id, input, math.lineTotals);
    ctx.audit('invoices.create', 'invoices', id, { invoiceNo: no, status, totalPaisa: math.totalPaisa });
    return getInvoice(ctx, id);
  });
}

export function updateInvoice(ctx: Ctx, input: InvoiceInput & { id: string }) {
  const existing = ctx.db.prepare('SELECT * FROM invoices WHERE id = ?').get(input.id) as InvoiceRow | undefined;
  if (!existing) throw err.notFound('Invoice');
  if (existing.status !== 'draft') {
    throw err.invalidState('Only draft invoices can be edited. Finalized invoices are immutable — void the invoice and issue a corrected one if a change is required.');
  }
  if (existing.patient_id !== input.patientId) throw err.validation('An invoice cannot be moved to a different patient.');
  const math = safeCompute({
    lines: input.lines.map((l) => ({ qty: l.qty, unitPricePaisa: l.unitPricePaisa, discountPaisa: l.discountPaisa })),
    discountPaisa: input.discountPaisa, taxBp: input.taxBp,
  });
  return tx(ctx.db, () => {
    ctx.db
      .prepare(
        `UPDATE invoices SET visit_id=?, date=?, subtotal_paisa=?, discount_paisa=?, tax_bp=?, tax_paisa=?, total_paisa=?,
         notes=?, updated_at=? WHERE id=? AND status='draft'`,
      )
      .run(input.visitId, input.date ?? existing.date, math.subtotalPaisa, math.discountPaisa, input.taxBp, math.taxPaisa, math.totalPaisa, input.notes, nowIso(), input.id);
    ctx.db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(input.id);
    insertItems(ctx, input.id, input, math.lineTotals);
    ctx.audit('invoices.update', 'invoices', input.id, { invoiceNo: existing.invoice_no });
    return getInvoice(ctx, input.id);
  });
}

export function finalizeInvoice(ctx: Ctx, id: string) {
  const existing = ctx.db.prepare('SELECT status, invoice_no FROM invoices WHERE id = ?').get(id) as { status: string; invoice_no: string } | undefined;
  if (!existing) throw err.notFound('Invoice');
  if (existing.status !== 'draft') throw err.invalidState('Only a draft invoice can be finalized.');
  return tx(ctx.db, () => {
    ctx.db.prepare("UPDATE invoices SET status = 'final', updated_at = ? WHERE id = ?").run(nowIso(), id);
    ctx.audit('invoices.finalize', 'invoices', id, { invoiceNo: existing.invoice_no });
    return getInvoice(ctx, id);
  });
}

export function voidInvoice(ctx: Ctx, id: string, reason: string): void {
  const existing = ctx.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
  if (!existing) throw err.notFound('Invoice');
  if (existing.status === 'void') throw err.invalidState('This invoice is already void.');
  if (existing.paid_paisa > 0) {
    throw err.invalidState('This invoice has recorded payments. Refund the payments first, then void the invoice.');
  }
  tx(ctx.db, () => {
    ctx.db.prepare("UPDATE invoices SET status = 'void', void_reason = ?, voided_at = ?, updated_at = ? WHERE id = ?")
      .run(reason, nowIso(), nowIso(), id);
    ctx.audit('invoices.void', 'invoices', id, { invoiceNo: existing.invoice_no, reason });
  });
}

export function listInvoices(ctx: Ctx, q: InvoiceListQuery) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.patientId) { where.push('i.patient_id = @pid'); params.pid = q.patientId; }
  if (q.status) {
    if (q.status === 'unpaid') { where.push("i.status = 'final' AND i.paid_paisa = 0"); }
    else if (q.status === 'part_paid') { where.push("i.status = 'final' AND i.paid_paisa > 0 AND i.paid_paisa < i.total_paisa"); }
    else if (q.status === 'paid') { where.push("i.status = 'final' AND i.paid_paisa >= i.total_paisa"); }
    else { where.push('i.status = @status'); params.status = q.status; }
  }
  if (q.from) { where.push('i.date >= @from'); params.from = q.from; }
  if (q.to) { where.push('i.date <= @to'); params.to = q.to; }
  if (q.q) { where.push('(i.invoice_no LIKE @q OR p.name LIKE @q OR p.code LIKE @q)'); params.q = `%${q.q}%`; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM invoices i JOIN patients p ON p.id = i.patient_id ${whereSql}`).get(params) as { c: number }).c;
  const rows = ctx.db
    .prepare(
      `SELECT i.*, p.name AS patient_name, p.code AS patient_code
       FROM invoices i JOIN patients p ON p.id = i.patient_id
       ${whereSql} ORDER BY i.date DESC, i.created_at DESC, i.id LIMIT @lim OFFSET @off`,
    )
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize });
  return makePage(rows, total, q.page, q.pageSize);
}
