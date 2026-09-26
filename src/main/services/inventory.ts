// Dentiva Pro - inventory, suppliers & purchases. All stock mutations are transactional;
// negative stock is impossible (precondition check + CHECK constraint).
import { err } from '../../shared/errors';
import { uuid, purchaseNo } from '../../shared/ids';
import { nowIso, todayClinic, addDays } from '../../shared/dates';
import { makePage } from '../../shared/validation/common';
import { ItemInput, ItemListQuery, SupplierInput, PurchaseInput, StockAdjustInput, MovementListQuery, PurchasePayInput } from '../../shared/validation/inventory';
import { Ctx, tx } from './context';
import { nextSeq } from '../db/connection';

export function listItems(ctx: Ctx, q: ItemListQuery) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (!q.includeInactive) where.push('active = 1');
  if (q.q) { where.push('(name LIKE @q OR sku LIKE @q)'); params.q = `%${q.q}%`; }
  if (q.category) { where.push('category = @cat'); params.cat = q.category; }
  if (q.lowStock) where.push('reorder_level > 0 AND qty_on_hand <= reorder_level');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM inventory_items ${whereSql}`).get(params) as { c: number }).c;
  const rows = ctx.db.prepare(`SELECT * FROM inventory_items ${whereSql} ORDER BY name LIMIT @lim OFFSET @off`)
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize });
  return makePage(rows, total, q.page, q.pageSize);
}

export function createItem(ctx: Ctx, input: ItemInput): { id: string } {
  return tx(ctx.db, () => {
    const id = uuid();
    try {
      ctx.db
        .prepare(
          `INSERT INTO inventory_items(id, sku, name, category, unit, supplier_id, purchase_price_paisa, sale_price_paisa, qty_on_hand, reorder_level, notes, active, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
        )
        .run(id, input.sku, input.name, input.category, input.unit, input.supplierId, input.purchasePricePaisa, input.salePricePaisa, input.reorderLevel, input.notes, input.active ? 1 : 0, nowIso(), nowIso());
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw err.duplicate(`An item with SKU "${input.sku}" already exists.`);
      throw e;
    }
    ctx.audit('inventory.create', 'inventory_items', id, { sku: input.sku, name: input.name });
    return { id };
  });
}

export function updateItem(ctx: Ctx, input: ItemInput & { id: string }): void {
  const existing = ctx.db.prepare('SELECT id FROM inventory_items WHERE id = ?').get(input.id);
  if (!existing) throw err.notFound('Inventory item');
  tx(ctx.db, () => {
    try {
      ctx.db
        .prepare('UPDATE inventory_items SET sku=?, name=?, category=?, unit=?, supplier_id=?, purchase_price_paisa=?, sale_price_paisa=?, reorder_level=?, notes=?, active=?, updated_at=? WHERE id=?')
        .run(input.sku, input.name, input.category, input.unit, input.supplierId, input.purchasePricePaisa, input.salePricePaisa, input.reorderLevel, input.notes, input.active ? 1 : 0, nowIso(), input.id);
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw err.duplicate(`An item with SKU "${input.sku}" already exists.`);
      throw e;
    }
    ctx.audit('inventory.update', 'inventory_items', input.id, { sku: input.sku });
  });
}

export function getItem(ctx: Ctx, id: string) {
  const item = ctx.db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
  if (!item) return null;
  const recent = ctx.db.prepare('SELECT * FROM stock_movements WHERE item_id = ? ORDER BY created_at DESC, id LIMIT 20').all(id);
  return { ...(item as object), recentMovements: recent };
}

