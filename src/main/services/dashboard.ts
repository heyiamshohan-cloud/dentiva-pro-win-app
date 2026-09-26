// Dentiva Pro - dashboard & reports. Every number derives from real data with indexed queries.
import { Ctx } from './context';
import { todayClinic, monthRange, clinicLocalToIso, addDays } from '../../shared/dates';
import { lowStock, expiries } from './inventory';
import { ReportQuery } from '../../shared/validation/system';

export function dashboard(ctx: Ctx) {
  const tz = ctx.clinic().timezone;
  const today = todayClinic(tz);
  // Clinic-day bounds converted to UTC instants (timezone-correct day filtering).
  const dayFrom = clinicLocalToIso(today, '00:00', tz);
  const dayTo = clinicLocalToIso(addDays(today, 1), '00:00', tz);
  const params = { today, now: new Date().toISOString(), dayFrom, dayTo };
  const todayAppointments = ctx.db
    .prepare(
      `SELECT a.id, a.starts_at, a.ends_at, a.status, a.type, p.name AS patient_name, p.code AS patient_code
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.starts_at >= @dayFrom AND a.starts_at < @dayTo
       ORDER BY a.starts_at`,
    )
    .all(params);
  const queue = ctx.db
    .prepare(
      `SELECT q.id, q.serial, q.status, p.name AS patient_name, p.code AS patient_code
       FROM queue_entries q JOIN patients p ON p.id = q.patient_id WHERE q.day = @today ORDER BY q.serial`,
    )
    .all(params);
  const todayCollections = ctx.db
    .prepare("SELECT COALESCE(SUM(CASE WHEN direction='payment' THEN amount_paisa ELSE -amount_paisa END),0) AS s FROM payments WHERE date = @today AND voided_at IS NULL")
    .get(params) as { s: number };
  const month = monthRange(today.slice(0, 7));
  const monthCollections = ctx.db
    .prepare("SELECT COALESCE(SUM(CASE WHEN direction='payment' THEN amount_paisa ELSE -amount_paisa END),0) AS s FROM payments WHERE date >= @from AND date < @to AND voided_at IS NULL")
    .get({ from: month.from, to: month.to }) as { s: number };
  const outstanding = ctx.db
    .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(total_paisa - paid_paisa),0) AS s FROM invoices WHERE status = 'final' AND paid_paisa < total_paisa")
    .get() as { c: number; s: number };
  const recentPatients = ctx.db
    .prepare('SELECT id, code, name, phone, created_at FROM patients WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 8')
    .all();
  const followUps = ctx.db
    .prepare(
      `SELECT v.id, v.follow_up_date, v.visit_no, p.name AS patient_name, p.code AS patient_code, p.id AS patient_id
       FROM visits v JOIN patients p ON p.id = v.patient_id
       WHERE v.follow_up_date IS NOT NULL AND v.follow_up_date <= date(@today, '+7 days') AND v.status != 'cancelled'
       ORDER BY v.follow_up_date LIMIT 20`,
    )
    .all(params);
  const newPatientsMonth = ctx.db
    .prepare('SELECT COUNT(*) AS c FROM patients WHERE archived_at IS NULL AND created_at >= @from')
    .get({ from: month.from }) as { c: number };
  const waitingCount = (queue as { status: string }[]).filter((q) => q.status === 'waiting' || q.status === 'called').length;
  return {
    today,
    todayAppointments,
    queue,
    waitingCount,
    collections: { todayPaisa: todayCollections.s, monthPaisa: monthCollections.s },
    outstanding: { invoiceCount: outstanding.c, totalPaisa: outstanding.s },
    recentPatients,
    followUps,
    newPatientsMonth: newPatientsMonth.c,
    lowStock: lowStock(ctx).slice(0, 10),
    expiries: expiries(ctx, 30).slice(0, 10),
  };
}

