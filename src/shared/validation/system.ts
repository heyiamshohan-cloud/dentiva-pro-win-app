import { z } from 'zod';
import { uuid, nonEmpty, text2000, dateStr, phone, pageQuery } from './common';
import { ROLES, PAPER_SIZES, PAYMENT_METHODS } from '../constants';

export const setupInput = z.object({
  clinicName: nonEmpty.max(200),
  adminDisplayName: nonEmpty.max(160),
  username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9_.-]+$/, 'Letters, numbers, dot, dash, underscore only'),
  password: z.string().min(8).max(200),
  confirmPassword: z.string().min(8).max(200),
}).refine((v) => v.password === v.confirmPassword, { message: 'Passwords do not match' });
export type SetupInput = z.infer<typeof setupInput>;

export const loginInput = z.object({
  username: z.string().trim().min(1).max(60),
  password: z.string().min(1).max(200),
});

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

export const userInput = z.object({
  username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9_.-]+$/, 'Letters, numbers, dot, dash, underscore only'),
  displayName: nonEmpty.max(160),
  role: z.enum(ROLES),
  password: z.string().min(8).max(200),
  active: z.boolean().default(true),
});
export type UserInput = z.infer<typeof userInput>;

export const userUpdate = z.object({
  id: uuid,
  displayName: nonEmpty.max(160),
  role: z.enum(ROLES),
  active: z.boolean(),
});

export const resetPasswordInput = z.object({ id: uuid, newPassword: z.string().min(8).max(200) });

export const clinicProfileInput = z.object({
  clinicName: nonEmpty.max(200),
  tagline: z.string().trim().max(200).default(''),
  address: text2000.default(''),
  phone: phone,
  email: z.string().trim().max(120).default(''),
  website: z.string().trim().max(160).default(''),
  registrationNo: z.string().trim().max(120).default(''),
  logoPath: z.string().trim().max(400).default(''),
  dentistName: z.string().trim().max(160).default(''),
  dentistDegrees: z.string().trim().max(300).default(''),
  currency: z.string().trim().length(3).default('BDT'),
  currencySymbol: z.string().trim().max(6).default('৳'),
  currencyLabel: z.string().trim().max(20).default('Tk'),
  timezone: z.string().trim().max(60).default('Asia/Dhaka'),
  paperSize: z.enum(PAPER_SIZES).default('A4'),
  appointmentDurationMin: z.number().int().min(5).max(480).default(30),
  invoicePrefix: z.string().trim().max(12).default('INV'),
  taxLabel: z.string().trim().max(40).default('Tax'),
  invoiceFooter: text2000.default(''),
  receiptFooter: text2000.default(''),
  prescriptionFooter: text2000.default(''),
  autoBackupEnabled: z.boolean().default(false),
  autoBackupDir: z.string().trim().max(400).default(''),
  sessionTimeoutMin: z.number().int().min(5).max(1440).default(30),
  enabledPaymentMethods: z.array(z.enum(PAYMENT_METHODS)).min(1).default([...PAYMENT_METHODS]),
});
export type ClinicProfileInput = z.infer<typeof clinicProfileInput>;

export const backupInput = z.object({
  targetDir: z.string().trim().max(500).optional(),
  note: z.string().trim().max(300).default(''),
});
export const restoreInput = z.object({ filePath: nonEmpty.max(800) });
export const restoreValidateInput = z.object({ filePath: nonEmpty.max(800) });

export const importInput = z.object({
  entity: z.enum(['patients', 'inventory'] as const),
  csv: z.string().max(20 * 1024 * 1024),
  mapping: z.record(z.string().min(1).max(60), z.string().min(1).max(60)),
  mode: z.enum(['error', 'skip'] as const).default('error'),
  dryRun: z.boolean().default(true),
});
export type ImportInput = z.infer<typeof importInput>;

export const exportInput = z.object({
  entity: z.enum(['patients', 'invoices', 'payments', 'inventory', 'appointments', 'visits'] as const),
  from: dateStr.optional(),
  to: dateStr.optional(),
});

export const attachInput = z.object({
  patientId: uuid,
  visitId: uuid.nullable().default(null),
  sourcePath: nonEmpty.max(800),
  note: z.string().trim().max(500).default(''),
});

export const globalSearchInput = z.object({
  q: z.string().trim().min(1).max(120),
  limitPerGroup: z.number().int().min(1).max(20).default(8),
});

export const entitySearchInput = pageQuery({
  entity: z.enum(['patients', 'invoices', 'treatments', 'inventory', 'staff'] as const),
  q: z.string().trim().min(1).max(120),
});

export const notificationListQuery = pageQuery({ unreadOnly: z.boolean().default(false), kind: z.string().trim().max(40).default('') });
export const notificationMarkRead = z.object({ ids: z.array(uuid).min(1).max(500) });

export const auditListQuery = pageQuery({
  from: dateStr.optional(),
  to: dateStr.optional(),
  userId: uuid.optional(),
  entity: z.string().trim().max(60).optional(),
  action: z.string().trim().max(60).optional(),
});

export const reportQuery = z.object({
  kind: z.enum([
    'revenue_summary', 'payments_by_method', 'outstanding_balances', 'appointments_summary',
    'patient_growth', 'treatment_activity', 'dentist_activity', 'inventory_valuation',
    'low_stock', 'expiry_report', 'expense_summary', 'daily_collections',
  ] as const),
  from: dateStr,
  to: dateStr,
});

export const docGenerateInput = z.object({
  kind: z.enum(['invoice', 'receipt', 'prescription', 'statement'] as const),
  id: uuid,
  paperSize: z.enum(PAPER_SIZES).optional(),
  forPatientId: uuid.optional(),
});

export const pinUnlockInput = z.object({ password: z.string().min(1).max(200) });

export type ReportQuery = z.infer<typeof reportQuery>;
export type NotificationListQuery = z.infer<typeof notificationListQuery>;
export type AuditListQuery = z.infer<typeof auditListQuery>;
export type LoginInput = z.infer<typeof loginInput>;
export type UserUpdate = z.infer<typeof userUpdate>;
