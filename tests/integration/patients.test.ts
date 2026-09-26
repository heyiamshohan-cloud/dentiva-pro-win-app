import { describe, it, expect, afterEach } from 'vitest';
import { makeTestEnv, TestEnv, seedPatient, expectFail } from '../helpers';

let env: TestEnv;
afterEach(() => env?.cleanup());

describe('patients: codes, dedupe, 360, timeline, merge', () => {
  it('assigns stable sequential patient codes that survive edits', async () => {
    env = await makeTestEnv();
    const p1 = await seedPatient(env, 'First Patient', '01711000001');
    const p2 = await seedPatient(env, 'Second Patient', '01711000002');
    expect(p1.code).toBe('P-000001');
    expect(p2.code).toBe('P-000002');
    await env.must(env.adminToken, 'patients.update', { id: p1.id, name: 'Renamed Patient', phone: '01711000001' });
    const after = await env.must<{ code: string; name: string }>(env.adminToken, 'patients.get', { id: p1.id });
    expect(after.code).toBe('P-000001');
    expect(after.name).toBe('Renamed Patient');
    // next patient gets the next code (no reuse)
    const p3 = await seedPatient(env, 'Third', '01711000003');
    expect(p3.code).toBe('P-000003');
  });

  it('hard-blocks exact phone duplicates with actionable error', async () => {
    env = await makeTestEnv();
    await seedPatient(env, 'Dup A', '01755500001');
    const e = expectFail(await env.call(env.adminToken, 'patients.create', { name: 'Dup B', phone: '01755500001' }), 'DUPLICATE');
    expect(e.message).toContain('P-000001');
  });

  it('duplicate probe surfaces name+dob and email matches', async () => {
    env = await makeTestEnv();
    await env.must(env.adminToken, 'patients.create', { name: 'Rina Begum', dob: '1985-03-02', email: 'rina@example.com' });
    const out = await env.must<{ matchKinds: string[] }[]>(env.adminToken, 'patients.duplicates', { name: 'Rina Begum', dob: '1985-03-02', email: 'rina@example.com' });
    expect(out.length).toBe(1);
    expect(out[0]!.matchKinds).toEqual(expect.arrayContaining(['name+dob', 'email']));
  });

  it('delete is blocked when linked history exists; archive works', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    await env.must(env.adminToken, 'visits.create', { patientId: p.id, chiefComplaint: 'Pain On' });
    const e = expectFail(await env.call(env.adminToken, 'patients.delete', { id: p.id }), 'INVALID_STATE');
    expect(e.message).toMatch(/Archive/i);
    await env.must(env.adminToken, 'patients.archive', { id: p.id });
    const list = await env.must<{ total: number }>(env.adminToken, 'patients.list', { page: 1, pageSize: 10 });
    expect(list.total).toBe(0);
    const archived = await env.must<{ total: number }>(env.adminToken, 'patients.list', { page: 1, pageSize: 10, archived: true });
    expect(archived.total).toBe(1);
    // restore brings the patient back to the active registry and audits the action
    await env.must(env.adminToken, 'patients.restore', { id: p.id });
    const active = await env.must<{ total: number }>(env.adminToken, 'patients.list', { page: 1, pageSize: 10 });
    expect(active.total).toBe(1);
    expectFail(await env.call(env.adminToken, 'patients.restore', { id: p.id }), 'INVALID_STATE');
  });

  it('list pagination returns real totals and slices', async () => {
    env = await makeTestEnv();
    for (let i = 1; i <= 37; i++) await seedPatient(env, `Patient ${String(i).padStart(3, '0')}`, `01711000${String(i).padStart(3, '0')}`);
    const page2 = await env.must<{ total: number; totalPages: number; rows: unknown[] }>(env.adminToken, 'patients.list', { page: 2, pageSize: 25 });
    expect(page2.total).toBe(37);
    expect(page2.totalPages).toBe(2);
    expect(page2.rows).toHaveLength(12);
  });

  it('search finds by name fragment, code, phone', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env, 'Mahbubul Alam', '01812345678');
    const byName = await env.must<{ total: number }>(env.adminToken, 'patients.list', { page: 1, pageSize: 10, q: 'mahbub' });
    expect(byName.total).toBe(1);
    const byCode = await env.must<{ total: number }>(env.adminToken, 'patients.list', { page: 1, pageSize: 10, q: p.code });
    expect(byCode.total).toBe(1);
    const byPhone = await env.must<{ total: number }>(env.adminToken, 'patients.list', { page: 1, pageSize: 10, q: '812345' });
    expect(byPhone.total).toBe(1);
  });

  it('medical items CRUD with kinds separated', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    await env.must(env.adminToken, 'patients.medical.add', { patientId: p.id, item: { kind: 'allergy', value: 'Penicillin', notes: 'Rash', active: true } });
    await env.must(env.adminToken, 'patients.medical.add', { patientId: p.id, item: { kind: 'condition', value: 'Diabetes Type 2', notes: '', active: true } });
    const list = await env.must<{ kind: string; value: string }[]>(env.adminToken, 'patients.medical.list', { patientId: p.id });
    expect(list).toHaveLength(2);
    expect(new Set(list.map((m) => m.kind))).toEqual(new Set(['allergy', 'condition']));
  });

  it('Patient 360 overview reports real counts and outstanding', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    await env.must(env.adminToken, 'visits.create', { patientId: p.id, chiefComplaint: 'Pain On' });
    const inv = await env.must<{ id: string }>(env.adminToken, 'invoices.create', {
      patientId: p.id, lines: [{ description: 'Consultation', qty: 1, unitPricePaisa: 100000 }], finalize: true,
    });
    await env.must(env.adminToken, 'payments.create', { patientId: p.id, invoiceId: inv.id, amountPaisa: 40000, method: 'cash' });
    const ov = await env.must<{ counts: { visits: number; invoices: number }; outstandingPaisa: number; patient: { code: string } }>(
      env.adminToken, 'patients.overview', { id: p.id });
    expect(ov.counts.visits).toBe(1);
    expect(ov.counts.invoices).toBe(1);
    expect(ov.outstandingPaisa).toBe(60000);
    expect(ov.patient.code).toBe('P-000001');
  });

  it('timeline never truncates: keyset pagination walks entire history', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    for (let i = 0; i < 120; i++) {
      await env.must(env.adminToken, 'visits.create', { patientId: p.id, chiefComplaint: `Visit ${i}` });
    }
    let cursor: string | undefined;
    let seen = 0;
    let guard = 0;
    const kinds = new Set<string>();
    do {
      const page = await env.must<{ events: { kind: string }[]; nextCursor: string | null }>(
        env.adminToken, 'patients.timeline', { patientId: p.id, cursor, limit: 50 });
      seen += page.events.length;
      page.events.forEach((e) => kinds.add(e.kind));
      cursor = page.nextCursor ?? undefined;
      guard += 1;
    } while (cursor && guard < 10);
    expect(seen).toBe(120);
    expect(kinds.has('visit')).toBe(true);
  });

  it('merge moves history to the kept patient and archives the duplicate', async () => {
    env = await makeTestEnv();
    const keep = await seedPatient(env, 'Keep Patient', '01711000001');
    const drop = await seedPatient(env, 'Drop Patient', '01711000002');
    await env.must(env.adminToken, 'visits.create', { patientId: drop.id, chiefComplaint: 'old visit' });
    await env.must(env.adminToken, 'patients.merge', { keepId: keep.id, removeId: drop.id });
    const ov = await env.must<{ counts: { visits: number } }>(env.adminToken, 'patients.overview', { id: keep.id });
    expect(ov.counts.visits).toBe(1);
    const gone = await env.must<{ archived_at: string | null }>(env.adminToken, 'patients.get', { id: drop.id });
    expect(gone.archived_at).not.toBeNull();
    const keepCode = await env.must<{ code: string }>(env.adminToken, 'patients.get', { id: keep.id });
    expect(keepCode.code).toBe('P-000001');
  });

  it('audit log captured patient lifecycle', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    const rows = await env.must<{ rows: { action: string }[] }>(env.adminToken, 'audit.list', { entity: 'patients', pageSize: 50 });
    expect(rows.rows.some((a) => a.action === 'patients.create')).toBe(true);
    void p;
  });
});
