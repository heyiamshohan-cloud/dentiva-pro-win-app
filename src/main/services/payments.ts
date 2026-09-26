// Dentiva Pro - payments, refunds, adjustments & patient statements.
// Invariants (enforced transactionally, re-derived after every mutation):
//   invoice.paid_paisa = Σ payments - Σ refunds - Σ adjustments(amount signed; negative = credit/write-off)
//   invoice.due        = total_paisa - paid_paisa  (>= 0 enforced for invoice-linked payments)
import { err } from '../../shared/errors';
import { uuid, receiptNo } from '../../shared/ids';
import { nowIso, todayClinic } from '../../shared/dates';
import { makePage } from '../../shared/validation/common';
import { PaymentInput, PaymentListQuery, RefundInput } from '../../shared/validation/finance';
import { Ctx, tx } from './context';
import { nextSeq } from '../db/connection';
import { getPatient } from './patients';
import { InvoiceRow, invoiceBalance } from './invoices';

/** Re-derive invoice.paid_paisa from its linked ledger rows. Call inside the mutating transaction. */
export function recomputeInvoicePaid(ctx: Ctx, invoiceId: string): number {
  const inv = ctx.db.prepare('SELECT total_paisa FROM invoices WHERE id = ?').get(invoiceId) as { total_paisa: number } | undefined;
  if (!inv) throw err.notFound('Invoice');
  const pay = ctx.db
    .prepare("SELECT COALESCE(SUM(CASE WHEN direction='payment' THEN amount_paisa ELSE -amount_paisa END),0) AS s FROM payments WHERE invoice_id = ? AND voided_at IS NULL")
    .get(invoiceId) as { s: number };
  const adj = ctx.db.prepare('SELECT COALESCE(SUM(amount_paisa),0) AS s FROM adjustments WHERE invoice_id = ?').get(invoiceId) as { s: number };
  const paid = pay.s - adj.s;
  if (paid < 0) throw err.financial('This change would make the invoice payments negative. Apply a smaller amount.');
  ctx.db.prepare('UPDATE invoices SET paid_paisa = ?, updated_at = ? WHERE id = ?').run(paid, nowIso(), invoiceId);
  return paid;
}

export function patientOutstanding(ctx: Ctx, patientId: string): number {
  const row = ctx.db
    .prepare("SELECT COALESCE(SUM(total_paisa - paid_paisa), 0) AS d FROM invoices WHERE patient_id = ? AND status = 'final'")
    .get(patientId) as { d: number };
  return row.d;
}

export function createPayment(ctx: Ctx, input: PaymentInput) {
  if (!input.invoiceId) throw err.validation('Every payment must reference an invoice so the ledger always balances.');
  const invoiceId = input.invoiceId;
  if (!getPatient(ctx, input.patientId)) throw err.notFound('Patient');
  if (!ctx.clinic().enabledPaymentMethods.includes(input.method)) {
    throw err.validation(`The payment method "${input.method}" is not enabled in clinic settings.`);
  }
  return tx(ctx.db, () => {
    if (input.idempotencyKey) {
      const dup = ctx.db.prepare('SELECT id, receipt_no FROM payments WHERE idempotency_key = ?').get(input.idempotencyKey) as { id: string; receipt_no: string } | undefined;
      if (dup) throw err.duplicate(`This payment was already recorded as receipt ${dup.receipt_no}. The duplicate submission was ignored.`, { existingId: dup.id });
    }
    const inv = ctx.db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as InvoiceRow | undefined;
    if (!inv) throw err.notFound('Invoice');
    if (inv.patient_id !== input.patientId) throw err.validation('The invoice belongs to a different patient.');
    if (inv.status !== 'final') throw err.invalidState(`Payments can only be recorded against finalized invoices. This invoice is ${inv.status}.`);
    const due = invoiceBalance(inv);
    if (input.amountPaisa > due) {
      throw err.financial(`The payment exceeds the outstanding balance of this invoice (${due} paisa due). Overpayments are not accepted; record the correct amount.`);
    }
    const id = uuid();
    const no = receiptNo(nextSeq(ctx.db, 'receipt'));
    const now = nowIso();
    const date = input.date ?? todayClinic(ctx.clinic().timezone);
    ctx.db
      .prepare(
        `INSERT INTO payments(id, receipt_no, patient_id, invoice_id, date, method, amount_paisa, direction, reference, notes, idempotency_key, created_by, created_at)
         VALUES (?,?,?,?,?,?,?, 'payment', ?,?,?,?,?)`,
      )
      .run(id, no, input.patientId, invoiceId, date, input.method, input.amountPaisa, input.reference, input.notes, input.idempotencyKey ?? null, ctx.user?.id ?? null, now);
    const paid = recomputeInvoicePaid(ctx, invoiceId);
    ctx.audit('payments.create', 'payments', id, { receiptNo: no, invoiceId, amountPaisa: input.amountPaisa, method: input.method });
    return { id, receiptNo: no, invoicePaidPaisa: paid, invoiceDuePaisa: inv.total_paisa - paid };
  });
}

