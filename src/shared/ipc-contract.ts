// Dentiva Pro - IPC contract: every channel has a zod schema + required permission.
// The main-process gateway enforces: shape validation -> session -> RBAC -> service call.
import { z } from 'zod';
import { Permission } from './constants';
import { emptyPayload, idPayload, uuid } from './validation/common';
import { patientInput, patientUpdate, patientListQuery, medicalItemInput, medicalItemUpdate, patientMergeInput } from './validation/patients';
import {
  visitInput, visitUpdate, procedureInput, visitListQuery, timelineQuery, chartSetTooth, chartGet,
  prescriptionInput, prescriptionUpdate, treatmentInput, treatmentUpdate, treatmentListQuery,
  planInput, planSetStatus, planConvert,
} from './validation/clinical';
import { appointmentInput, appointmentUpdate, appointmentSetStatus, appointmentListQuery, calendarQuery, queueAdd, queueSetStatus, queueListQuery } from './validation/scheduling';
import {
  invoiceInput, invoiceUpdate, invoiceListQuery, paymentInput, refundInput, voidInvoiceInput, paymentListQuery,
  statementQuery, expenseInput, expenseUpdate, expenseListQuery, ledgerQuery, adjustmentInput,
} from './validation/finance';
import { itemInput, itemUpdate, itemListQuery, supplierInput, supplierUpdate, purchaseInput, stockAdjustInput, movementListQuery, purchasePayInput } from './validation/inventory';
import {
  setupInput, loginInput, changePasswordInput, userInput, userUpdate, resetPasswordInput,
  clinicProfileInput, backupInput, restoreInput, restoreValidateInput, importInput, exportInput,
  attachInput, globalSearchInput, entitySearchInput, notificationListQuery, notificationMarkRead,
  auditListQuery, reportQuery, docGenerateInput, pinUnlockInput,
} from './validation/system';

export interface ChannelDef {
  schema: z.ZodTypeAny;
  permission: Permission | null; // null = only requires authentication (or pre-auth when noted)
  preAuth?: boolean;             // allowed without a session (setup/login/status)
}

const def = (schema: z.ZodTypeAny, permission: Permission | null, preAuth = false): ChannelDef => ({ schema, permission, preAuth });

