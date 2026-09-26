import { describe, it, expect, afterEach } from 'vitest';
import { makeTestEnv, TestEnv, seedPatient, expectFail } from '../helpers';

let env: TestEnv;
afterEach(() => env?.cleanup());

async function invoiceOf(totalLine = 100000, lines?: unknown): Promise<{ id: string; invoice_no: string; total_paisa: number; patientId: string }> {
  const p = await seedPatient(env, 'Finance Patient ' + Math.random().toString(36).slice(2, 8), '0171' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'));
  const inv = await env.must<{ id: string; invoice_no: string; total_paisa: number }>(env.adminToken, 'invoices.create', {
    patientId: p.id, lines: lines ?? [{ description: 'Scaling', qty: 1, unitPricePaisa: totalLine }], finalize: true,
  });
  return { ...inv, patientId: p.id };
}

describe('financial engine: invoices', () => {
  it('computes totals with integer math (incl. tax bp)', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    const inv = await env.must<{ subtotal_paisa: number; discount_paisa: number; tax_paisa: number; total_paisa: number }>(
      env.adminToken, 'invoices.create', {
        patientId: p.id, finalize: true,
        lines: [
          { description: 'Root Canal', qty: 1, unitPricePaisa: 850000 },
          { description: 'X-Ray', qty: 2, unitPricePaisa: 40000, discountPaisa: 5000 },
        ],
        discountPaisa: 20000, taxBp: 1500,
      });
    expect(inv.subtotal_paisa).toBe(925000);
    expect(inv.discount_paisa).toBe(20000);
    expect(inv.tax_paisa).toBe(135750); // (925000-20000) = 905000 * 15% = 135750
    expect(inv.total_paisa).toBe(1040750);
    expect(inv.total_paisa).toBe(inv.subtotal_paisa - inv.discount_paisa + inv.tax_paisa);
  });

  it('rejects discount exceeding subtotal at domain level', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    const e = expectFail(await env.call(env.adminToken, 'invoices.create', {
      patientId: p.id, lines: [{ description: 'X', qty: 1, unitPricePaisa: 1000 }], discountPaisa: 2000,
    }), 'VALIDATION');
    expect(e.message).toMatch(/exceed/i);
  });

  it('draft → edit → finalize workflow; finalized invoices immutable', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    const draft = await env.must<{ id: string; status: string; total_paisa: number }>(env.adminToken, 'invoices.create', {
      patientId: p.id, lines: [{ description: 'Consult', qty: 1, unitPricePaisa: 50000 }], finalize: false,
    });
    expect(draft.status).toBe('draft');
    await env.must(env.adminToken, 'invoices.update', {
      id: draft.id, patientId: p.id, lines: [{ description: 'Consult', qty: 1, unitPricePaisa: 60000 }], finalize: false,
    });
    const after = await env.must<{ total_paisa: number }>(env.adminToken, 'invoices.get', { id: draft.id });
    expect(after.total_paisa).toBe(60000);
    await env.must(env.adminToken, 'invoices.finalize', { id: draft.id });
    expectFail(await env.call(env.adminToken, 'invoices.update', {
      id: draft.id, patientId: p.id, lines: [{ description: 'X', qty: 1, unitPricePaisa: 1 }], finalize: true,
    }), 'INVALID_STATE');
  });
});

