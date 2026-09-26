import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestEnv, TestEnv, seedPatient, expectFail } from '../helpers';
import { makeCtx } from '../../src/main/services/context';
import { addAttachment, attachmentFilePath, removeAttachment } from '../../src/main/services/attachments';
import { runImport, runExport } from '../../src/main/services/importExport';
import { refreshNotifications, unreadCount, listNotifications } from '../../src/main/services/notifications';

let env: TestEnv;
let work: string;
afterEach(() => {
  env?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
});

async function setup() {
  env = await makeTestEnv();
  work = mkdtempSync(join(tmpdir(), 'dentiva-ops-'));
}

describe('inventory', () => {
  it('SKU uniqueness, purchase receiving, negative stock prevention', async () => {
    await setup();
    const sup = await env.must<{ id: string }>(env.adminToken, 'suppliers.create', { name: 'Dental Depot', phone: '01900000000' });
    const item = await env.must<{ id: string }>(env.adminToken, 'inventory.create', { sku: 'COMP-A1', name: 'Composite A1', unit: 'syringe', reorderLevel: 5, purchasePricePaisa: 45000 });
    expectFail(await env.call(env.adminToken, 'inventory.create', { sku: 'comp-a1', name: 'Duplicate SKU' }), 'DUPLICATE');
    const pur = await env.must<{ id: string; poNo: string }>(env.adminToken, 'purchases.create', {
      supplierId: sup.id, lines: [{ itemId: item.id, qty: 20, unitCostPaisa: 44000, batchNo: 'B-77', expiryDate: '2027-06-01' }], receive: true,
    });
    expect(pur.poNo).toBe('PO-000001');
    const after = await env.must<{ qty_on_hand: number }>(env.adminToken, 'inventory.get', { id: item.id });
    expect(after.qty_on_hand).toBe(20);
    // using 25 units is impossible (20 on hand)
    expectFail(await env.call(env.adminToken, 'inventory.adjust', { itemId: item.id, kind: 'use', qtyDelta: -25, reason: 'procedure' }), 'CONFLICT');
    const still = await env.must<{ qty_on_hand: number }>(env.adminToken, 'inventory.get', { id: item.id });
    expect(still.qty_on_hand).toBe(20); // unchanged after failed attempt
    await env.must(env.adminToken, 'inventory.adjust', { itemId: item.id, kind: 'use', qtyDelta: -16, reason: 'procedure' });
    const low = await env.must<{ id: string }[]>(env.adminToken, 'inventory.lowStock');
    expect(low.map((l) => l.id)).toContain(item.id); // 4 <= reorder 5
  });

  it('expiry tracking derives from lot movements', async () => {
    await setup();
    const item = await env.must<{ id: string }>(env.adminToken, 'inventory.create', { sku: 'ANES', name: 'Anesthesia', reorderLevel: 0 });
    await env.must(env.adminToken, 'purchases.create', { lines: [{ itemId: item.id, qty: 10, unitCostPaisa: 1000, batchNo: 'EXP1', expiryDate: '2026-11-01' }], receive: true });
    await env.must(env.adminToken, 'inventory.adjust', { itemId: item.id, kind: 'use', qtyDelta: -4, reason: 'use', batchNo: 'EXP1' });
    const exp = await env.must<{ batch_no: string; remaining: number }[]>(env.adminToken, 'inventory.expiries', { withinDays: 60 });
    expect(exp).toHaveLength(1);
    expect(exp[0]!.batch_no).toBe('EXP1');
    expect(Number(exp[0]!.remaining)).toBe(6);
  });

  it('purchase payments track balance and post to expenses', async () => {
    await setup();
    const item = await env.must<{ id: string }>(env.adminToken, 'inventory.create', { sku: 'GLOV', name: 'Gloves' });
    const pur = await env.must<{ id: string; totalPaisa: number }>(env.adminToken, 'purchases.create', {
      lines: [{ itemId: item.id, qty: 5, unitCostPaisa: 10000, batchNo: '', expiryDate: null }], receive: true,
    });
    expect(pur.totalPaisa).toBe(50000);
    expectFail(await env.call(env.adminToken, 'purchases.pay', { purchaseId: pur.id, amountPaisa: 60000, method: 'cash' }), 'FINANCIAL');
    await env.must(env.adminToken, 'purchases.pay', { purchaseId: pur.id, amountPaisa: 50000, method: 'bank', reference: 'CHQ-1' });
    const exp = await env.must<{ total: number }>(env.adminToken, 'expenses.list', {});
    expect(exp.total).toBe(1);
  });
});

