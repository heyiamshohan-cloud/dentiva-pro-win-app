// Dentiva Pro - users & authentication service.
import { err } from '../../shared/errors';
import { uuid } from '../../shared/ids';
import { nowIso } from '../../shared/dates';
import { Role } from '../../shared/constants';
import { Ctx, tx, hasUsers, DEFAULT_CLINIC } from './context';
import { setSetting } from '../db/connection';
import { hashPassword, verifyPassword } from '../security/crypto';
import { SetupInput, LoginInput, UserInput, UserUpdate } from '../../shared/validation/system';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  active: number;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
}

const LOCK_AFTER = 5;
const LOCK_MINUTES = 10;

export function listUsers(ctx: Ctx): Omit<UserRow, never>[] {
  return ctx.db
    .prepare('SELECT id, username, display_name, role, active, failed_attempts, locked_until, last_login_at, created_at FROM users ORDER BY username')
    .all() as UserRow[];
}

export function setupInitial(ctx: Ctx, input: SetupInput): { userId: string } {
  if (hasUsers(ctx.db)) throw err.invalidState('Initial setup has already been completed.');
  return tx(ctx.db, () => {
    const id = uuid();
    ctx.db
      .prepare(
        `INSERT INTO users(id, username, display_name, password_hash, role, active, created_at, updated_at)
         VALUES (?,?,?,?,?,1,?,?)`,
      )
      .run(id, input.username, input.adminDisplayName, hashPassword(input.password), 'admin', nowIso(), nowIso());
    setSetting(ctx.db, 'clinic_profile', { ...DEFAULT_CLINIC, clinicName: input.clinicName });
    ctx.audit('auth.setup', 'users', id, { clinic: input.clinicName });
    return { userId: id };
  });
}

export function authenticate(ctx: Ctx, input: LoginInput): { id: string; username: string; displayName: string; role: Role } {
  const row = ctx.db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(input.username) as (UserRow & { password_hash: string; displayName?: string; display_name: string }) | undefined;
  // Constant-shape failure: verify against a dummy hash when user does not exist.
  const dummy = 's2$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$' + '0'.repeat(88);
  if (!row) {
    verifyPassword(input.password, dummy);
    throw err.unauthenticated();
  }
  if (!row.active) throw err.forbidden('This account has been deactivated. Contact your administrator.');
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    throw err.forbidden(`This account is temporarily locked after repeated failed sign-in attempts. Try again later.`);
  }
  if (!verifyPassword(input.password, row.password_hash)) {
    const attempts = row.failed_attempts + 1;
    const lock = attempts >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
    ctx.db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(attempts, lock, row.id);
    ctx.audit('auth.login_failed', 'users', row.id, { attempts });
    throw err.unauthenticated();
  }
  ctx.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
  ctx.audit('auth.login', 'users', row.id);
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

export function changePassword(ctx: Ctx, currentPassword: string, newPassword: string): void {
  if (!ctx.user) throw err.unauthenticated();
  const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ctx.user.id) as { password_hash: string } | undefined;
  if (!row || !verifyPassword(currentPassword, row.password_hash)) throw err.validation('The current password is incorrect.');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(newPassword), nowIso(), ctx.user!.id);
    ctx.audit('auth.password_changed', 'users', ctx.user!.id);
  });
}

export function createUser(ctx: Ctx, input: UserInput): { id: string } {
  return tx(ctx.db, () => {
    const id = uuid();
    try {
      ctx.db
        .prepare(
          `INSERT INTO users(id, username, display_name, password_hash, role, active, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(id, input.username, input.displayName, hashPassword(input.password), input.role, input.active ? 1 : 0, nowIso(), nowIso());
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw err.duplicate(`The username "${input.username}" is already in use.`);
      throw e;
    }
    ctx.audit('users.create', 'users', id, { username: input.username, role: input.role });
    return { id };
  });
}

export function updateUser(ctx: Ctx, input: UserUpdate): void {
  const existing = ctx.db.prepare('SELECT id, role FROM users WHERE id = ?').get(input.id) as { id: string; role: Role } | undefined;
  if (!existing) throw err.notFound('User');
  if (ctx.user && ctx.user.id === input.id && (!input.active || input.role !== 'admin')) {
    const admins = ctx.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1").get() as { c: number };
    if (admins.c <= 1) throw err.invalidState('The clinic must retain at least one active administrator account.');
  }
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE users SET display_name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?').run(
      input.displayName, input.role, input.active ? 1 : 0, nowIso(), input.id,
    );
    ctx.audit('users.update', 'users', input.id, { role: input.role, active: input.active });
  });
}

export function resetPassword(ctx: Ctx, id: string, newPassword: string): void {
  const existing = ctx.db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!existing) throw err.notFound('User');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(
      hashPassword(newPassword), nowIso(), id,
    );
    ctx.audit('users.password_reset', 'users', id);
  });
}