describe('financial engine: payments', () => {
  it('supports partial + multiple payments, tracks due precisely', async () => {
    env = await makeTestEnv();
    const inv = await invoiceOf(200000);
    await env.must(env.adminToken, 'payments.create', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 50000, method: 'bkash' });
    await env.must(env.adminToken, 'payments.create', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 70000, method: 'cash' });
    const after = await env.must<{ paid_paisa: number; total_paisa: number }>(env.adminToken, 'invoices.get', { id: inv.id });
    expect(after.paid_paisa).toBe(120000);
    expect(after.total_paisa - after.paid_paisa).toBe(80000);
  });

  it('rejects overpayment with FINANCIAL error', async () => {
    env = await makeTestEnv();
    const inv = await invoiceOf(100000);
    const e = expectFail(await env.call(env.adminToken, 'payments.create', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 100001, method: 'cash' }), 'FINANCIAL');
    expect(e.message).toMatch(/exceeds/i);
  });

  it('idempotency key blocks double-click duplicates', async () => {
    env = await makeTestEnv();
    const inv = await invoiceOf(100000);
    const payload = { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 5000, method: 'cash', idempotencyKey: 'abc12345' };
    const first = await env.must<{ receiptNo: string }>(env.adminToken, 'payments.create', payload);
    const dup = expectFail(await env.call(env.adminToken, 'payments.create', payload), 'DUPLICATE');
    expect(dup.message).toContain(first.receiptNo);
    const inv2 = await env.must<{ paid_paisa: number }>(env.adminToken, 'invoices.get', { id: inv.id });
    expect(inv2.paid_paisa).toBe(5000);
  });

  it('payments must reference an invoice; cross-patient rejected', async () => {
    env = await makeTestEnv();
    const inv = await invoiceOf(100000);
    expectFail(await env.call(env.adminToken, 'payments.create', { patientId: inv.patientId, invoiceId: null, amountPaisa: 1000, method: 'cash' }), 'VALIDATION');
    const other = await seedPatient(env);
    expectFail(await env.call(env.adminToken, 'payments.create', { patientId: other.id, invoiceId: inv.id, amountPaisa: 1000, method: 'cash' }), 'VALIDATION');
  });

  it('receipt numbers are sequential and unique', async () => {
    env = await makeTestEnv();
    const inv = await invoiceOf(300000);
    const r1 = await env.must<{ receiptNo: string }>(env.adminToken, 'payments.create', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 1000, method: 'cash' });
    const r2 = await env.must<{ receiptNo: string }>(env.adminToken, 'payments.create', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 1000, method: 'nagad' });
    expect(r1.receiptNo).toBe('RCP-000001');
    expect(r2.receiptNo).toBe('RCP-000002');
  });

  it('disabled payment methods are rejected', async () => {
    env = await makeTestEnv();
    const s = await env.must<Record<string, unknown>>(env.adminToken, 'settings.get');
    await env.must(env.adminToken, 'settings.update', { ...s, enabledPaymentMethods: ['cash'] });
    const inv = await invoiceOf(1000);
    expectFail(await env.call(env.adminToken, 'payments.create', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 1000, method: 'rocket' }), 'VALIDATION');
  });
});

