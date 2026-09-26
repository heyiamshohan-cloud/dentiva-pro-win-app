// Dentiva Pro — scale/perf release gate.
// Asserts BOTH correctness at scale AND performance budgets.
// Run with: npm run perf  (10K default). Override with DENTIVA_SCALE env var (1000..100000).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/connection';
import { migrate } from '../../src/main/db/migrate';
import { makeCtx, tx } from '../../src/main/services/context';
import { createPatient, listPatients } from '../../src/main/services/patients';
import { hashPassword } from '../../src/main/security/crypto';
import { uuid } from '../../src/shared/ids';
import { nowIso } from '../../src/shared/dates';
import { SessionUser } from '../../src/main/security/session';

/** Direct admin seed (mirrors setupInitial's SQL — keeps perf bootstraps light). */
function seedAdmin(db: Database.Database): SessionUser {
  const now = nowIso();
  const id = uuid();
  db.prepare(
    `INSERT INTO users(id, username, display_name, password_hash, role, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, 'perfadmin', 'Perf Admin', hashPassword('PerfPass1'), 'admin', 1, now, now);
  return { id, username: 'perfadmin', displayName: 'Perf Admin', role: 'admin' };
}
import { patientInput } from '../../src/shared/validation/patients';
import { invoiceInput, paymentInput } from '../../src/shared/validation/finance';
import { patientListQuery } from '../../src/shared/validation/patients';
import { entitySearch, globalSearch } from '../../src/main/services/search';
import { createInvoice } from '../../src/main/services/invoices';
import { createPayment } from '../../src/main/services/payments';
import { dashboard } from '../../src/main/services/dashboard';
import type Database from 'better-sqlite3';

const N = Math.max(1000, Math.min(100_000, Number(process.env.DENTIVA_SCALE ?? 10_000)));
const BUDGETS = {
  seedPer1Kms: Number(process.env.DENTIVA_SEED_BUDGET_MS ?? 6_000),
  searchMs: Number(process.env.DENTIVA_SEARCH_BUDGET_MS ?? 500),
  listMs: Number(process.env.DENTIVA_LIST_BUDGET_MS ?? 800),
  dashboardMs: Number(process.env.DENTIVA_DASH_BUDGET_MS ?? 1500),
};

let dir: string;
let db: Database.Database;
let ctx: ReturnType<typeof makeCtx>;
let firstPatientId = '';
let lastPatientId = '';
const timings: Record<string, number> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dentiva-scale-'));
  db = openDb(join(dir, 'scale.db'));
  migrate(db);
  const admin = seedAdmin(db);
  ctx = makeCtx(db, admin);
  console.log(`[perf] seeding ${N.toLocaleString()} patients…`);
  const t0 = performance.now();
  const chunk = 500;
  let created = 0;
  while (created < N) {
    const take = Math.min(chunk, N - created);
    tx(db, () => {
      for (let i = 0; i < take; i++) {
        const n = created + i;
        const p = patientInput.parse({
          name: `Patient ${String(n).padStart(7, '0')} Surname${n % 1000}`,
          phone: `0171${String(n).padStart(7, '0')}`,
          email: n % 7 === 0 ? `patient${n}@example.com` : '',
          gender: n % 2 === 0 ? 'male' : 'female',
          address: `House ${n}, Road ${(n % 40) + 1}, Gulshan`,
        });
        const r = createPatient(ctx, p);
        if (n === 0) firstPatientId = r.id;
        if (n === N - 1) lastPatientId = r.id;
      }
    });
    created += take;
    if (created % 5000 === 0 || created === N) console.log(`[perf]   …${created.toLocaleString()}`);
  }
  timings.seed = performance.now() - t0;
  console.log(`[perf] seed complete in ${(timings.seed / 1000).toFixed(1)}s (${((timings.seed / N) * 1000).toFixed(1)}µs/patient)`);
  expect(timings.seed / (N / 1000)).toBeLessThan(BUDGETS.seedPer1Kms);
}, 30 * 60_000);

afterAll(() => {
  try { db.close(); } catch { /* noop */ }
  rmSync(dir, { recursive: true, force: true });
  console.log('[perf] timings:', Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, `${v.toFixed(0)}ms`])));
});

function timed<T>(key: string, fn: () => T): T {
  const t = performance.now();
  const r = fn();
  timings[key] = performance.now() - t;
  return r;
}

describe('no record-limit regressions', () => {
  it('DB really contains N patients (count via parameter, never hardcoded)', () => {
    const c = (db.prepare("SELECT COUNT(*) AS c FROM patients WHERE archived_at IS NULL").get() as { c: number }).c;
    expect(c).toBe(N);
  });

  it('paginate fully reads all pages with correct totals', () => {
    const pageSize = 200;
    let page = 1;
    let read = 0;
    for (;;) {
      const res = listPatients(ctx, { page, pageSize, q: '', archived: false, tag: '', sortBy: 'created_at', sortDir: 'asc' });
      expect(res.total).toBe(N);
      read += res.rows.length;
      if (res.rows.length < pageSize) break;
      page += 1;
    }
    expect(read).toBe(N);
  });
});

describe('search at scale', () => {
  it('unique phone match returns in budget', () => {
    const phone = `0171${String(N - 10).padStart(7, '0')}`;
    const hits = timed('searchPhone', () => globalSearch(ctx, phone, 20));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(timings.searchPhone!).toBeLessThan(BUDGETS.searchMs);
  });

  it('name search not degraded by table size', () => {
    const hits = timed('searchName', () => globalSearch(ctx, 'Surname999', 20));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(timings.searchName!).toBeLessThan(BUDGETS.searchMs);
  });

  it('patient code lookup stays fast', () => {
    const hits = timed('searchCode', () => globalSearch(ctx, 'P-000001', 20));
    expect(hits.length).toBe(1);
    expect(timings.searchCode!).toBeLessThan(BUDGETS.searchMs);
  });

  it('paginated entity search keeps real totals', () => {
    const res = timed('searchEntity', () => entitySearch(ctx, 'patients', 'Surname999', 1, 50));
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(timings.searchEntity!).toBeLessThan(BUDGETS.searchMs);
  });
});

describe('financial core at scale', () => {
  it('invoice + payment equation holds', () => {
    const inv = createInvoice(ctx, invoiceInput.parse({
      patientId: firstPatientId,
      discountPaisa: 5000,
      taxBp: 1500,
      notes: 'scale',
      finalize: true,
      lines: [{ description: 'Scale visit', tooth: 11, qty: 2, unitPricePaisa: 25000 }],
    }))!;
    expect(inv).not.toBeNull();
    // subtotal 50000 - 5000 = 45000; +15% → 6750 → total 51750
    expect(inv.total_paisa).toBe(51750);
    createPayment(ctx, paymentInput.parse({
      patientId: firstPatientId, invoiceId: inv.id, amountPaisa: 10000, method: 'cash',
    }));
    const bal = db.prepare('SELECT total_paisa, paid_paisa FROM invoices WHERE id = ?').get(inv.id) as { total_paisa: number; paid_paisa: number };
    expect(bal.total_paisa - bal.paid_paisa).toBe(41750);
  });
});

describe('dashboard at scale', () => {
  it('aggregates the whole dataset in budget', () => {
    const d = timed('dashboard', () => dashboard(ctx));
    // created today: seeded patients count appears somewhere (recentPatients length bounded)
    expect(d.outstanding).toBeDefined();
    expect(d.collections).toBeDefined();
    expect(timings.dashboard!).toBeLessThan(BUDGETS.dashboardMs);
  });
});

describe('memory & pathological-input guards', () => {
  it('page size is hard-clamped by the boundary schema (1_000_000 rejected)', () => {
    // the gateway parses every payload through zod before SQL sees it
    expect(() => patientListQuery.parse({ page: 1, pageSize: 1_000_000 })).toThrow();
    const legit = patientListQuery.parse({ page: 1, pageSize: 200 });
    expect(legit.pageSize).toBe(200);
  });

  it('freshly inserted patient is immediately searchable (FTS trigger integrity)', () => {
    const r = createPatient(ctx, patientInput.parse({ name: 'Findable Snowflake', phone: '01988776655', gender: 'other' }));
    const hits = globalSearch(ctx, 'Findable Snowflake', 20);
    expect(hits.some((g) => g.rows.some((row) => row.id === r.id))).toBe(true);
  });
});
