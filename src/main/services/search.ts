// Dentiva Pro - global & entity search. Suggestions are grouped top-N with real totals;
// full results are available through the paginated entity lists (no hidden truncation).
import { makePage } from '../../shared/validation/common';
import { Ctx } from './context';
import { searchPatientsFts } from './patients';

export interface SearchGroup {
  kind: 'patients' | 'invoices' | 'treatments' | 'inventory' | 'staff';
  total: number;
  rows: { id: string; label: string; sub: string; route: string }[];
}

export function globalSearch(ctx: Ctx, q: string, limitPerGroup: number): SearchGroup[] {
  const groups: SearchGroup[] = [];
  const like = `%${q}%`;
  const pats = searchPatientsFts(ctx, q, limitPerGroup);
  if (pats.length) {
    groups.push({
      kind: 'patients', total: pats.length,
      rows: pats.map((p) => ({ id: p.id, label: `${p.code} · ${p.name}`, sub: p.phone || 'No phone', route: `#/patients/${p.id}` })),
    });
  }
  const inv = ctx.db
    .prepare(
      `SELECT i.id, i.invoice_no, i.total_paisa, i.status, p.name AS patient_name, p.code AS patient_code
       FROM invoices i JOIN patients p ON p.id = i.patient_id
       WHERE i.invoice_no LIKE ? ORDER BY i.created_at DESC LIMIT ?`,
    )
    .all(like, limitPerGroup) as { id: string; invoice_no: string; total_paisa: number; status: string; patient_name: string; patient_code: string }[];
  if (inv.length) {
    groups.push({
      kind: 'invoices', total: inv.length,
      rows: inv.map((i) => ({ id: i.id, label: `${i.invoice_no} · ${i.patient_name}`, sub: `${i.patient_code} · ${i.status}`, route: `#/billing/invoices/${i.id}` })),
    });
  }
  const rx = ctx.db
    .prepare(
      `SELECT r.id, r.rx_no, p.name AS patient_name, p.code AS patient_code FROM prescriptions r JOIN patients p ON p.id = r.patient_id
       WHERE r.rx_no LIKE ? ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(like, limitPerGroup) as { id: string; rx_no: string; patient_name: string; patient_code: string }[];
  if (rx.length) {
    groups.push({
      kind: 'patients', total: rx.length,
      rows: rx.map((r) => ({ id: r.id, label: `RX ${r.rx_no} · ${r.patient_name}`, sub: r.patient_code, route: `#/prescriptions/${r.id}` })),
    });
  }
  const tr = ctx.db.prepare('SELECT id, name, category, price_paisa FROM treatments WHERE name LIKE ? ORDER BY name LIMIT ?').all(like, limitPerGroup) as
    { id: string; name: string; category: string; price_paisa: number }[];
  if (tr.length) {
    groups.push({ kind: 'treatments', total: tr.length, rows: tr.map((t) => ({ id: t.id, label: t.name, sub: t.category, route: '#/treatments' })) });
  }
  const it = ctx.db.prepare('SELECT id, name, sku, qty_on_hand FROM inventory_items WHERE name LIKE ? OR sku LIKE ? ORDER BY name LIMIT ?').all(like, like, limitPerGroup) as
    { id: string; name: string; sku: string; qty_on_hand: number }[];
  if (it.length) {
    groups.push({ kind: 'inventory', total: it.length, rows: it.map((t) => ({ id: t.id, label: `${t.sku} · ${t.name}`, sub: `Stock: ${t.qty_on_hand}`, route: '#/inventory' })) });
  }
  const st = ctx.db.prepare('SELECT id, display_name, role FROM users WHERE username LIKE ? OR display_name LIKE ? LIMIT ?').all(like, like, limitPerGroup) as
    { id: string; display_name: string; role: string }[];
  if (st.length) {
    groups.push({ kind: 'staff', total: st.length, rows: st.map((s) => ({ id: s.id, label: s.display_name, sub: s.role, route: '#/staff' })) });
  }
  return groups;
}

/** Paginated targeted search used by "view all results" in the search dialog. */
export function entitySearch(ctx: Ctx, entity: string, q: string, page: number, pageSize: number) {
  const like = `%${q}%`;
  if (entity === 'patients') {
    const rows = searchPatientsFts(ctx, q, pageSize).map((p) => ({ ...p, route: `#/patients/${p.id}` }));
    return makePage(rows.slice((page - 1) * pageSize, page * pageSize), rows.length, page, pageSize);
  }
  if (entity === 'invoices') {
    const total = (ctx.db.prepare('SELECT COUNT(*) AS c FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE i.invoice_no LIKE ? OR p.name LIKE ?').get(like, like) as { c: number }).c;
    const rows = ctx.db
      .prepare('SELECT i.id, i.invoice_no, i.date, i.total_paisa, i.paid_paisa, i.status, p.name AS patient_name, p.code AS patient_code FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE i.invoice_no LIKE ? OR p.name LIKE ? ORDER BY i.created_at DESC LIMIT ? OFFSET ?')
      .all(like, like, pageSize, (page - 1) * pageSize);
    return makePage(rows, total, page, pageSize);
  }
  if (entity === 'treatments') {
    const total = (ctx.db.prepare('SELECT COUNT(*) AS c FROM treatments WHERE name LIKE ?').get(like) as { c: number }).c;
    const rows = ctx.db.prepare('SELECT * FROM treatments WHERE name LIKE ? ORDER BY name LIMIT ? OFFSET ?').all(like, pageSize, (page - 1) * pageSize);
    return makePage(rows, total, page, pageSize);
  }
  if (entity === 'inventory') {
    const total = (ctx.db.prepare('SELECT COUNT(*) AS c FROM inventory_items WHERE name LIKE ? OR sku LIKE ?').get(like, like) as { c: number }).c;
    const rows = ctx.db.prepare('SELECT * FROM inventory_items WHERE name LIKE ? OR sku LIKE ? ORDER BY name LIMIT ? OFFSET ?').all(like, like, pageSize, (page - 1) * pageSize);
    return makePage(rows, total, page, pageSize);
  }
  const total = (ctx.db.prepare('SELECT COUNT(*) AS c FROM users WHERE username LIKE ? OR display_name LIKE ?').get(like, like) as { c: number }).c;
  const rows = ctx.db.prepare('SELECT id, username, display_name, role, active FROM users WHERE username LIKE ? OR display_name LIKE ? LIMIT ? OFFSET ?').all(like, like, pageSize, (page - 1) * pageSize);
  return makePage(rows, total, page, pageSize);
}