/** All stock changes pass through here: movement row + qty_on_hand update in ONE transaction. */
function applyMovement(ctx: Ctx, m: {
  itemId: string; kind: 'purchase' | 'sale' | 'use' | 'adjust' | 'waste' | 'return';
  qtyDelta: number; reason: string; batchNo: string; expiryDate: string | null;
  unitCostPaisa: number; refType: string; refId: string;
}): void {
  const item = ctx.db.prepare('SELECT qty_on_hand, name FROM inventory_items WHERE id = ?').get(m.itemId) as { qty_on_hand: number; name: string } | undefined;
  if (!item) throw err.notFound('Inventory item');
  const next = item.qty_on_hand + m.qtyDelta;
  if (next < 0) {
    throw err.conflict(`Insufficient stock for "${item.name}": ${item.qty_on_hand} on hand, change requested ${m.qtyDelta}.`);
  }
  ctx.db
    .prepare(
      `INSERT INTO stock_movements(id, item_id, kind, qty_delta, reason, batch_no, expiry_date, unit_cost_paisa, ref_type, ref_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(uuid(), m.itemId, m.kind, m.qtyDelta, m.reason, m.batchNo, m.expiryDate, m.unitCostPaisa, m.refType, m.refId, ctx.user?.id ?? null, nowIso());
  const res = ctx.db.prepare('UPDATE inventory_items SET qty_on_hand = qty_on_hand + ?, updated_at = ? WHERE id = ? AND qty_on_hand + ? >= 0')
    .run(m.qtyDelta, nowIso(), m.itemId, m.qtyDelta);
  if (res.changes !== 1) throw err.integrity('Stock update failed integrity check.');
}

export function adjustStock(ctx: Ctx, input: StockAdjustInput): { id: string } {
  const idHolder = { id: '' };
  tx(ctx.db, () => {
    applyMovement(ctx, {
      itemId: input.itemId, kind: input.kind, qtyDelta: input.qtyDelta, reason: input.reason,
      batchNo: input.batchNo, expiryDate: input.expiryDate, unitCostPaisa: 0, refType: 'manual', refId: '',
    });
    ctx.audit('inventory.adjust', 'inventory_items', input.itemId, { kind: input.kind, qtyDelta: input.qtyDelta, reason: input.reason });
    idHolder.id = input.itemId;
  });
  return idHolder;
}

export function listMovements(ctx: Ctx, q: MovementListQuery) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.itemId) { where.push('m.item_id = @item'); params.item = q.itemId; }
  if (q.kind) { where.push('m.kind = @kind'); params.kind = q.kind; }
  if (q.from) { where.push('m.created_at >= @from'); params.from = `${q.from}T00:00:00Z`; }
  if (q.to) { where.push('m.created_at <= @to'); params.to = `${q.to}T23:59:59.999Z`; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM stock_movements m ${whereSql}`).get(params) as { c: number }).c;
  const rows = ctx.db
    .prepare(
      `SELECT m.*, i.name AS item_name, i.sku FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id
       ${whereSql} ORDER BY m.created_at DESC, m.id LIMIT @lim OFFSET @off`,
    )
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize });
  return makePage(rows, total, q.page, q.pageSize);
}

export function lowStock(ctx: Ctx) {
  return ctx.db
    .prepare('SELECT id, sku, name, qty_on_hand, reorder_level, unit FROM inventory_items WHERE active = 1 AND reorder_level > 0 AND qty_on_hand <= reorder_level ORDER BY name')
    .all();
}

/** Expiry view derived from LOT-level movement sums (item + batch); a lot's expiry comes
    from its intake movement. Outbound movements reference the lot by batch number. */
export function expiries(ctx: Ctx, withinDays: number) {
  const horizon = addDays(todayClinic(ctx.clinic().timezone), withinDays);
  return ctx.db
    .prepare(
      `SELECT i.id, i.sku, i.name, m.batch_no,
              MAX(m.expiry_date) AS expiry_date,
              SUM(m.qty_delta) AS remaining
       FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id
       WHERE m.batch_no != ''
       GROUP BY m.item_id, m.batch_no
       HAVING SUM(m.qty_delta) > 0
          AND MAX(m.expiry_date) IS NOT NULL
          AND MAX(m.expiry_date) <= @horizon
       ORDER BY expiry_date`,
    )
    .all({ horizon });
}

// ---- suppliers ----

export function listSuppliers(ctx: Ctx, q: string) {
  return ctx.db.prepare('SELECT * FROM suppliers WHERE name LIKE ? ORDER BY name LIMIT 500').all(`%${q}%`);
}

export function createSupplier(ctx: Ctx, input: SupplierInput): { id: string } {
  return tx(ctx.db, () => {
    const id = uuid();
    try {
      ctx.db.prepare('INSERT INTO suppliers(id, name, phone, email, address, notes, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, input.name, input.phone, input.email, input.address, input.notes, nowIso());
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw err.duplicate(`A supplier named "${input.name}" already exists.`);
      throw e;
    }
    ctx.audit('suppliers.create', 'suppliers', id, { name: input.name });
    return { id };
  });
}

export function updateSupplier(ctx: Ctx, input: SupplierInput & { id: string }): void {
  const existing = ctx.db.prepare('SELECT id FROM suppliers WHERE id = ?').get(input.id);
  if (!existing) throw err.notFound('Supplier');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE suppliers SET name=?, phone=?, email=?, address=?, notes=? WHERE id=?')
      .run(input.name, input.phone, input.email, input.address, input.notes, input.id);
    ctx.audit('suppliers.update', 'suppliers', input.id, {});
  });
}

