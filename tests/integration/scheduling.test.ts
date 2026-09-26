import { describe, it, expect, afterEach } from 'vitest';
import { makeTestEnv, TestEnv, seedPatient, expectFail } from '../helpers';

let env: TestEnv;
afterEach(() => env?.cleanup());

describe('appointments & queue', () => {
  it('creates appointments and blocks overlaps for same dentist/chair', async () => {
    env = await makeTestEnv();
    const dr = (await env.must<{ id: string }>(env.adminToken, 'users.create', { username: 'dr1', displayName: 'Dr One', role: 'dentist', password: 'Password1', active: true })).id;
    const p1 = await seedPatient(env, 'Appt A', '01711000001');
    const p2 = await seedPatient(env, 'Appt B', '01711000002');
    await env.must(env.adminToken, 'appointments.create', { patientId: p1.id, dentistId: dr, chair: 'C1', date: '2026-10-05', startTime: '10:00', durationMin: 30, type: 'Consultation' });
    // overlap same dentist
    const e1 = expectFail(await env.call(env.adminToken, 'appointments.create', { patientId: p2.id, dentistId: dr, chair: 'C2', date: '2026-10-05', startTime: '10:15', durationMin: 30, type: 'Filling' }), 'CONFLICT');
    expect(e1.message).toMatch(/overlaps/i);
    // overlap same chair, different dentist
    expectFail(await env.call(env.adminToken, 'appointments.create', { patientId: p2.id, dentistId: null, chair: 'C1', date: '2026-10-05', startTime: '10:29', durationMin: 30 }), 'CONFLICT');
    // back-to-back is fine
    await env.must(env.adminToken, 'appointments.create', { patientId: p2.id, dentistId: dr, chair: 'C1', date: '2026-10-05', startTime: '10:30', durationMin: 30 });
    // different dentist+chair at overlapping time is fine
    await env.must(env.adminToken, 'appointments.create', { patientId: p2.id, dentistId: null, chair: 'C2', date: '2026-10-05', startTime: '10:15', durationMin: 30 });
  });

  it('cancelled appointments release the slot', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    const a1 = await env.must<{ id: string }>(env.adminToken, 'appointments.create', { patientId: p.id, dentistId: null, chair: 'C1', date: '2026-10-06', startTime: '09:00', durationMin: 60 });
    await env.must(env.adminToken, 'appointments.setStatus', { id: a1.id, status: 'cancelled' });
    await env.must(env.adminToken, 'appointments.create', { patientId: p.id, dentistId: null, chair: 'C1', date: '2026-10-06', startTime: '09:00', durationMin: 60 });
  });

  it('status transitions are enforced', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    const a = await env.must<{ id: string }>(env.adminToken, 'appointments.create', { patientId: p.id, dentistId: null, chair: '', date: '2026-10-07', startTime: '11:00', durationMin: 30 });
    expectFail(await env.call(env.adminToken, 'appointments.setStatus', { id: a.id, status: 'completed' }), 'INVALID_STATE');
    await env.must(env.adminToken, 'appointments.setStatus', { id: a.id, status: 'confirmed' });
    await env.must(env.adminToken, 'appointments.setStatus', { id: a.id, status: 'arrived' });
    await env.must(env.adminToken, 'appointments.setStatus', { id: a.id, status: 'in_progress' });
    await env.must(env.adminToken, 'appointments.setStatus', { id: a.id, status: 'completed' });
    expectFail(await env.call(env.adminToken, 'appointments.setStatus', { id: a.id, status: 'scheduled' }), 'INVALID_STATE');
  });

  it('calendar window returns appointments incl. overnight-spanning queries', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    await env.must(env.adminToken, 'appointments.create', { patientId: p.id, dentistId: null, chair: 'C1', date: '2026-10-05', startTime: '00:30', durationMin: 30, type: 'Early' });
    const day = await env.must<{ starts_at: string }[]>(env.adminToken, 'appointments.calendar', { from: '2026-10-05', to: '2026-10-05' });
    expect(day).toHaveLength(1); // 00:30 Dhaka = previous-day 18:30Z - timezone-correct bounds catch it
    const other = await env.must<unknown[]>(env.adminToken, 'appointments.calendar', { from: '2026-10-06', to: '2026-10-06' });
    expect(other).toHaveLength(0);
  });

  it('queue: deterministic serials, duplicate guard, transitions', async () => {
    env = await makeTestEnv();
    const p1 = await seedPatient(env, 'Q One', '01711000001');
    const p2 = await seedPatient(env, 'Q Two', '01711000002');
    const tomorrow = '2026-12-01';
    const e1 = await env.must<{ serial: number }>(env.adminToken, 'queue.add', { patientId: p1.id, date: tomorrow });
    const e2 = await env.must<{ serial: number }>(env.adminToken, 'queue.add', { patientId: p2.id, date: tomorrow });
    expect(e1.serial).toBe(1);
    expect(e2.serial).toBe(2);
    expectFail(await env.call(env.adminToken, 'queue.add', { patientId: p1.id, date: tomorrow }), 'DUPLICATE');
    const list = await env.must<{ entries: { serial: number; status: string; patient_code: string }[] }>(env.adminToken, 'queue.today', { date: tomorrow });
    expect(list.entries).toHaveLength(2);
    expect(list.entries[0]!.patient_code).toBe('P-000001');
    const id1 = list.entries[0]! as { id?: string };
    void id1;
    const full = env.db.prepare('SELECT id FROM queue_entries WHERE day = ? AND serial = 1').get(tomorrow) as { id: string };
    await env.must(env.adminToken, 'queue.setStatus', { id: full.id, status: 'called' });
    await env.must(env.adminToken, 'queue.setStatus', { id: full.id, status: 'in_treatment' });
    expectFail(await env.call(env.adminToken, 'queue.remove', { id: full.id }), 'INVALID_STATE');
    await env.must(env.adminToken, 'queue.setStatus', { id: full.id, status: 'completed' });
    // completed patient can be re-added
    await env.must(env.adminToken, 'queue.add', { patientId: p1.id, date: tomorrow });
    const serials = env.db.prepare('SELECT serial FROM queue_entries WHERE day = ? ORDER BY serial').all(tomorrow) as { serial: number }[];
    expect(serials.map((s) => s.serial)).toEqual([1, 2, 3]);
  });
});