export const CHANNELS = {
  // bootstrap / auth
  'auth.status': def(emptyPayload, null, true),
  'auth.setup': def(setupInput, null, true),
  'auth.login': def(loginInput, null, true),
  'auth.logout': def(emptyPayload, null),
  'auth.unlock': def(pinUnlockInput, null, true),
  'auth.changePassword': def(changePasswordInput, null),
  // users / staff
  'users.list': def(emptyPayload, 'staff.manage'),
  'users.create': def(userInput, 'staff.manage'),
  'users.update': def(userUpdate, 'staff.manage'),
  'users.resetPassword': def(resetPasswordInput, 'staff.manage'),
  // settings
  'settings.get': def(emptyPayload, null),
  'settings.update': def(clinicProfileInput, 'settings.manage'),
  // patients
  'patients.list': def(patientListQuery, 'patients.read'),
  'patients.get': def(idPayload(), 'patients.read'),
  'patients.create': def(patientInput, 'patients.write'),
  'patients.update': def(patientUpdate, 'patients.write'),
  'patients.archive': def(idPayload(), 'patients.archive'),
  'patients.restore': def(idPayload(), 'patients.archive'),
  'patients.duplicates': def(z.object({ name: z.string().trim().max(160).default(''), phone: z.string().trim().max(32).default(''), email: z.string().trim().max(120).default(''), dob: z.string().max(10).default('') }), 'patients.read'),
  'patients.merge': def(patientMergeInput, 'patients.merge'),
  'patients.medical.list': def(z.object({ patientId: uuid }), 'patients.read'),
  'patients.medical.add': def(z.object({ patientId: uuid, item: medicalItemInput }), 'patients.write'),
  'patients.medical.update': def(medicalItemUpdate, 'patients.write'),
  'patients.medical.remove': def(idPayload(), 'patients.write'),
  'patients.overview': def(idPayload(), 'patients.read'),
  'patients.timeline': def(timelineQuery, 'patients.read'),
  'patients.delete': def(idPayload(), 'patients.archive'),
  // medical record (clinical)
  'visits.list': def(visitListQuery, 'visits.read'),
  'visits.get': def(idPayload(), 'visits.read'),
  'visits.create': def(visitInput, 'visits.write'),
  'visits.update': def(visitUpdate, 'visits.write'),
  'visits.setStatus': def(z.object({ id: uuid, status: z.enum(['open', 'completed', 'cancelled']) }), 'visits.write'),
  'visits.addProcedure': def(procedureInput, 'visits.write'),
  'visits.removeProcedure': def(idPayload(), 'visits.write'),
  'chart.get': def(chartGet, 'visits.read'),
  'chart.setTooth': def(chartSetTooth, 'chart.write'),
  'prescriptions.list': def(z.object({ patientId: uuid.optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(200).default(25) }), 'visits.read'),
  'prescriptions.get': def(idPayload(), 'visits.read'),
  'prescriptions.create': def(prescriptionInput, 'prescriptions.write'),
  'prescriptions.update': def(prescriptionUpdate, 'prescriptions.write'),
  'treatments.list': def(treatmentListQuery, 'patients.read'),
  'treatments.create': def(treatmentInput, 'treatments.manage'),
  'treatments.update': def(treatmentUpdate, 'treatments.manage'),
  'plans.list': def(z.object({ patientId: uuid }), 'visits.read'),
  'plans.create': def(planInput, 'plans.write'),
  'plans.setStatus': def(planSetStatus, 'plans.write'),
  'plans.convert': def(planConvert, 'plans.write'),
  // scheduling
  'appointments.list': def(appointmentListQuery, 'appointments.read'),
  'appointments.calendar': def(calendarQuery, 'appointments.read'),
  'appointments.create': def(appointmentInput, 'appointments.write'),
  'appointments.update': def(appointmentUpdate, 'appointments.write'),
  'appointments.setStatus': def(appointmentSetStatus, 'appointments.write'),
  'queue.today': def(queueListQuery, 'appointments.read'),
  'queue.add': def(queueAdd, 'queue.manage'),
  'queue.setStatus': def(queueSetStatus, 'queue.manage'),
  'queue.remove': def(idPayload(), 'queue.manage'),
  // billing
  'invoices.list': def(invoiceListQuery, 'billing.read'),
  'invoices.get': def(idPayload(), 'billing.read'),
  'invoices.create': def(invoiceInput, 'billing.write'),
  'invoices.update': def(invoiceUpdate, 'billing.write'),
  'invoices.finalize': def(idPayload(), 'billing.write'),
  'invoices.void': def(voidInvoiceInput, 'billing.void'),
  'payments.list': def(paymentListQuery, 'billing.read'),
  'payments.create': def(paymentInput, 'billing.write'),
  'payments.refund': def(refundInput, 'payments.refund'),
  'payments.adjustment': def(adjustmentInput, 'payments.refund'),
  'statements.patient': def(statementQuery, 'billing.read'),
  // accounting
  'expenses.list': def(expenseListQuery, 'accounting.read'),
  'expenses.create': def(expenseInput, 'accounting.write'),
  'expenses.update': def(expenseUpdate, 'accounting.write'),
  'expenses.delete': def(idPayload(), 'accounting.write'),
  'accounting.ledger': def(ledgerQuery, 'accounting.read'),
  'accounting.summary': def(z.object({ from: z.string().max(10), to: z.string().max(10) }), 'accounting.read'),
  // inventory
  'inventory.list': def(itemListQuery, 'inventory.read'),
  'inventory.get': def(idPayload(), 'inventory.read'),
  'inventory.create': def(itemInput, 'inventory.write'),
  'inventory.update': def(itemUpdate, 'inventory.write'),
  'inventory.movements': def(movementListQuery, 'inventory.read'),
  'inventory.adjust': def(stockAdjustInput, 'inventory.adjust'),
  'inventory.lowStock': def(emptyPayload, 'inventory.read'),
  'inventory.expiries': def(z.object({ withinDays: z.number().int().min(1).max(730).default(90) }), 'inventory.read'),
  'suppliers.list': def(z.object({ q: z.string().trim().max(120).default('') }), 'inventory.read'),
  'suppliers.create': def(supplierInput, 'inventory.write'),
  'suppliers.update': def(supplierUpdate, 'inventory.write'),
  'purchases.list': def(z.object({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(200).default(25), supplierId: uuid.optional() }), 'inventory.read'),
  'purchases.create': def(purchaseInput, 'inventory.write'),
  'purchases.pay': def(purchasePayInput, 'inventory.write'),
  // search
  'search.global': def(globalSearchInput, null),
  'search.entity': def(entitySearchInput, null),
  // dashboard & reports
  'dashboard.get': def(emptyPayload, 'dashboard.view'),
  'reports.run': def(reportQuery, 'reports.view'),
  // notifications
  'notifications.list': def(notificationListQuery, null),
  'notifications.unreadCount': def(emptyPayload, null),
  'notifications.markRead': def(notificationMarkRead, null),
  'notifications.refresh': def(emptyPayload, 'notifications.manage'),
  // documents
  'docs.generate': def(docGenerateInput, 'documents.generate'),
  'docs.openFolder': def(emptyPayload, 'documents.generate'),
  // attachments
  'attachments.list': def(z.object({ patientId: uuid }), 'patients.read'),
  'attachments.add': def(attachInput, 'attachments.manage'),
  'attachments.open': def(idPayload(), 'patients.read'),
  'attachments.remove': def(idPayload(), 'attachments.manage'),
  // backup / restore
  'backup.run': def(backupInput, 'backup.run'),
  'backup.history': def(emptyPayload, 'backup.run'),
  'restore.validate': def(restoreValidateInput, 'restore.run'),
  'restore.run': def(restoreInput, 'restore.run'),
  // import/export
  'import.run': def(importInput, 'import.run'),
  'export.run': def(exportInput, 'export.run'),
  // audit / diagnostics
  'audit.list': def(auditListQuery, 'audit.view'),
  'diagnostics.get': def(emptyPayload, 'diagnostics.view'),
  // system dialogs (validated in main; no payload data)
  'system.pickFile': def(z.object({ kind: z.enum(['backup', 'attachment', 'logo', 'import']) }), null),
  'system.pickDir': def(emptyPayload, null),
} as const;

export type Channel = keyof typeof CHANNELS;