// ---- purchases ----

export function listPurchases(ctx: Ctx, q: { page: number; pageSize: number; supplierId?: string }) {
  const where = q.supplierId ? 'WHERE pu.supplier_id = @sid' : '';
  const params = q.supplierId ? { sid: q.supplierId } : {};
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM purchases pu ${where}`).get(params) as { c: number }).c;
  const rows = ctx.db
    .prepare(
      `SELECT pu.*, s.name AS supplier_name FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id
       ${where} ORDER BY pu.date DESC, pu.created_at DESC LIMIT @lim OFFSET @off`,
    )
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize });
  const itemsStmt = ctx.db.prepare(
    'SELECT pi.*, i.name AS item_name, i.sku FROM purchase_items pi JOIN inventory_items i ON i.id = pi.item_id WHERE pi.purchase_id = ?',
  );
  const withItems = (rows as Record<string, unknown>[]).map((r) => ({ ...r, items: itemsStmt.all(r.id as string) }));
  return makePage(withItems, total, q.page, q.pageSize);
}

export function createPurchase(ctx: Ctx, input: PurchaseInput) {
  for (const l of input.lines) {
    if (!ctx.db.prepare('SELECT id FROM inventory_items WHERE id = ?').get(l.itemId)) throw err.notFound('Inventory item in purchase');
    if (input.supplierId && !ctx.db.prepare('SELECT id FROM suppliers WHERE id = ?').get(input.supplierId)) throw err.notFound('Supplier');
  }
  return tx(ctx.db, () => {
    const id = uuid();
    const no = purchaseNo(nextSeq(ctx.db, 'purchase'));
    const now = nowIso();
    const total = input.lines.reduce((a, l) => a + l.qty * l.unitCostPaisa, 0);
    ctx.db
      .prepare('INSERT INTO purchases(id, po_no, supplier_id, date, total_paisa, paid_paisa, status, notes, created_by, created_at) VALUES (?,?,?,?,?,0,?,?,?,?)')
      .run(id, no, input.supplierId, input.date ?? todayClinic(ctx.clinic().timezone), total, input.receive ? 'received' : 'draft', input.notes, ctx.user?.id ?? null, now);
    const insItem = ctx.db.prepare(
      'INSERT INTO purchase_items(id, purchase_id, item_id, qty, unit_cost_paisa, line_total_paisa, batch_no, expiry_date) VALUES (?,?,?,?,?,?,?,?)',
    );
    for (const l of input.lines) {
      insItem.run(uuid(), id, l.itemId, l.qty, l.unitCostPaisa, l.qty * l.unitCostPaisa, l.batchNo, l.expiryDate);
      if (input.receive) {
        applyMovement(ctx, {
          itemId: l.itemId, kind: 'purchase', qtyDelta: l.qty, reason: `Purchase ${no}`,
          batchNo: l.batchNo, expiryDate: l.expiryDate, unitCostPaisa: l.unitCostPaisa, refType: 'purchase', refId: id,
        });
      }
    }
    ctx.audit('purchases.create', 'purchases', id, { poNo: no, totalPaisa: total, received: input.receive });
    return { id, poNo: no, totalPaisa: total };
  });
}

export function payPurchase(ctx: Ctx, input: PurchasePayInput): void {
  const pu = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(input.purchaseId) as { id: string; po_no: string; total_paisa: number; paid_paisa: number } | undefined;
  if (!pu) throw err.notFound('Purchase');
  if (pu.paid_paisa + input.amountPaisa > pu.total_paisa) {
    throw err.financial(`The payment exceeds the purchase balance. ${pu.total_paisa - pu.paid_paisa} paisa remains payable on ${pu.po_no}.`);
  }
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE purchases SET paid_paisa = paid_paisa + ? WHERE id = ? AND paid_paisa + ? <= total_paisa')
      .run(input.amountPaisa, input.purchaseId, input.amountPaisa);
    ctx.db
      .prepare('INSERT INTO expenses(id, date, category, amount_paisa, method, vendor, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(uuid(), todayClinic(ctx.clinic().timezone), 'Inventory purchase', input.amountPaisa, input.method, '', `Supplier payment for ${pu.po_no}${input.reference ? ` · ref ${input.reference}` : ''}`, ctx.user?.id ?? null, nowIso());
    ctx.audit('purchases.pay', 'purchases', input.purchaseId, { amountPaisa: input.amountPaisa });
  });
}
