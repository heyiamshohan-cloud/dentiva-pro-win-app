// Dentiva Pro - test helpers: temp DB + gateway harness (no Electron required).
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, Db } from '../src/main/db/connection';
import { migrate } from '../src/main/db/migrate';
import { createGateway, Gateway } from '../src/main/ipc/gateway';
import { SessionManager } from '../src/main/security/session';
import { IpcResult } from '../src/shared/errors';
import { Role } from '../src/shared/constants';

export interface TestEnv {
  dir: string;
  dbFile: string;
  db: Db;
  gateway: Gateway;
  adminToken: string;
  cleanup(): void;
  tokenFor(role: Role, username: string, password: string): Promise<string>;
  call<T = unknown>(token: string | null, channel: string, payload?: unknown): Promise<IpcResult<T>>;
  must<T = unknown>(token: string, channel: string, payload?: unknown): Promise<T>;
}

export async function makeTestEnv(): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'dentiva-test-'));
  mkdirSync(dir, { recursive: true });
  const dbFile = join(dir, 'dentiva.db');
  const db = openDb(dbFile);
  migrate(db);
  const sessions = new SessionManager(30);
  let lastUsername = 'admin';
  const gateway = createGateway({
    getDb: () => db,
    sessions,
    dbFile,
    dataDir: dir,
    attachmentsDir: join(dir, 'attachments'),
    backupsDir: join(dir, 'backups'),
    docsDir: join(dir, 'documents'),
    relinquishDb: () => { /* single-handle in tests; restore tested via paths API */ },
    reopenDb: () => { /* no-op in tests */ },
    getLastUsername: () => lastUsername,
    setLastUsername: (u) => { lastUsername = u; },
  });
  const setup = await gateway.invoke(null, 'auth.setup', {
    clinicName: 'Test Dental Clinic', adminDisplayName: 'Dr. Admin',
    username: 'admin', password: 'AdminPass1', confirmPassword: 'AdminPass1',
  });
  if (!setup.ok) throw new Error('setup failed: ' + JSON.stringify(setup.error));
  const login = await gateway.invoke(null, 'auth.login', { username: 'admin', password: 'AdminPass1' });
  if (!login.ok) throw new Error('login failed');
  const adminToken = (login.data as { token: string }).token;

  const env: TestEnv = {
    dir, dbFile, db, gateway, adminToken,
    cleanup() {
      sessions.destroyAll();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
    async tokenFor(role: Role, username: string, password: string) {
      const r = await gateway.invoke(adminToken, 'users.create', {
        username, displayName: `${role} user`, role, password, active: true,
      });
      if (!r.ok) throw new Error('user create failed: ' + JSON.stringify(r.error));
      const l = await gateway.invoke(null, 'auth.login', { username, password });
      if (!l.ok) throw new Error('user login failed');
      return (l.data as { token: string }).token;
    },
    async call<T = unknown>(token: string | null, channel: string, payload: unknown = {}) {
      return gateway.invoke(token, channel as never, payload) as Promise<IpcResult<T>>;
    },
    async must<T = unknown>(token: string, channel: string, payload: unknown = {}): Promise<T> {
      const r = await gateway.invoke(token, channel as never, payload) as IpcResult<T>;
      if (!r.ok) throw new Error(`${channel} failed: ${JSON.stringify(r.error)}`);
      return r.data as T;
    },
  };
  return env;
}

export interface PatientSeed { id: string; code: string }

export async function seedPatient(env: TestEnv, name = 'Ayesha Rahman', phone = '01711000001'): Promise<PatientSeed> {
  const p = await env.must<{ id: string; code: string }>(env.adminToken, 'patients.create', {
    name, phone, email: '', gender: 'female', dob: '1990-05-12',
  });
  return { id: p.id, code: p.code };
}

export function okValue<T>(r: IpcResult<T>): T {
  if (!r.ok) throw new Error('expected ok, got: ' + JSON.stringify(r.error));
  return r.data as T;
}

export function expectFail(r: IpcResult<unknown>, code?: string): { code: string; message: string } {
  if (r.ok) throw new Error('expected failure but call succeeded: ' + JSON.stringify(r.data));
  if (code && r.error!.code !== code) throw new Error(`expected error ${code}, got ${r.error!.code}: ${r.error!.message}`);
  return r.error as { code: string; message: string };
}
