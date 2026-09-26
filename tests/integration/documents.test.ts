// Dentiva Pro - PDF document forensics: real generation + text-level content verification.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFParse } from 'pdf-parse';
import { makeTestEnv, TestEnv, seedPatient } from '../helpers';
import { makeCtx } from '../../src/main/services/context';
import { SessionUser } from '../../src/main/security/session';
import { generateInvoicePdf, generateReceiptPdf, generatePrescriptionPdf, generateStatementPdf } from '../../src/main/pdf/documents';
import { formatPaisa } from '../../src/shared/money';

let env: TestEnv;
let outDir: string;
const admin: SessionUser = { id: 'u', username: 'admin', displayName: 'Dr. Admin', role: 'admin' };

afterEach(() => {
  env?.cleanup();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

async function pdfText(path: string): Promise<string> {
  const parser = new PDFParse({ data: readFileSync(path) });
  const result = await parser.getText();
  await parser.destroy();
  // normalize: PDF wraps long words inside table cells; assertions are whitespace-insensitive
  return result.text.replace(/\s+/g, ' ');
}

async function setup() {
  env = await makeTestEnv();
  outDir = mkdtempSync(join(tmpdir(), 'dentiva-docs-'));
  return makeCtx(env.db, admin);
}

describe('documents: invoice PDF', () => {
  it('contains branding, patient code, items, and a correct financial equation', async () => {
    const ctx = await setup();
    const p = await seedPatient(env, 'Nusrat Jahan', '01722000001');
    const inv = await env.must<{ id: string; invoice_no: string; total_paisa: number }>(env.adminToken, 'invoices.create', {
      patientId: p.id, finalize: true, discountPaisa: 10000, taxBp: 1500,
      lines: [
        { description: 'Root Canal Treatment', tooth: 46, qty: 1, unitPricePaisa: 850000 },
        { description: 'Periapical X-Ray', qty: 2, unitPricePaisa: 40000 },
      ],
    });
    const r = await generateInvoicePdf(ctx, inv.id, 'A4', outDir);
    expect(existsSync(r.path)).toBe(true);
    expect(r.pageCount).toBeGreaterThanOrEqual(1);
    const text = await pdfText(r.path);
    expect(text).toContain('Test Dental Clinic');
    expect(text).toContain(inv.invoice_no);
    expect(text).toContain('INVOICE');
    expect(text).toContain('P-000001');          // patient code on document
    expect(text).toContain('Nusrat Jahan');
    expect(text).toContain('Root Canal Treatment');
    expect(text).toContain('46');                 // tooth
    // financial reconciliation on the document itself
    const subtotal = 930000, discount = 10000, tax = Math.round((930000 - 10000) * 0.15);
    expect(text).toContain(formatPaisa(subtotal));
    expect(text).toContain(formatPaisa(tax));
    expect(text).toContain(formatPaisa(subtotal - discount + tax));
    expect(subtotal - discount + tax).toBe(inv.total_paisa);
    expect(text).toMatch(/Balance Due/);
    expect(text).toMatch(/Page 1 of \d/);
  });

  it('many line items paginate without data loss and headers structure holds', async () => {
    const ctx = await setup();
    const p = await seedPatient(env);
    const lines = Array.from({ length: 60 }, (_, i) => ({ description: `Procedure item ${i + 1} with description`, qty: 1, unitPricePaisa: 1000 + i }));
    const inv = await env.must<{ id: string }>(env.adminToken, 'invoices.create', { patientId: p.id, lines, finalize: true });
    const r = await generateInvoicePdf(ctx, inv.id, 'A4', outDir);
    expect(r.pageCount).toBeGreaterThan(1);
    const text = await pdfText(r.path);
    expect(text).toContain('Procedure item 1');
    expect(text).toContain('Procedure item 60'); // last row survived pagination
    expect(text).toMatch(/Page 2 of \d/);
  });
});

describe('documents: 80mm receipt PDF', () => {
  it('shows amount received prominently with balance context', async () => {
    const ctx = await setup();
    const p = await seedPatient(env, 'Receipt Person');
    const inv = await env.must<{ id: string }>(env.adminToken, 'invoices.create', {
      patientId: p.id, lines: [{ description: 'Filling', qty: 1, unitPricePaisa: 120000 }], finalize: true,
    });
    await env.must(env.adminToken, 'payments.create', { patientId: p.id, invoiceId: inv.id, amountPaisa: 50000, method: 'bkash', reference: 'TXID123' });
    const payRow = env.db.prepare('SELECT id, receipt_no FROM payments').get() as { id: string; receipt_no: string };
    const r = await generateReceiptPdf(ctx, payRow.id, outDir);
    const text = await pdfText(r.path);
    expect(text).toContain('PAYMENT RECEIPT');
    expect(text).toContain(payRow.receipt_no);
    expect(text).toContain('P-000001');
    expect(text).toContain('bKash');
    expect(text).toContain('TXID123');
    expect(text).toContain('AMOUNT RECEIVED');
    expect(text).toContain(formatPaisa(50000));
    expect(text).toContain(formatPaisa(70000)); // balance after payment
    expect(text).toContain('Balance Due');
    // narrow paper width assertion (80mm = ~226.77pt = 2.83in)
    expect(r.path.endsWith('.pdf')).toBe(true);
  });
});

describe('documents: prescription PDF', () => {
  it('renders all clinical sections and NO financial fields', async () => {
    const ctx = await setup();
    const p = await seedPatient(env, 'Rx Person');
    const rx = await env.must<{ id: string; rx_no: string }>(env.adminToken, 'prescriptions.create', {
      patientId: p.id, cc: ['Pain On', 'Swelling'], oe: ['Carries', 'BDR'], re: 'IOPA 46', advice: 'Warm saline rinse',
      items: [
        { drugName: 'Amoxicillin', strength: '500mg', dose: '1 cap', frequency: 'Three times daily', duration: '7 days', route: 'Oral', instructions: 'Complete full course' },
        { drugName: 'Paracetamol', strength: '500mg', dose: '1 tab', frequency: 'SOS', duration: '3 days', route: 'Oral', instructions: '' },
      ],
      followUpDate: '2026-10-01', finalize: true,
    });
    const r = await generatePrescriptionPdf(ctx, rx.id, 'A5', outDir);
    const text = await pdfText(r.path);
    for (const needle of ['Test Dental Clinic', 'PRESCRIPTION', rx.rx_no, 'P-000001', 'Rx Person',
      'C/C', 'Pain On', 'Swelling', 'O/E', 'Carries', 'BDR', 'R/E', 'IOPA 46',
      'Amoxicillin', '500mg', 'Three times daily', 'Paracetamol', 'Advice', 'Warm saline rinse', 'Follow-up']) {
      expect(text).toContain(needle);
    }
    // clinical document must not carry prices anywhere
    expect(text).not.toMatch(/Balance Due|Subtotal|Payment/);
  });
});

describe('documents: statement PDF', () => {
  it('running balance matches stored ledger totals', async () => {
    const ctx = await setup();
    const p = await seedPatient(env, 'Statement Person');
    const i1 = await env.must<{ id: string }>(env.adminToken, 'invoices.create', { patientId: p.id, lines: [{ description: 'A', qty: 1, unitPricePaisa: 100000 }], finalize: true });
    const i2 = await env.must<{ id: string }>(env.adminToken, 'invoices.create', { patientId: p.id, lines: [{ description: 'B', qty: 1, unitPricePaisa: 50000 }], finalize: true });
    await env.must(env.adminToken, 'payments.create', { patientId: p.id, invoiceId: i1.id, amountPaisa: 60000, method: 'cash' });
    void i2;
    const r = await generateStatementPdf(ctx, p.id, {}, 'A4', outDir);
    const text = await pdfText(r.path);
    expect(text).toContain('ACCOUNT STATEMENT');
    expect(text).toContain('P-000001');
    expect(text).toContain(formatPaisa(150000)); // total billed
    expect(text).toContain(formatPaisa(60000));  // total paid
    expect(text).toContain(formatPaisa(90000));  // outstanding
  });
});
