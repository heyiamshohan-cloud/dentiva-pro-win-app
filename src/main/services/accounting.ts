// Dentiva Pro - accounting (cashbook model: income from payments ledger + expense tracking).
// Explicitly NOT double-entry; a cash-basis operational ledger. Documented as such.
import { err } from '../../shared/errors';
import { uuid } from '../../shared/ids';
import { nowIso, todayClinic } from '../../shared/dates';
import { makePage } from '../../shared/validation/common';
import { ExpenseInput, ExpenseListQuery, LedgerQuery } from '../../shared/validation/finance';
import { Ctx, tx } from './context';

export function listExpenses(ctx: Ctx, q: ExpenseListQuery) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.from) { where.push('date >= @from'); params.from = q.from; }
  if (q.to) { where.push('date <= @to'); params.to = q.to; }
  if (q.category) { where.push('category = @cat'); params.cat = q.category; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM expenses ${whereSql}`).get(params) as { c: number }).c;
  const rows = ctx.db.prepare(`SELECT * FROM expenses ${whereSql} ORDER BY date DESC, created_at DESC LIMIT @lim OFFSET @off`)
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize });
  return makePage(rows, total, q.page, q.pageSize);
}

export function createExpense(ctx: Ctx, input: ExpenseInput): { id: string } {
  return tx(ctx.db, () => {
    const id = uuid();
    ctx.db
      .prepare('INSERT INTO expenses(id, date, category, amount_paisa, method, vendor, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, input.date ?? todayClinic(ctx.clinic().timezone), input.category, input.amountPaisa, input.method, input.vendor, input.notes, ctx.user?.id ?? null, nowIso());
    ctx.audit('expenses.create', 'expenses', id, { category: input.category, amountPaisa: input.amountPaisa });
    return { id };
  });
}

export function updateExpense(ctx: Ctx, input: ExpenseInput & { id: string }): void {
  const existing = ctx.db.prepare('SELECT id FROM expenses WHERE id = ?').get(input.id);
  if (!existing) throw err.notFound('Expense');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE expenses SET date=?, category=?, amount_paisa=?, method=?, vendor=?, notes=? WHERE id=?')
      .run(input.date ?? todayClinic(ctx.clinic().timezone), input.category, input.amountPaisa, input.method, input.vendor, input.notes, input.id);
    ctx.audit('expenses.update', 'expenses', input.id, {});
  });
}

export function deleteExpense(ctx: Ctx, id: string): void {
  const existing = ctx.db.prepare('SELECT id, category FROM expenses WHERE id = ?').get(id) as { id: string; category: string } | undefined;
  if (!existing) throw err.notFound('Expense');
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    ctx.audit('expenses.delete', 'expenses', id, { category: existing.category });
  });
}

/** Cash-basis ledger: income (payments), refunds, expenses. Derived entirely from source tables. */
export function ledger(ctx: Ctx, q: LedgerQuery) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.from) { where.push('date >= @from'); params.from = q.from; }
  if (q.to) { where.push('date <= @to'); params.to = q.to; }
  const kindFilter = q.kind ? 'WHERE kind = @kind' : '';
  if (q.kind) params.kind = q.kind;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT * FROM (
      SELECT 'income' AS kind, p.date, p.receipt_no AS ref, p.method, 'Patient payment' AS category,
             pt.name || ' (' || pt.code || ')' AS party, p.amount_paisa AS amount, p.created_at
      FROM payments p JOIN patients pt ON pt.id = p.patient_id
      WHERE p.direction = 'payment' AND p.voided_at IS NULL
      UNION ALL
      SELECT 'refund', p.date, p.receipt_no, p.method, 'Refund', pt.name || ' (' || pt.code || ')', p.amount_paisa, p.created_at
      FROM payments p JOIN patients pt ON pt.id = p.patient_id
      WHERE p.direction = 'refund' AND p.voided_at IS NULL
      UNION ALL
      SELECT 'expense', e.date, '-', e.method, e.category, e.vendor, e.amount_paisa, e.created_at
      FROM expenses e
    ) AS x ${whereSql ? whereSql.replace(/date/g, 'x.date') : ''} ${kindFilter}
    ORDER BY x.date DESC, x.created_at DESC LIMIT @lim OFFSET @off`;
  const countSql = `SELECT COUNT(*) AS c FROM (${sql.replace(/LIMIT @lim OFFSET @off$/, '')})`;
  const total = (ctx.db.prepare(countSql).get(params) as { c: number }).c;
  const rows = ctx.db.prepare(sql).all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize });
  return makePage(rows, total, q.page, q.pageSize);
}

export function accountingSummary(ctx: Ctx, range: { from: string; to: string }) {
  const income = ctx.db
    .prepare("SELECT COALESCE(SUM(amount_paisa),0) AS s FROM payments WHERE direction='payment' AND voided_at IS NULL AND date >= @from AND date <= @to")
    .get(range) as { s: number };
  const refunds = ctx.db
    .prepare("SELECT COALESCE(SUM(amount_paisa),0) AS s FROM payments WHERE direction='refund' AND voided_at IS NULL AND date >= @from AND date <= @to")
    .get(range) as { s: number };
  const expenses = ctx.db
    .prepare('SELECT COALESCE(SUM(amount_paisa),0) AS s FROM expenses WHERE date >= @from AND date <= @to')
    .get(range) as { s: number };
  const billed = ctx.db
    .prepare("SELECT COALESCE(SUM(total_paisa),0) AS s FROM invoices WHERE status='final' AND date >= @from AND date <= @to")
    .get(range) as { s: number };
  const outstanding = ctx.db
    .prepare("SELECT COALESCE(SUM(total_paisa - paid_paisa),0) AS s FROM invoices WHERE status='final'")
    .get() as { s: number };
  const byMethod = ctx.db
    .prepare("SELECT method, SUM(amount_paisa) AS s, COUNT(*) AS c FROM payments WHERE direction='payment' AND voided_at IS NULL AND date >= @from AND date <= @to GROUP BY method ORDER BY s DESC")
    .all(range);
  const expensesByCategory = ctx.db
    .prepare('SELECT category, SUM(amount_paisa) AS s, COUNT(*) AS c FROM expenses WHERE date >= @from AND date <= @to GROUP BY category ORDER BY s DESC')
    .all(range);
  return {
    incomePaisa: income.s, refundsPaisa: refunds.s, expensesPaisa: expenses.s,
    netPaisa: income.s - refunds.s - expenses.s, billedPaisa: billed.s, outstandingPaisa: outstanding.s,
    byMethod, expensesByCategory,
  };
}
