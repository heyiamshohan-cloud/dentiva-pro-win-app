// Dentiva Pro - shared domain constants (single source of truth).

export const APP_NAME = 'Dentiva Pro';
export const APP_VERSION = '1.0.0';
export const SCHEMA_VERSION = 2;
export const DEFAULT_CURRENCY = 'BDT';
export const DEFAULT_CURRENCY_SYMBOL = '৳';
export const DEFAULT_TIMEZONE = 'Asia/Dhaka';

export const PAYMENT_METHODS = ['cash', 'bank', 'card', 'bkash', 'nagad', 'rocket', 'upay'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash', bank: 'Bank', card: 'Card', bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket', upay: 'Upay',
};

export const ROLES = ['admin', 'dentist', 'receptionist', 'accountant', 'staff'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator', dentist: 'Dentist', receptionist: 'Receptionist', accountant: 'Accountant', staff: 'Inventory Staff',
};

// Permission catalog. RBAC is enforced in the main-process service gateway.
export type Permission =
  | 'dashboard.view' | 'patients.read' | 'patients.write' | 'patients.archive' | 'patients.merge'
  | 'visits.read' | 'visits.write' | 'chart.write' | 'prescriptions.write' | 'treatments.manage'
  | 'plans.write' | 'appointments.read' | 'appointments.write' | 'queue.manage'
  | 'billing.read' | 'billing.write' | 'billing.discount' | 'billing.void' | 'payments.refund'
  | 'accounting.read' | 'accounting.write' | 'inventory.read' | 'inventory.write' | 'inventory.adjust'
  | 'reports.view' | 'staff.manage' | 'settings.manage' | 'backup.run' | 'restore.run'
  | 'audit.view' | 'import.run' | 'export.run' | 'attachments.manage' | 'notifications.manage'
  | 'diagnostics.view' | 'documents.generate';

const ALL: Permission[] = [
  'dashboard.view', 'patients.read', 'patients.write', 'patients.archive', 'patients.merge',
  'visits.read', 'visits.write', 'chart.write', 'prescriptions.write', 'treatments.manage',
  'plans.write', 'appointments.read', 'appointments.write', 'queue.manage',
  'billing.read', 'billing.write', 'billing.discount', 'billing.void', 'payments.refund',
  'accounting.read', 'accounting.write', 'inventory.read', 'inventory.write', 'inventory.adjust',
  'reports.view', 'staff.manage', 'settings.manage', 'backup.run', 'restore.run',
  'audit.view', 'import.run', 'export.run', 'attachments.manage', 'notifications.manage',
  'diagnostics.view', 'documents.generate',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(ALL),
  dentist: new Set([
    'dashboard.view', 'patients.read', 'patients.write', 'visits.read', 'visits.write', 'chart.write',
    'prescriptions.write', 'plans.write', 'appointments.read', 'appointments.write', 'queue.manage',
    'billing.read', 'reports.view', 'attachments.manage', 'documents.generate', 'notifications.manage',
    'export.run', 'treatments.manage',
  ]),
  receptionist: new Set([
    'dashboard.view', 'patients.read', 'patients.write', 'visits.read', 'appointments.read',
    'appointments.write', 'queue.manage', 'billing.read', 'billing.write', 'billing.discount',
    'attachments.manage', 'documents.generate', 'notifications.manage', 'import.run', 'export.run',
  ]),
  accountant: new Set([
    'dashboard.view', 'patients.read', 'visits.read', 'billing.read', 'billing.write', 'billing.discount',
    'billing.void', 'payments.refund', 'accounting.read', 'accounting.write', 'reports.view',
    'documents.generate', 'export.run',
  ]),
  staff: new Set(['dashboard.view', 'patients.read', 'inventory.read', 'inventory.write', 'reports.view', 'notifications.manage']),
};

// Prescription clinical option lists (exact product wording).
export const CC_OPTIONS = ['Pain On', 'G. Carries', 'Swelling', 'Gum Bleeding', 'Bad Breath', 'Sensitivity'] as const;
export const OE_OPTIONS = [
  'Carries', 'G Carries', 'BDR', 'BDC', 'Gingivitis', 'Parodental Pocket',
  'Perio Dontitis', 'Impected Teeth', 'Dry Socket', 'Attrition', 'Erosion',
] as const;

export const ADVICE_OPTIONS = [
  'Brush twice daily', 'Warm saline rinse', 'Avoid hot/cold food', 'Avoid hard food',
  'Maintain oral hygiene', 'Use prescribed mouthwash', 'Return if pain persists', 'Follow up as scheduled',
] as const;

export const DENTITIONS = ['adult', 'primary'] as const;
export type Dentition = (typeof DENTITIONS)[number];
export const ADULT_TEETH: number[] = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
  48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];
export const PRIMARY_TEETH: number[] = [55, 54, 53, 52, 51, 61, 62, 63, 64, 65, 85, 84, 83, 82, 81, 71, 72, 73, 74, 75];
export const TOOTH_STATES = ['sound', 'caries', 'restoration', 'crown', 'root_canal', 'missing', 'implant', 'fractured', 'impacted', 'watch'] as const;
export type ToothState = (typeof TOOTH_STATES)[number];
export const TOOTH_STATE_LABELS: Record<ToothState, string> = {
  sound: 'Sound', caries: 'Caries', restoration: 'Restoration', crown: 'Crown', root_canal: 'Root Canal',
  missing: 'Missing', implant: 'Implant', fractured: 'Fractured', impacted: 'Impacted', watch: 'Watch',
};

export const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_show', 'rescheduled'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export const QUEUE_STATUSES = ['waiting', 'called', 'in_treatment', 'completed', 'skipped'] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export const INVOICE_STATUSES = ['draft', 'final', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const VISIT_STATUSES = ['open', 'completed', 'cancelled'] as const;
export const PLAN_STATUSES = ['draft', 'proposed', 'accepted', 'rejected', 'completed'] as const;
export const PLAN_ITEM_STATUSES = ['planned', 'in_progress', 'done', 'dropped'] as const;
export const GENDERS = ['male', 'female', 'other'] as const;

export const MEDICAL_KINDS = ['allergy', 'medication', 'condition', 'medical_note', 'dental_note'] as const;
export type MedicalKind = (typeof MEDICAL_KINDS)[number];

export const STOCK_MOVE_KINDS = ['purchase', 'sale', 'use', 'adjust', 'waste', 'return'] as const;

export const PAPER_SIZES = ['A4', 'A5', 'LETTER', '80MM'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const NOTIFICATION_KINDS = ['appointment_today', 'followup_due', 'low_stock', 'expiry', 'outstanding', 'backup', 'security', 'system'] as const;

export const DATE_FMT = /^\d{4}-\d{2}-\d{2}$/;
