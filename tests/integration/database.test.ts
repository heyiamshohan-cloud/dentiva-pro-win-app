import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, integrityCheck, nextSeq } from '../../src/main/db/connection';
import { migrate } from '../../src/main/db/migrate';
import type Database from 'better-sqlite3';

let db: Database.Database | null = null;
let dir = '';

function freshDb() {
  dir = mkdtempSync(join(tmpdir(), 'dentiva-db-'));
  db = openDb(join(dir, 'x.db'));
  return db;
}

afterEach(() => {
  db?.close(); db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('database: migrations', () => {
  it('creates full schema with version tracking', () => {
    const d = freshDb();
    const r1 = migrate(d);
    expect(r1.applied).toEqual(['0001_init', '0002_patient_blood_group']);
    expect(d.pragma('user_version', { simple: true })).toBe(2);
    const r2 = migrate(d);
    expect(r2.applied).toEqual([]); // idempotent
    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['patients', 'visits', 'prescriptions', 'invoices', 'payments', 'inventory_items', 'appointments', 'queue_entries', 'audit_log', 'dental_chart']) {
      expect(tables).toContain(t);
    }
  });
  it('adds blood_group to patients (idempotent)', () => {
    const d = freshDb(); migrate(d); migrate(d);
    const cols = (d.prepare("PRAGMA table_info('patients')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('blood_group');
  });
  it('passes integrity check', () => {
    const d = freshDb(); migrate(d);
    expect(integrityCheck(d).ok).toBe(true);
  });
  it('has WAL + foreign keys enabled', () => {
    const d = freshDb(); migrate(d);
    expect(d.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(d.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('database: invariant constraints', () => {
  it('invoice equation is enforced by CHECK', () => {
    const d = freshDb(); migrate(d);
    d.prepare("INSERT INTO patients(id, code, name, name_lower, created_at, updated_at) VALUES ('p1','P-000001','X','x','2026-01-01','2026-01-01')").run();
    const ok = () => d.prepare(
      `INSERT INTO invoices(id, invoice_no, patient_id, date, status, subtotal_paisa, discount_paisa, tax_paisa, total_paisa, created_at, updated_at)
       VALUES ('i1','INV-1','p1','2026-01-01','final', 1000, 100, 50, 950, '2026-01-01','2026-01-01')`,
    ).run();
    expect(ok).not.toThrow();
    const bad = () => d.prepare(
      `INSERT INTO invoices(id, invoice_no, patient_id, date, status, subtotal_paisa, discount_paisa, tax_paisa, total_paisa, created_at, updated_at)
       VALUES ('i2','INV-2','p1','2026-01-01','final', 1000, 100, 50, 999, '2026-01-01','2026-01-01')`,
    ).run();
    expect(bad).toThrow(/CHECK/);
  });
  it('line total must equal qty*unit-discount', () => {
    const d = freshDb(); migrate(d);
    d.prepare("INSERT INTO patients(id, code, name, name_lower, created_at, updated_at) VALUES ('p1','P-1','X','x','2026-01-01','2026-01-01')").run();
    d.prepare(`INSERT INTO invoices(id, invoice_no, patient_id, date, status, subtotal_paisa, discount_paisa, tax_paisa, total_paisa, created_at, updated_at)
       VALUES ('i1','INV-1','p1','2026-01-01','final', 1000, 0, 0, 1000, '2026-01-01','2026-01-01')`).run();
    expect(() => d.prepare(`INSERT INTO invoice_items(id, invoice_id, description, qty, unit_price_paisa, discount_paisa, line_total_paisa) VALUES ('l1','i1','X',2,500,0,999)`).run()).toThrow(/CHECK/);
  });
  it('negative stock impossible via CHECK', () => {
    const d = freshDb(); migrate(d);
    d.prepare(`INSERT INTO inventory_items(id, sku, name, qty_on_hand, created_at, updated_at) VALUES ('it1','S1','Gauze',0,'2026-01-01','2026-01-01')`).run();
    expect(() => d.prepare('UPDATE inventory_items SET qty_on_hand = -1 WHERE id = ?').run('it1')).toThrow(/CHECK/);
  });
  it('payment FK + positive amount enforced', () => {
    const d = freshDb(); migrate(d);
    d.prepare("INSERT INTO patients(id, code, name, name_lower, created_at, updated_at) VALUES ('p1','P-1','X','x','2026-01-01','2026-01-01')").run();
    expect(() => d.prepare(`INSERT INTO payments(id, receipt_no, patient_id, date, method, amount_paisa, created_at) VALUES ('x1','R-1','nope','2026-01-01','cash',100,'2026-01-01')`).run()).toThrow(/FOREIGN KEY/);
    expect(() => d.prepare(`INSERT INTO payments(id, receipt_no, patient_id, date, method, amount_paisa, created_at) VALUES ('x2','R-2','p1','2026-01-01','cash',0,'2026-01-01')`).run()).toThrow(/CHECK/);
  });
  it('sequences are atomic and monotonic across transactions', () => {
    const d = freshDb(); migrate(d);
    const values = d.transaction(() => [nextSeq(d, 'patient'), nextSeq(d, 'patient'), nextSeq(d, 'patient')])();
    expect(values).toEqual([1, 2, 3]);
  });
  it('FTS triggers keep index in sync', () => {
    const d = freshDb(); migrate(d);
    d.prepare("INSERT INTO patients(id, code, name, name_lower, phone, created_at, updated_at) VALUES ('p1','P-000001','Shirin Akter','shirin akter','01711111111','2026-01-01','2026-01-01')").run();
    const hit = d.prepare("SELECT patient_id FROM patients_fts WHERE patients_fts MATCH 'shirin'").all();
    expect(hit).toHaveLength(1);
    d.prepare('DELETE FROM patients WHERE id = ?').run('p1');
    expect(d.prepare("SELECT patient_id FROM patients_fts WHERE patients_fts MATCH 'shirin'").all()).toHaveLength(0);
  });
});