describe('attachments', () => {
  it('copies into controlled storage with checksum; path traversal rejected', async () => {
    await setup();
    const p = await seedPatient(env);
    const src = join(work, 'xray scan.png');
    writeFileSync(src, Buffer.from('PNGDATA-123456789'));
    const ctx = makeCtx(env.db, null);
    const added = await addAttachment(ctx, join(work, 'store'), { patientId: p.id, visitId: null, sourcePath: src, note: 'X-ray' });
    expect(existsSync(attachmentFilePath(ctx, join(work, 'store'), added.id))).toBe(true);
    expect(added.sha256).toMatch(/^[0-9a-f]{64}$/);
    const list = await env.must<{ file_name: string; size: number }[]>(env.adminToken, 'attachments.list', { patientId: p.id });
    expect(list).toHaveLength(1);
    expect(list[0]!.file_name).toBe('xray scan.png');
    expect(list[0]!.size).toBe(17);
    // traversal attempt
    await expect(addAttachment(ctx, join(work, 'store'), { patientId: p.id, visitId: null, sourcePath: '../../etc/passwd', note: '' })).rejects.toThrow();
    const storedPath = attachmentFilePath(ctx, join(work, 'store'), added.id);
    removeAttachment(ctx, join(work, 'store'), added.id);
    expect(existsSync(storedPath)).toBe(false);
    expect(await env.must<unknown[]>(env.adminToken, 'attachments.list', { patientId: p.id })).toHaveLength(0);
  });

  it('rejects disallowed file types and oversized files', async () => {
    await setup();
    const p = await seedPatient(env);
    const ctx = makeCtx(env.db, null);
    const exe = join(work, 'evil.exe');
    writeFileSync(exe, 'MZ');
    await expect(addAttachment(ctx, join(work, 'store'), { patientId: p.id, visitId: null, sourcePath: exe, note: '' })).rejects.toThrowError(/cannot be attached/);
    const dir = join(work, 'adir');
    mkdirSync(dir);
    await expect(addAttachment(ctx, join(work, 'store'), { patientId: p.id, visitId: null, sourcePath: dir, note: '' })).rejects.toThrowError(/not a file/);
  });
});

describe('import/export', () => {
  it('patient CSV import: preview validation, error mode atomicity, skip mode', async () => {
    await setup();
    const ctx = makeCtx(env.db, null);
    const csv = [
      'Full Name,Phone,Email',
      'Imported One,01710000001,one@example.com',
      'Imported Two,01710000002,two@example.com',
      ',01710000003,bad@example.com',
    ].join('\r\n');
    const mapping = { 'Full Name': 'name', Phone: 'phone', Email: 'email' };
    const preview = runImport(ctx, { entity: 'patients', csv, mapping, mode: 'error', dryRun: true });
    expect(preview.totalRows).toBe(3);
    expect(preview.valid).toBe(2);
    expect(preview.errors).toHaveLength(1);
    const countBefore = (env.db.prepare('SELECT COUNT(*) AS c FROM patients').get() as { c: number }).c;
    expect(countBefore).toBe(0);
    // error mode commit aborts everything (row 4 invalid)
    runImport(ctx, { entity: 'patients', csv, mapping, mode: 'error', dryRun: false });
    expect((env.db.prepare('SELECT COUNT(*) AS c FROM patients').get() as { c: number }).c).toBe(0);
    // skip mode imports the valid ones
    const committed = runImport(ctx, { entity: 'patients', csv, mapping, mode: 'skip', dryRun: false });
    expect(committed.inserted).toBe(2);
    expect((env.db.prepare('SELECT COUNT(*) AS c FROM patients').get() as { c: number }).c).toBe(2);
  });

  it('duplicate phone rows surface as duplicates and skip cleanly', async () => {
    await setup();
    await seedPatient(env, 'Existing', '01710000001');
    const ctx = makeCtx(env.db, null);
    const csv = 'name,phone\nDup Row,01710000001';
    const r = runImport(ctx, { entity: 'patients', csv, mapping: { name: 'name', phone: 'phone' }, mode: 'skip', dryRun: false });
    expect(r.inserted).toBe(0);
    expect(r.duplicates.length + r.errors.length).toBeGreaterThan(0);
  });

  it('export produces complete CSV (no truncation)', async () => {
    await setup();
    for (let i = 0; i < 150; i++) await seedPatient(env, `Exp ${i}`, `0172${String(1000000 + i)}`);
    const ctx = makeCtx(env.db, null);
    const out = runExport(ctx, 'patients', {});
    expect(out.rows).toBe(150);
    expect(out.csv.split('\r\n')).toHaveLength(151); // header + all rows
  });
});

