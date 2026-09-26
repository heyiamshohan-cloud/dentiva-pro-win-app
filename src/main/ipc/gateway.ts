// Dentiva Pro - IPC gateway. Every channel: zod-validate -> session -> RBAC -> service.
// Domain errors become typed results; unexpected errors are logged and sanitized.
import { ZodError } from 'zod';
import { err, ok, fail, DomainError, IpcResult } from '../../shared/errors';
import { CHANNELS, Channel } from '../../shared/ipc-contract';
import { ROLE_PERMISSIONS } from '../../shared/constants';
import { Db } from '../db/connection';
import { makeCtx, Ctx, hasUsers, isSchemaReady } from '../services/context';
import { SessionManager, SessionUser } from '../security/session';
import { logger } from '../util/log';
import * as users from '../services/users';
import * as patients from '../services/patients';
import * as visits from '../services/visits';
import * as prescriptions from '../services/prescriptions';
import * as chart from '../services/chart';
import * as treatments from '../services/treatments';
import * as appointments from '../services/appointments';
import * as invoices from '../services/invoices';
import * as payments from '../services/payments';
import * as accounting from '../services/accounting';
import * as inventory from '../services/inventory';
import * as settings from '../services/settings';
import * as search from '../services/search';
import * as dashboard from '../services/dashboard';
import * as notifications from '../services/notifications';
import * as importExport from '../services/importExport';
import * as attachments from '../services/attachments';
import * as backupSvc from '../services/backup';
import * as restoreSvc from '../services/restore';
import * as ops from '../services/ops';
import { generateInvoicePdf, generateReceiptPdf, generatePrescriptionPdf, generateStatementPdf } from '../pdf/documents';
import { PaperSize } from '../../shared/constants';

export interface GatewayDeps {
  getDb(): Db;
  sessions: SessionManager;
  dbFile: string;
  dataDir: string;
  attachmentsDir: string;
  backupsDir: string;
  docsDir: string;
  /** Closes the live DB connection (for restore). */
  relinquishDb(): void;
  /** Reopens DB after restore and purges sessions. */
  reopenDb(): void;
  /** OS dialogs; null in tests (returns null => cancelled). */
  pickFile?(kind: 'backup' | 'attachment' | 'logo' | 'import'): Promise<string | null>;
  pickDir?(): Promise<string | null>;
  onAfterAuth?(username: string): void;
  getLastUsername(): string;
  setLastUsername(u: string): void;
}

type Handler = (ctx: Ctx, payload: unknown, deps: GatewayDeps, user: SessionUser | null) => unknown | Promise<unknown>;

function userHandler(fn: (ctx: Ctx, p: never) => unknown): Handler {
  return (ctx, p) => fn(ctx, p as never);
}