describe('financial engine: refunds, adjustments, void, statements', () => {
  it('refund reduces net paid and is capped at the refundable amount', async () => {
    env = await makeTestEnv();
    const inv = await invoiceOf(100000);
    const pay = await env.must<{ id: string; receiptNo: string }>(env.adminToken, 'payments.create', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 80000, method: 'card' });
    const payRow = env.db.prepare('SELECT id FROM payments WHERE receipt_no = ?').get(pay.receiptNo) as { id: string };
    await env.must(env.adminToken, 'payments.refund', { patientId: inv.patientId, originalPaymentId: payRow.id, amountPaisa: 30000, reason: 'Overcharged', method: 'card' });
    const after = await env.must<{ paid_paisa: number }>(env.adminToken, 'invoices.get', { id: inv.id });
    expect(after.paid_paisa).toBe(50000);
    expectFail(await env.call(env.adminToken, 'payments.refund', { patientId: inv.patientId, originalPaymentId: payRow.id, amountPaisa: 60000, reason: 'X', method: 'card' }), 'FINANCIAL');
  });

  it('adjustment write-off reduces due; charge increases it', async () => {
    env = await makeTestEnv();
    const inv = await invoiceOf(100000);
    await env.must(env.adminToken, 'payments.create', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 40000, method: 'cash' });
    await env.must(env.adminToken, 'payments.adjustment', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: -25000, reason: 'Goodwill write-off' });
    let after = await env.must<{ paid_paisa: number; total_paisa: number }>(env.adminToken, 'invoices.get', { id: inv.id });
    expect(after.paid_paisa).toBe(65000); // 40000 - (-25000)
    expect(after.total_paisa - after.paid_paisa).toBe(35000);
    await env.must(env.adminToken, 'payments.adjustment', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 5000, reason: 'Material surcharge' });
    after = await env.must<{ paid_paisa: number; total_paisa: number }>(env.adminToken, 'invoices.get', { id: inv.id });
    expect(after.total_paisa - after.paid_paisa).toBe(40000);
  });

  it('void requires zero payments; voided invoice excluded from balances', async () => {
    env = await makeTestEnv();
    const inv = await invoiceOf(100000);
    await env.must(env.adminToken, 'payments.create', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 5000, method: 'cash' });
    expectFail(await env.call(env.adminToken, 'invoices.void', { id: inv.id, reason: 'Mistake' }), 'INVALID_STATE');
    const inv2 = await invoiceOf(100000);
    await env.must(env.adminToken, 'invoices.void', { id: inv2.id, reason: 'Created in error' });
    const ov = await env.must<{ outstandingPaisa: number }>(env.adminToken, 'patients.overview', { id: inv2.patientId });
    expect(ov.outstandingPaisa).toBe(0);
  });

  it('statement is arithmetically consistent with the ledger', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env, 'Statement Person');
    const mkInv = (amt: number) => env.must<{ id: string }>(env.adminToken, 'invoices.create', {
      patientId: p.id, lines: [{ description: 'Work', qty: 1, unitPricePaisa: amt }], finalize: true,
    });
    const i1 = await mkInv(100000);
    const i2 = await mkInv(50000);
    await env.must(env.adminToken, 'payments.create', { patientId: p.id, invoiceId: i1.id, amountPaisa: 70000, method: 'cash' });
    const pay2 = await env.must(env.adminToken, 'payments.create', { patientId: p.id, invoiceId: i2.id, amountPaisa: 50000, method: 'bank' });
    const pay2Row = env.db.prepare('SELECT id FROM payments WHERE invoice_id = ? ORDER BY created_at DESC').get(i2.id) as { id: string };
    await env.must(env.adminToken, 'payments.refund', { patientId: p.id, originalPaymentId: pay2Row.id, amountPaisa: 10000, reason: 'r', method: 'bank' });
    await env.must(env.adminToken, 'payments.adjustment', { patientId: p.id, invoiceId: i1.id, amountPaisa: -5000, reason: 'write-off' });
    void pay2;
    const st = await env.must<{
      lines: { balancePaisa: number }[];
      totals: { billedAllTimePaisa: number; paidPaisa: number; refundedPaisa: number; outstandingPaisa: number };
      closingPaisa: number;
    }>(env.adminToken, 'statements.patient', { patientId: p.id });
    expect(st.totals.billedAllTimePaisa).toBe(150000);
    expect(st.totals.paidPaisa).toBe(120000);
    expect(st.totals.refundedPaisa).toBe(10000);
    // outstanding = 150000 - 120000 + 10000 - 5000 = 35000
    expect(st.totals.outstandingPaisa).toBe(35000);
    expect(st.closingPaisa).toBe(35000);
    expect(st.lines[st.lines.length - 1]!.balancePaisa).toBe(35000);
  });

  it('invoice listing paid/part_paid filters are correct', async () => {
    env = await makeTestEnv();
    const inv = await invoiceOf(100000);
    await env.must(env.adminToken, 'payments.create', { patientId: inv.patientId, invoiceId: inv.id, amountPaisa: 100000, method: 'cash' });
    await invoiceOf(100000); // unpaid one
    const paid = await env.must<{ total: number }>(env.adminToken, 'invoices.list', { status: 'paid' });
    expect(paid.total).toBe(1);
    const unpaid = await env.must<{ total: number }>(env.adminToken, 'invoices.list', { status: 'unpaid' });
    expect(unpaid.total).toBe(1);
  });
});
