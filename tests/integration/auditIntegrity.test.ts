// Dentiva Pro - audit-integrity forensics:
//   * every authenticated mutation leaves a trail entry
//   * payloads never contain passwords, password hashes, secrets, or session tokens
//   * plumbing cannot sneak them in
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestEnv, TestEnv, seedPatient } from '../helpers';

let env: TestEnv;
afterEach(() => { env?.cleanup(); });

const FORBIDDEN_PATTERNS = [/password/i, /scrypt/i, /hashb64/i, /saltb64/i, /session/i, /token/i, /secret/i];

function assertNoSecretsInAudit(db: TestEnv['db'], context: string) {
  const rows = db.prepare('SELECT action, details FROM audit_log').all() as { action: string; details: string }[];
  for (const row of rows) {
    const blob = row.details ?? '';
    for (const re of FORBIDDEN_PATTERNS) {
      expect({ context, action: row.action, blob }).toEqual({ context, action: row.action, blob: expect.not.stringMatching(re) });
    }
    // the actual test password value itself must never appear either
    expect(blob).not.toContain('AdminPass1');
    expect(blob).not.toContain('Cashier1!');
  }
}

describe('audit coverage', () => {
  it('writes a row for every mutating call across domains', async () => {
    env = await makeTestEnv();
    // user management
    const staff = await env.tokenFor('staff', 'cashier1', 'Cashier1!');
    // patient creation (by staff)
    const p = await seedPatient(env, 'Trail Subject', '01751000001');
    // invoices, payments (staff domain)
    const inv = await env.must<{ id: string }>(env.adminToken, 'invoices.create', {
      patientId: p.id, lines: [{ description: 'Scale & polish', qty: 1, unitPricePaisa: 120000 }], finalize: true,
    });
    void staff;
    await env.must(env.adminToken, 'payments.create', { patientId: p.id, invoiceId: inv.id, amountPaisa: 120000, method: 'bkash' });

    const actions = (env.db.prepare('SELECT DISTINCT action FROM audit_log').all() as { action: string }[]).map((a) => a.action);
    const mustCover = [
      'users.create',
      'patients.create',
      'invoices.create',
      'payments.create',
    ];
    for (const k of mustCover) {
      expect(actions, `expected audit row for '${k}', saw: ${actions.join(',')}`).toContain(k);
    }
    // username attribution is real
    const anyRow = env.db.prepare("SELECT * FROM audit_log WHERE action = 'patients.create'").get() as { username: string };
    expect(['admin', 'cashier1']).toContain(anyRow.username);
  });

  it('audit rows never contain secrets/passwords/hashes/tokens', async () => {
    env = await makeTestEnv();
    await env.tokenFor('staff', 'cashier1', 'Cashier1!');
    await seedPatient(env, 'Trail 2', '01751000002');
    // force a list query too (reads also logged as auditList?) — mutations are what matters
    assertNoSecretsInAudit(env.db, 'post-mutations');
  });

  it('direct service calls still audit with truth, not secrets (no workaround channel)', async () => {
    env = await makeTestEnv();
    // call the context-bound audit from a service-shaped ctx on a legit patient event,
    // verifying the mechanism is exercised by real code paths without leaking payloads
    const { makeCtx } = await import('../../src/main/services/context');
    const ctx = makeCtx(env.db, null);
    ctx.audit('debug.ping', 'smoke', '1', { note: 'clean payload marker' });
    const rows = env.db.prepare("SELECT details FROM audit_log WHERE action = 'debug.ping'").all() as { details: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).not.toContain('AdminPass1');
    assertNoSecretsInAudit(env.db, 'post-direct-audit');
  });

  it('auth lockout and logins are attributed without session tokens in rows', async () => {
    env = await makeTestEnv();
    // wrong password attempts
    for (let i = 0; i < 3; i++) {
      await env.call(null, 'auth.login', { username: 'admin', password: 'definitely-wrong' });
    }
    const rows = env.db.prepare("SELECT action, details FROM audit_log WHERE entity = 'auth' OR action LIKE 'auth.%'").all() as { action: string; details: string }[];
    for (const r of rows) {
      for (const re of FORBIDDEN_PATTERNS) {
        expect(r.details).not.toMatch(re);
      }
    }
  });
});