const HANDLERS: Record<Channel, Handler> = {
  'auth.status': () => ({ ready: true }),
  'auth.setup': async (ctx, p) => users.setupInitial(ctx, p as never),
  'auth.login': () => ({}), // special-cased below (needs session manager)
  'auth.logout': () => ({}), // special-cased
  'auth.unlock': () => ({}), // special-cased
  'auth.changePassword': (ctx, p) => { const v = p as { currentPassword: string; newPassword: string }; users.changePassword(ctx, v.currentPassword, v.newPassword); },
  'users.list': userHandler((ctx) => users.listUsers(ctx)),
  'users.create': userHandler((ctx, p) => users.createUser(ctx, p as never)),
  'users.update': (ctx, p) => users.updateUser(ctx, p as never),
  'users.resetPassword': (ctx, p) => { const v = p as { id: string; newPassword: string }; users.resetPassword(ctx, v.id, v.newPassword); },
  'settings.get': userHandler((ctx) => settings.getSettings(ctx)),
  'settings.update': userHandler((ctx, p) => settings.updateSettings(ctx, p as never)),
  'patients.list': userHandler((ctx, p) => patients.listPatients(ctx, p as never)),
  'patients.get': userHandler((ctx, p) => patients.getPatientWithTags(ctx, (p as { id: string }).id)),
  'patients.create': userHandler((ctx, p) => patients.createPatient(ctx, p as never)),
  'patients.update': userHandler((ctx, p) => patients.updatePatient(ctx, p as never)),
  'patients.archive': (ctx, p) => patients.archivePatient(ctx, (p as { id: string }).id),
  'patients.restore': (ctx, p) => patients.restorePatient(ctx, (p as { id: string }).id),
  'patients.duplicates': userHandler((ctx, p) => patients.findDuplicates(ctx, p as never)),
  'patients.merge': (ctx, p) => { const v = p as { keepId: string; removeId: string }; patients.mergePatients(ctx, v.keepId, v.removeId); },
  'patients.medical.list': userHandler((ctx, p) => patients.listMedical(ctx, (p as { patientId: string }).patientId)),
  'patients.medical.add': userHandler((ctx, p) => patients.addMedical(ctx, (p as { patientId: string }).patientId, (p as { item: never }).item)),
  'patients.medical.update': userHandler((ctx, p) => patients.updateMedical(ctx, p as never)),
  'patients.medical.remove': (ctx, p) => patients.removeMedical(ctx, (p as { id: string }).id),
  'patients.overview': userHandler((ctx, p) => patients.patientOverview(ctx, (p as { id: string }).id)),
  'patients.timeline': userHandler((ctx, p) => { const v = p as { patientId: string; cursor?: string; limit: number }; return patients.patientTimeline(ctx, v.patientId, v.cursor, v.limit); }),
  'patients.delete': (ctx, p) => patients.deletePatient(ctx, (p as { id: string }).id),
  'visits.list': userHandler((ctx, p) => visits.listVisits(ctx, p as never)),
  'visits.get': userHandler((ctx, p) => visits.getVisit(ctx, (p as { id: string }).id)),
  'visits.create': userHandler((ctx, p) => visits.createVisit(ctx, p as never)),
  'visits.update': userHandler((ctx, p) => visits.updateVisit(ctx, p as never)),
  'visits.setStatus': (ctx, p) => { const v = p as { id: string; status: never }; visits.setVisitStatus(ctx, v.id, v.status); },
  'visits.addProcedure': userHandler((ctx, p) => visits.addProcedure(ctx, p as never)),
  'visits.removeProcedure': (ctx, p) => visits.removeProcedure(ctx, (p as { id: string }).id),
  'chart.get': userHandler((ctx, p) => { const v = p as { patientId: string; dentition: never }; return chart.getChart(ctx, v.patientId, v.dentition); }),
  'chart.setTooth': userHandler((ctx, p) => chart.setTooth(ctx, p as never)),
  'prescriptions.list': userHandler((ctx, p) => prescriptions.listPrescriptions(ctx, p as never)),
  'prescriptions.get': userHandler((ctx, p) => prescriptions.getPrescription(ctx, (p as { id: string }).id)),
  'prescriptions.create': userHandler((ctx, p) => prescriptions.createPrescription(ctx, p as never)),
  'prescriptions.update': userHandler((ctx, p) => prescriptions.updatePrescription(ctx, p as never)),
  'treatments.list': userHandler((ctx, p) => treatments.listTreatments(ctx, p as never)),
  'treatments.create': userHandler((ctx, p) => treatments.createTreatment(ctx, p as never)),
  'treatments.update': userHandler((ctx, p) => treatments.updateTreatment(ctx, p as never)),
  'plans.list': userHandler((ctx, p) => treatments.listPlans(ctx, (p as { patientId: string }).patientId)),
  'plans.create': userHandler((ctx, p) => treatments.createPlan(ctx, p as never)),
  'plans.setStatus': (ctx, p) => { const v = p as { id: string; status: never }; treatments.setPlanStatus(ctx, v.id, v.status); },
  'plans.convert': (ctx, p) => { const v = p as { planId: string; itemIds: string[]; visitId: string | null }; return treatments.convertPlanItems(ctx, v.planId, v.itemIds, v.visitId); },
  'appointments.list': userHandler((ctx, p) => appointments.listAppointments(ctx, p as never)),
  'appointments.calendar': userHandler((ctx, p) => appointments.calendarAppointments(ctx, p as never)),
  'appointments.create': userHandler((ctx, p) => appointments.createAppointment(ctx, p as never)),
  'appointments.update': userHandler((ctx, p) => appointments.updateAppointment(ctx, p as never)),
  'appointments.setStatus': (ctx, p) => { const v = p as { id: string; status: never }; appointments.setAppointmentStatus(ctx, v.id, v.status); },
  'queue.today': userHandler((ctx, p) => appointments.queueList(ctx, (p as { date?: string }).date)),
  'queue.add': userHandler((ctx, p) => appointments.queueAdd(ctx, p as never)),
  'queue.setStatus': (ctx, p) => { const v = p as { id: string; status: never }; appointments.queueSetStatus(ctx, v.id, v.status); },
  'queue.remove': (ctx, p) => appointments.queueRemove(ctx, (p as { id: string }).id),
  'invoices.list': userHandler((ctx, p) => invoices.listInvoices(ctx, p as never)),
  'invoices.get': userHandler((ctx, p) => invoices.getInvoice(ctx, (p as { id: string }).id)),
  'invoices.create': userHandler((ctx, p) => invoices.createInvoice(ctx, p as never)),
  'invoices.update': userHandler((ctx, p) => invoices.updateInvoice(ctx, p as never)),
  'invoices.finalize': (ctx, p) => invoices.finalizeInvoice(ctx, (p as { id: string }).id),
  'invoices.void': (ctx, p) => { const v = p as { id: string; reason: string }; invoices.voidInvoice(ctx, v.id, v.reason); },
  'payments.list': userHandler((ctx, p) => payments.listPayments(ctx, p as never)),
  'payments.create': userHandler((ctx, p) => payments.createPayment(ctx, p as never)),
  'payments.refund': userHandler((ctx, p) => payments.createRefund(ctx, p as never)),
  'payments.adjustment': userHandler((ctx, p) => payments.createAdjustment(ctx, p as never)),
  'statements.patient': userHandler((ctx, p) => payments.patientStatement(ctx, p as never)),
  'expenses.list': userHandler((ctx, p) => accounting.listExpenses(ctx, p as never)),
  'expenses.create': userHandler((ctx, p) => accounting.createExpense(ctx, p as never)),
  'expenses.update': userHandler((ctx, p) => accounting.updateExpense(ctx, p as never)),
  'expenses.delete': (ctx, p) => accounting.deleteExpense(ctx, (p as { id: string }).id),
  'accounting.ledger': userHandler((ctx, p) => accounting.ledger(ctx, p as never)),
  'accounting.summary': userHandler((ctx, p) => accounting.accountingSummary(ctx, p as never)),
  'inventory.list': userHandler((ctx, p) => inventory.listItems(ctx, p as never)),
  'inventory.get': userHandler((ctx, p) => inventory.getItem(ctx, (p as { id: string }).id)),
  'inventory.create': userHandler((ctx, p) => inventory.createItem(ctx, p as never)),
  'inventory.update': userHandler((ctx, p) => inventory.updateItem(ctx, p as never)),
  'inventory.movements': userHandler((ctx, p) => inventory.listMovements(ctx, p as never)),
  'inventory.adjust': userHandler((ctx, p) => inventory.adjustStock(ctx, p as never)),
  'inventory.lowStock': userHandler((ctx) => inventory.lowStock(ctx)),
  'inventory.expiries': (ctx, p) => inventory.expiries(ctx, (p as { withinDays: number }).withinDays),
  'suppliers.list': userHandler((ctx, p) => inventory.listSuppliers(ctx, (p as { q: string }).q)),
  'suppliers.create': userHandler((ctx, p) => inventory.createSupplier(ctx, p as never)),
  'suppliers.update': userHandler((ctx, p) => inventory.updateSupplier(ctx, p as never)),
  'purchases.list': userHandler((ctx, p) => inventory.listPurchases(ctx, p as never)),
  'purchases.create': userHandler((ctx, p) => inventory.createPurchase(ctx, p as never)),
  'purchases.pay': userHandler((ctx, p) => inventory.payPurchase(ctx, p as never)),
  'search.global': userHandler((ctx, p) => { const v = p as { q: string; limitPerGroup: number }; return search.globalSearch(ctx, v.q, v.limitPerGroup); }),
  'search.entity': userHandler((ctx, p) => { const v = p as { entity: string; q: string; page: number; pageSize: number }; return search.entitySearch(ctx, v.entity, v.q, v.page, v.pageSize); }),
  'dashboard.get': userHandler((ctx) => dashboard.dashboard(ctx)),
  'reports.run': userHandler((ctx, p) => dashboard.runReport(ctx, p as never)),
  'notifications.list': userHandler((ctx, p) => notifications.listNotifications(ctx, p as never)),
  'notifications.unreadCount': userHandler((ctx) => notifications.unreadCount(ctx)),
  'notifications.markRead': userHandler((ctx, p) => notifications.markRead(ctx, (p as { ids: string[] }).ids)),
  'notifications.refresh': userHandler((ctx) => notifications.refreshNotifications(ctx)),
  'docs.generate': async (ctx, p, deps) => {
    const v = p as { kind: string; id: string; paperSize?: PaperSize; forPatientId?: string };
    const paper = v.paperSize ?? ctx.clinic().paperSize;
    let result: { path: string; pageCount: number };
    if (v.kind === 'invoice') result = await generateInvoicePdf(ctx, v.id, paper, deps.docsDir);
    else if (v.kind === 'receipt') result = await generateReceiptPdf(ctx, v.id, deps.docsDir);
    else if (v.kind === 'prescription') result = await generatePrescriptionPdf(ctx, v.id, paper, deps.docsDir);
    else result = await generateStatementPdf(ctx, v.id, {}, paper, deps.docsDir);
    ctx.audit('docs.generate', v.kind, v.id, { path: result.path, pages: result.pageCount });
    return result;
  },
  'docs.openFolder': (_ctx, _p, deps) => ({ path: deps.docsDir }),
  'attachments.list': userHandler((ctx, p) => attachments.listAttachments(ctx, (p as { patientId: string }).patientId)),
  'attachments.add': async (ctx, p, deps) => attachments.addAttachment(ctx, deps.attachmentsDir, p as never),
  'attachments.open': (ctx, p, deps) => ({ path: attachments.attachmentFilePath(ctx, deps.attachmentsDir, (p as { id: string }).id) }),
  'attachments.remove': (ctx, p, deps) => attachments.removeAttachment(ctx, deps.attachmentsDir, (p as { id: string }).id),
  'backup.run': async (ctx, p, deps) => {
    const v = p as { targetDir?: string; note: string };
    return backupSvc.createBackup(ctx, deps.dbFile, v.targetDir || deps.backupsDir, v.note, ctx.user?.username ?? 'system');
  },
  'backup.history': userHandler((ctx) => backupSvc.backupHistory(ctx)),
  'restore.validate': (_ctx, p) => restoreSvc.validateRestore((p as { filePath: string }).filePath),
  'restore.run': async (_ctx, p, deps) => {
    const v = p as { filePath: string };
    const result = await restoreSvc.executeRestore(restoreSvc.restorePaths(deps.dataDir), v.filePath, () => deps.relinquishDb());
    deps.reopenDb();
    return result;
  },
  'import.run': userHandler((ctx, p) => importExport.runImport(ctx, p as never)),
  'export.run': userHandler((ctx, p) => { const v = p as { entity: string; from?: string; to?: string }; return importExport.runExport(ctx, v.entity, v); }),
  'audit.list': userHandler((ctx, p) => ops.listAudit(ctx, p as never)),
  'diagnostics.get': (ctx, _p, deps) => ops.diagnostics(ctx, deps.dbFile),
  'system.pickFile': async (_ctx, p, deps) => ({ path: deps.pickFile ? await deps.pickFile((p as { kind: 'backup' }).kind) : null }),
  'system.pickDir': async (_ctx, _p, deps) => ({ path: deps.pickDir ? await deps.pickDir() : null }),
};

