import { describe, it, expect, afterEach } from 'vitest';
import { makeTestEnv, TestEnv, expectFail } from '../helpers';

let env: TestEnv;
afterEach(() => env?.cleanup());

describe('auth & security foundation', () => {
  it('setup creates admin and persists clinic name', async () => {
    env = await makeTestEnv();
    const st = await env.call(env.adminToken, 'auth.status');
    expect(st.ok).toBe(true);
    const s = await env.must<{ clinicName: string }>(env.adminToken, 'settings.get');
    expect(s.clinicName).toBe('Test Dental Clinic');
  });

  it('second setup is blocked', async () => {
    env = await makeTestEnv();
    expectFail(await env.call(null, 'auth.setup', {
      clinicName: 'X', adminDisplayName: 'Y', username: 'anotheradmin', password: 'Password1', confirmPassword: 'Password1',
    }), 'INVALID_STATE');
  });

  it('unauthenticated calls are rejected', async () => {
    env = await makeTestEnv();
    expectFail(await env.call(null, 'patients.list', { page: 1, pageSize: 10 }), 'UNAUTHENTICATED');
    expectFail(await env.call('deadbeef-token', 'patients.list', {}), 'UNAUTHENTICATED');
  });

  it('wrong password fails and locks out after repeated attempts', async () => {
    env = await makeTestEnv();
    for (let i = 0; i < 5; i++) {
      expectFail(await env.call(null, 'auth.login', { username: 'admin', password: 'wrong' }), 'UNAUTHENTICATED');
    }
    const locked = expectFail(await env.call(null, 'auth.login', { username: 'admin', password: 'AdminPass1' }), 'FORBIDDEN');
    expect(locked.message).toMatch(/locked/i);
  });

  it('nonexistent user fails with same error shape (no oracle)', async () => {
    env = await makeTestEnv();
    const a = expectFail(await env.call(null, 'auth.login', { username: 'ghost', password: 'whatever' }));
    const b = expectFail(await env.call(null, 'auth.login', { username: 'admin', password: 'wrong' }));
    expect(a.code).toBe(b.code);
  });

  it('RBAC: receptionist forbidden from admin operations', async () => {
    env = await makeTestEnv();
    const token = await env.tokenFor('receptionist', 'recep1', 'RecepPass1');
    expectFail(await env.call(token, 'users.create', { username: 'someuser1', displayName: 'x', role: 'admin', password: 'Password1' }), 'FORBIDDEN');
    expectFail(await env.call(token, 'settings.update', { clinicName: 'Hack' }), 'FORBIDDEN');
    expectFail(await env.call(token, 'payments.refund', { patientId: '3b241101-e2bb-4255-8caf-4136c566a962', originalPaymentId: '3b241101-e2bb-4255-8caf-4136c566a962', amountPaisa: 1, reason: 'r', method: 'cash' }), 'FORBIDDEN');
    // but can do receptionist work
    const p = await env.call(token, 'patients.create', { name: 'Allowed Patient' });
    expect(p.ok).toBe(true);
  });

  it('RBAC: dentist cannot receive payments', async () => {
    env = await makeTestEnv();
    const token = await env.tokenFor('dentist', 'dent1', 'DentPass11');
    expectFail(await env.call(token, 'payments.create', {
      patientId: '3b241101-e2bb-4255-8caf-4136c566a962', invoiceId: '3b241101-e2bb-4255-8caf-4136c566a962', amountPaisa: 100, method: 'cash',
    }), 'FORBIDDEN');
  });

  it('malformed payloads are rejected with VALIDATION, never crash', async () => {
    env = await makeTestEnv();
    expectFail(await env.call(env.adminToken, 'patients.create', 'a string'), 'VALIDATION');
    expectFail(await env.call(env.adminToken, 'patients.create', { name: 42 }), 'VALIDATION');
    expectFail(await env.call(env.adminToken, 'invoices.create', { patientId: 'not-a-uuid', lines: [{ description: 'x', unitPricePaisa: 'lots' }] }), 'VALIDATION');
  });

  it('unknown channels are rejected', async () => {
    env = await makeTestEnv();
    const r = await env.call(env.adminToken, 'secret.backdoor', {});
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('VALIDATION');
  });

  it('passwords are scrypt-hashed (never plaintext) and secrets redacted from audit', async () => {
    env = await makeTestEnv();
    const row = env.db.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin') as { password_hash: string };
    expect(row.password_hash.startsWith('s2$')).toBe(true);
    expect(row.password_hash).not.toContain('AdminPass1');
    const audit = env.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE details LIKE '%AdminPass1%'").get() as { c: number };
    expect(audit.c).toBe(0);
  });

  it('logout invalidates the session', async () => {
    env = await makeTestEnv();
    await env.must(env.adminToken, 'auth.logout');
    expectFail(await env.call(env.adminToken, 'patients.list', {}), 'UNAUTHENTICATED');
  });

  it('cannot deactivate the last active administrator', async () => {
    env = await makeTestEnv();
    const admins = env.db.prepare("SELECT id FROM users WHERE role='admin'").all() as { id: string }[];
    const r = await env.call(env.adminToken, 'users.update', { id: admins[0]!.id, displayName: 'Admin', role: 'staff', active: false });
    expectFail(r, 'INVALID_STATE');
  });
});