export function createRefund(ctx: Ctx, input: RefundInput) {
  const original = ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(input.originalPaymentId) as
    { id: string; patient_id: string; invoice_id: string | null; amount_paisa: number; direction: string; receipt_no: string; voided_at: string | null } | undefined;
  if (!original || original.direction !== 'payment' || original.voided_at) throw err.notFound('Original payment');
  if (original.patient_id !== input.patientId) throw err.validation('The patient does not match the original payment.');
  return tx(ctx.db, () => {
    const refunded = ctx.db
      .prepare("SELECT COALESCE(SUM(amount_paisa),0) AS s FROM payments WHERE original_payment_id = ? AND direction = 'refund'")
      .get(original.id) as { s: number };
    const refundable = original.amount_paisa - refunded.s;
    if (input.amountPaisa > refundable) {
      throw err.financial(`Only ${refundable} paisa remains refundable on receipt ${original.receipt_no}.`);
    }
    const id = uuid();
    const no = receiptNo(nextSeq(ctx.db, 'receipt'));
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO payments(id, receipt_no, patient_id, invoice_id, date, method, amount_paisa, direction, reference, notes, original_payment_id, created_by, created_at)
         VALUES (?,?,?,?,?,?,?, 'refund', ?,?,?,?,?)`,
      )
      .run(id, no, input.patientId, original.invoice_id, todayClinic(ctx.clinic().timezone), input.method, input.amountPaisa, original.receipt_no, input.reason, original.id, ctx.user?.id ?? null, now);
    if (original.invoice_id) recomputeInvoicePaid(ctx, original.invoice_id);
    ctx.audit('payments.refund', 'payments', id, { receiptNo: no, original: original.receipt_no, amountPaisa: input.amountPaisa, reason: input.reason });
    return { id, receiptNo: no };
  });
}

export function createAdjustment(ctx: Ctx, input: { patientId: string; invoiceId: string | null; amountPaisa: number; reason: string }) {
  if (!input.invoiceId) throw err.validation('Adjustments must reference an invoice.');
  const invoiceId = input.invoiceId;
  const inv = ctx.db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as InvoiceRow | undefined;
  if (!inv) throw err.notFound('Invoice');
  if (inv.patient_id !== input.patientId) throw err.validation('The invoice belongs to a different patient.');
  if (inv.status !== 'final') throw err.invalidState('Adjustments can only be applied to finalized invoices.');
  return tx(ctx.db, () => {
    const id = uuid();
    ctx.db
      .prepare('INSERT INTO adjustments(id, patient_id, invoice_id, amount_paisa, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.patientId, invoiceId, input.amountPaisa, input.reason, ctx.user?.id ?? null, nowIso());
    recomputeInvoicePaid(ctx, invoiceId);
    ctx.audit('payments.adjustment', 'adjustments', id, { invoiceId, amountPaisa: input.amountPaisa, reason: input.reason });
    return { id };
  });
}

export function listPayments(ctx: Ctx, q: PaymentListQuery) {
  const where: string[] = ['p.voided_at IS NULL'];
  const params: Record<string, unknown> = {};
  if (q.patientId) { where.push('p.patient_id = @pid'); params.pid = q.patientId; }
  if (q.invoiceId) { where.push('p.invoice_id = @inv'); params.inv = q.invoiceId; }
  if (q.method) { where.push('p.method = @method'); params.method = q.method; }
  if (q.direction) { where.push('p.direction = @dir'); params.dir = q.direction; }
  if (q.from) { where.push('p.date >= @from'); params.from = q.from; }
  if (q.to) { where.push('p.date <= @to'); params.to = q.to; }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM payments p ${whereSql}`).get(params) as { c: number }).c;
  const rows = ctx.db
    .prepare(
      `SELECT p.*, pt.name AS patient_name, pt.code AS patient_code, i.invoice_no
       FROM payments p JOIN patients pt ON pt.id = p.patient_id LEFT JOIN invoices i ON i.id = p.invoice_id
       ${whereSql} ORDER BY p.created_at DESC, p.id LIMIT @lim OFFSET @off`,
    )
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize });
  return makePage(rows, total, q.page, q.pageSize);
}