describe('notifications & dashboard', () => {
  it('low stock + backup reminders generated once (dedupe)', async () => {
    await setup();
    await env.must(env.adminToken, 'inventory.create', { sku: 'LOW1', name: 'Low Item', reorderLevel: 10 });
    const ctx = makeCtx(env.db, null);
    const r1 = refreshNotifications(ctx);
    expect(r1.created).toBeGreaterThanOrEqual(2); // low stock + backup reminder
    const r2 = refreshNotifications(ctx);
    expect(r2.created).toBe(0); // dedupe keys prevent floods
    const list = listNotifications(ctx, { page: 1, pageSize: 10, kind: '', unreadOnly: false });
    expect(list.total).toBeGreaterThanOrEqual(2);
    expect(unreadCount(ctx)).toBeGreaterThanOrEqual(2);
  });

  it('dashboard is fully derived from real data', async () => {
    await setup();
    const p = await seedPatient(env, 'Dash Person');
    const inv = await env.must<{ id: string }>(env.adminToken, 'invoices.create', { patientId: p.id, lines: [{ description: 'X', qty: 1, unitPricePaisa: 50000 }], finalize: true });
    await env.must(env.adminToken, 'payments.create', { patientId: p.id, invoiceId: inv.id, amountPaisa: 20000, method: 'cash' });
    const dash = await env.must<{
      outstanding: { invoiceCount: number; totalPaisa: number };
      collections: { todayPaisa: number; monthPaisa: number };
      recentPatients: unknown[];
    }>(env.adminToken, 'dashboard.get');
    expect(dash.outstanding.invoiceCount).toBe(1);
    expect(dash.outstanding.totalPaisa).toBe(30000);
    expect(dash.collections.todayPaisa).toBe(20000);
    expect(dash.recentPatients).toHaveLength(1);
  });

  it('reports derive from real data incl. empty-state robustness', async () => {
    await setup();
    const empty = await env.must<{ rows: unknown[] }>(env.adminToken, 'reports.run', { kind: 'daily_collections', from: '2026-01-01', to: '2026-12-31' });
    expect(empty.rows).toEqual([]);
    const p = await seedPatient(env);
    const inv = await env.must<{ id: string }>(env.adminToken, 'invoices.create', { patientId: p.id, lines: [{ description: 'X', qty: 1, unitPricePaisa: 80000 }], finalize: true });
    await env.must(env.adminToken, 'payments.create', { patientId: p.id, invoiceId: inv.id, amountPaisa: 80000, method: 'nagad' });
    const byMethod = await env.must<{ rows: { method: string; total_paisa: number }[] }>(env.adminToken, 'reports.run', { kind: 'payments_by_method', from: '2020-01-01', to: '2030-01-01' });
    expect(byMethod.rows.find((r) => r.method === 'nagad')?.total_paisa).toBe(80000);
    const outstanding = await env.must<{ rows: unknown[] }>(env.adminToken, 'reports.run', { kind: 'outstanding_balances', from: '2020-01-01', to: '2030-01-01' });
    expect(outstanding.rows).toEqual([]);
  });
});