export function runReport(ctx: Ctx, q: ReportQuery) {
  const tz = ctx.clinic().timezone;
  // Timezone-correct UTC bounds for instant-typed columns (starts_at, created_at).
  const utcFrom = clinicLocalToIso(q.from, '00:00', tz);
  const utcTo = clinicLocalToIso(addDays(q.to, 1), '00:00', tz);
  const range = { from: q.from, to: q.to, utcFrom, utcTo };
  const db = ctx.db;
  switch (q.kind) {
    case 'revenue_summary': {
      const daily = db.prepare(
        `SELECT date, COALESCE(SUM(CASE WHEN direction='payment' THEN amount_paisa ELSE -amount_paisa END),0) AS net_paisa, COUNT(*) AS payments
         FROM payments WHERE voided_at IS NULL AND date >= @from AND date <= @to GROUP BY date ORDER BY date`,
      ).all(range);
      const billed = db.prepare(
        `SELECT date, SUM(total_paisa) AS billed_paisa, COUNT(*) AS invoices FROM invoices
         WHERE status = 'final' AND date >= @from AND date <= @to GROUP BY date ORDER BY date`,
      ).all(range);
      const totals = db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction='payment' THEN amount_paisa ELSE -amount_paisa END),0) AS net_collected_paisa
         FROM payments WHERE voided_at IS NULL AND date >= @from AND date <= @to`,
      ).get(range);
      return { kind: q.kind, columns: ['date', 'net_paisa', 'payments'], rows: daily, billed, totals };
    }
    case 'payments_by_method':
      return {
        kind: q.kind,
        rows: db.prepare(
          `SELECT method, COUNT(*) AS count, SUM(amount_paisa) AS total_paisa FROM payments
           WHERE direction='payment' AND voided_at IS NULL AND date >= @from AND date <= @to GROUP BY method ORDER BY total_paisa DESC`,
        ).all(range),
      };
    case 'outstanding_balances':
      return {
        kind: q.kind,
        rows: db.prepare(
          `SELECT p.code AS patient_code, p.name AS patient_name, p.phone,
                  COUNT(i.id) AS open_invoices, SUM(i.total_paisa - i.paid_paisa) AS due_paisa
           FROM invoices i JOIN patients p ON p.id = i.patient_id
           WHERE i.status = 'final' AND i.paid_paisa < i.total_paisa
           GROUP BY i.patient_id ORDER BY due_paisa DESC`,
        ).all(),
      };
    case 'appointments_summary':
      return {
        kind: q.kind,
        rows: db.prepare(
          `SELECT substr(starts_at, 1, 10) AS date, status, COUNT(*) AS count FROM appointments
           WHERE starts_at >= @utcFrom AND starts_at < @utcTo
           GROUP BY date, status ORDER BY date`,
        ).all(range),
      };
    case 'patient_growth':
      return {
        kind: q.kind,
        rows: db.prepare(
          `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS new_patients FROM patients
           WHERE archived_at IS NULL AND created_at >= @from GROUP BY month ORDER BY month`,
        ).all({ from: `${q.from}T00:00:00Z` }),
      };
    case 'treatment_activity':
      return {
        kind: q.kind,
        rows: db.prepare(
          `SELECT pr.name, COUNT(*) AS times_performed, SUM(pr.qty) AS total_qty, SUM(pr.qty * pr.price_paisa) AS value_paisa
           FROM visit_procedures pr JOIN visits v ON v.id = pr.visit_id
           WHERE v.started_at >= @utcFrom AND v.started_at < @utcTo
           GROUP BY pr.name ORDER BY times_performed DESC`,
        ).all(range),
      };
    case 'dentist_activity':
      return {
        kind: q.kind,
        rows: db.prepare(
          `SELECT COALESCE(u.display_name, 'Unassigned') AS dentist,
                  COUNT(DISTINCT v.id) AS visits, COUNT(DISTINCT a.id) AS appointments
           FROM users u
           LEFT JOIN visits v ON v.dentist_id = u.id AND v.started_at >= @utcFrom AND v.started_at < @utcTo
           LEFT JOIN appointments a ON a.dentist_id = u.id AND a.starts_at >= @utcFrom AND a.starts_at < @utcTo
           WHERE u.role IN ('dentist','admin') GROUP BY u.id ORDER BY visits DESC`,
        ).all(range),
      };
    case 'inventory_valuation':
      return {
        kind: q.kind,
        rows: db.prepare(
          `SELECT sku, name, category, qty_on_hand, unit, purchase_price_paisa, qty_on_hand * purchase_price_paisa AS value_paisa
           FROM inventory_items WHERE active = 1 ORDER BY value_paisa DESC`,
        ).all(),
        totals: db.prepare('SELECT COALESCE(SUM(qty_on_hand * purchase_price_paisa),0) AS total_value_paisa FROM inventory_items WHERE active = 1').get(),
      };
    case 'low_stock':
      return { kind: q.kind, rows: lowStock(ctx) };
    case 'expiry_report':
      return { kind: q.kind, rows: expiries(ctx, 365) };
    case 'expense_summary':
      return {
        kind: q.kind,
        rows: db.prepare(
          `SELECT category, COUNT(*) AS count, SUM(amount_paisa) AS total_paisa FROM expenses
           WHERE date >= @from AND date <= @to GROUP BY category ORDER BY total_paisa DESC`,
        ).all(range),
      };
    case 'daily_collections':
      return {
        kind: q.kind,
        rows: db.prepare(
          `SELECT date, method, COUNT(*) AS count, SUM(amount_paisa) AS total_paisa FROM payments
           WHERE direction = 'payment' AND voided_at IS NULL AND date >= @from AND date <= @to
           GROUP BY date, method ORDER BY date DESC, method`,
        ).all(range),
      };
    default:
      return { kind: q.kind, rows: [] };
  }
}