// ---- patient statement ----

export interface StatementLine {
  date: string; kind: 'invoice' | 'payment' | 'refund' | 'adjustment';
  ref: string; description: string; debitPaisa: number; creditPaisa: number; balancePaisa: number;
}

export function patientStatement(ctx: Ctx, q: { patientId: string; from?: string; to?: string }) {
  const patient = getPatient(ctx, q.patientId);
  if (!patient) throw err.notFound('Patient');
  interface Raw { date: string; at: string; kind: string; ref: string; description: string; debit: number; credit: number }
  const rows = ctx.db
    .prepare(
      `SELECT * FROM (
         SELECT i.date AS date, i.created_at AS at, 'invoice' AS kind, i.invoice_no AS ref,
                COALESCE((SELECT GROUP_CONCAT(description, ', ') FROM (SELECT description FROM invoice_items WHERE invoice_id = i.id LIMIT 3)), '') AS description,
                i.total_paisa AS debit, 0 AS credit
         FROM invoices i WHERE i.patient_id = @pid AND i.status = 'final'
         UNION ALL
         SELECT p.date, p.created_at, CASE WHEN p.direction = 'refund' THEN 'refund' ELSE 'payment' END,
                p.receipt_no,
                CASE WHEN p.direction = 'refund' THEN 'Refund via ' || p.method ELSE 'Payment via ' || p.method END ||
                COALESCE(' (' || i.invoice_no || ')', ''),
                CASE WHEN p.direction = 'refund' THEN p.amount_paisa ELSE 0 END,
                CASE WHEN p.direction = 'refund' THEN 0 ELSE p.amount_paisa END
         FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
         WHERE p.patient_id = @pid AND p.voided_at IS NULL
         UNION ALL
         SELECT substr(a.created_at, 1, 10), a.created_at, 'adjustment', COALESCE(i.invoice_no, '-'),
                'Adjustment: ' || a.reason,
                CASE WHEN a.amount_paisa > 0 THEN a.amount_paisa ELSE 0 END,
                CASE WHEN a.amount_paisa < 0 THEN -a.amount_paisa ELSE 0 END
         FROM adjustments a LEFT JOIN invoices i ON i.id = a.invoice_id
         WHERE a.patient_id = @pid
       ) ORDER BY date ASC, at ASC`,
    )
    .all({ pid: q.patientId }) as Raw[];
  const from = q.from ?? null;
  const to = q.to ?? null;
  let balance = 0;
  let opening = 0;
  const lines: StatementLine[] = [];
  for (const r of rows) {
    const delta = r.debit - r.credit;
    if (from && r.date < from) { opening += delta; balance += delta; continue; }
    if (to && r.date > to) break;
    balance += delta;
    lines.push({ date: r.date, kind: r.kind as StatementLine['kind'], ref: r.ref, description: r.description, debitPaisa: r.debit, creditPaisa: r.credit, balancePaisa: balance });
  }
  const totalBilled = lines.filter((l) => l.kind === 'invoice').reduce((a, l) => a + l.debitPaisa, 0) + (from ? 0 : 0);
  const totalPaid = rows.filter((r) => r.kind === 'payment').reduce((a, r) => a + r.credit, 0);
  const totalRefunded = rows.filter((r) => r.kind === 'refund').reduce((a, r) => a + r.debit, 0);
  return {
    patient: { id: patient.id, code: patient.code, name: patient.name, phone: patient.phone },
    from, to, openingPaisa: opening, closingPaisa: balance, lines,
    totals: {
      billedAllTimePaisa: rows.filter((r) => r.kind === 'invoice').reduce((a, r) => a + r.debit, 0),
      billedInRangePaisa: totalBilled,
      paidPaisa: totalPaid,
      refundedPaisa: totalRefunded,
      outstandingPaisa: patientOutstanding(ctx, q.patientId),
    },
  };
}
