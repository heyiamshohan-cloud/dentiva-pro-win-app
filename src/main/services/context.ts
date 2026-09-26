// Dentiva Pro - service context passed to every service call.
import { Db, getSetting } from '../db/connection';
import { uuid } from '../../shared/ids';
import { nowIso } from '../../shared/dates';
import { SessionUser } from '../security/session';
import { ClinicProfileInput } from '../../shared/validation/system';

export const DEFAULT_CLINIC: ClinicProfileInput = {
  clinicName: 'Dentiva Dental Clinic',
  tagline: '',
  address: '',
  phone: '',
  email: '',
  website: '',
  registrationNo: '',
  logoPath: '',
  dentistName: '',
  dentistDegrees: '',
  currency: 'BDT',
  currencySymbol: '৳',
  currencyLabel: 'Tk',
  timezone: 'Asia/Dhaka',
  paperSize: 'A4',
  appointmentDurationMin: 30,
  invoicePrefix: 'INV',
  taxLabel: 'Tax',
  invoiceFooter: '',
  receiptFooter: '',
  prescriptionFooter: '',
  autoBackupEnabled: false,
  autoBackupDir: '',
  sessionTimeoutMin: 30,
  enabledPaymentMethods: ['cash', 'bank', 'card', 'bkash', 'nagad', 'rocket', 'upay'],
};

export interface Ctx {
  db: Db;
  user: SessionUser | null;
  /** Write an audit entry. Call inside the same transaction as the mutation. Secrets are excluded by contract. */
  audit(action: string, entity?: string, entityId?: string, details?: Record<string, unknown>): void;
  clinic(): ClinicProfileInput;
  userName(): string;
}

export function makeCtx(db: Db, user: SessionUser | null): Ctx {
  const ctx: Ctx = {
    db,
    user,
    audit(action, entity = '', entityId = '', details = {}) {
      db.prepare(
        'INSERT INTO audit_log(id, at, user_id, username, action, entity, entity_id, details) VALUES (?,?,?,?,?,?,?,?)',
      ).run(uuid(), nowIso(), user?.id ?? null, user?.username ?? 'system', action, entity, entityId, JSON.stringify(details));
    },
    clinic() {
      return getSetting<ClinicProfileInput>(db, 'clinic_profile', DEFAULT_CLINIC);
    },
    userName() {
      return user?.displayName ?? 'System';
    },
  };
  return ctx;
}

/** Transaction wrapper with automatic audit-friendly signature. */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}

export function isSchemaReady(db: Db): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    return !!row;
  } catch {
    return false;
  }
}

export function hasUsers(db: Db): boolean {
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    return row.c > 0;
  } catch {
    return false;
  }
}