export interface Gateway {
  invoke(token: string | null | undefined, channel: Channel, payload: unknown): Promise<IpcResult<unknown>>;
  sessions: SessionManager;
}

export function createGateway(deps: GatewayDeps): Gateway {
  return {
    sessions: deps.sessions,
    async invoke(token, channel, payload): Promise<IpcResult<unknown>> {
      const def = CHANNELS[channel];
      if (!def) return fail(err.validation(`Unknown channel: ${channel}`));
      try {
        let parsed: unknown;
        try {
          parsed = def.schema.parse(payload ?? {});
        } catch (e) {
          if (e instanceof ZodError) {
            const first = e.issues[0];
            const where = first?.path.join('.') || 'input';
            return fail(err.validation(`Invalid ${where}: ${first?.message ?? 'invalid value'}.`, e.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`)));
          }
          throw e;
        }
        let user: SessionUser | null = token ? deps.sessions.resolve(token) : null;
        const needsSetup = !isSchemaReady(deps.getDb()) || !hasUsers(deps.getDb());

        if (channel === 'auth.login' || channel === 'auth.unlock') {
          const ctx = makeCtx(deps.getDb(), null);
          const creds = parsed as { username?: string; password: string };
          const username = channel === 'auth.unlock' ? deps.getLastUsername() : (creds.username ?? '');
          if (!username) return fail(err.validation('Username is required.'));
          const auth = users.authenticate(ctx, { username, password: creds.password });
          user = { id: auth.id, username: auth.username, displayName: auth.displayName, role: auth.role };
          const newToken = deps.sessions.create(user);
          deps.setLastUsername(username);
          return ok({ token: newToken, user });
        }
        if (!def.preAuth && !user) return fail(err.unauthenticated());
        if (channel === 'auth.logout') {
          deps.sessions.destroy(token);
          return ok({ loggedOut: true });
        }
        if (!def.preAuth && needsSetup) return fail(err.invalidState('Setup has not been completed.'));
        if (def.permission && user) {
          const perms = ROLE_PERMISSIONS[user.role];
          if (!perms?.has(def.permission)) return fail(err.forbidden());
        }
        if (channel === 'auth.status') {
          return ok({ ready: true, needsSetup, user: user ?? null, lastUsername: deps.getLastUsername() });
        }
        const ctx = makeCtx(deps.getDb(), user);
        const handler = HANDLERS[channel];
        if (!handler) return fail(err.validation(`No handler for channel: ${channel}`));
        const result = await handler(ctx, parsed, deps, user);
        return ok(result ?? {});
      } catch (e) {
        if (!(e instanceof DomainError)) {
          logger.error('ipc.unhandled', { channel, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack?.slice(0, 800) : '' });
        }
        return fail(e);
      }
    },
  };
}
