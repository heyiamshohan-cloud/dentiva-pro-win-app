// Dentiva Pro - notifications: generated from real operational state, deduplicated, paginated.
import { uuid } from '../../shared/ids';
import { nowIso, todayClinic } from '../../shared/dates';
import { makePage } from '../../shared/validation/common';
import { NotificationListQuery } from '../../shared/validation/system';
import { Ctx, tx } from './context';
import { lowStock, expiries } from './inventory';

function push(ctx: Ctx, n: { kind: string; title: string; body: string; entity?: string; entityId?: string; severity: 'info' | 'warning' | 'critical'; dedupeKey?: string }): void {
  ctx.db
    .prepare(
      `INSERT INTO notifications(id, kind, title, body, entity, entity_id, severity, dedupe_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    )
    .run(uuid(), n.kind, n.title, n.body, n.entity ?? '', n.entityId ?? '', n.severity, n.dedupeKey ?? null, nowIso());
}

/** Re-scan operational state and create due notifications. Idempotent via dedupe keys. */
export function refreshNotifications(ctx: Ctx): { created: number } {
  const before = (ctx.db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c;
  tx(ctx.db, () => {
    const today = todayClinic(ctx.clinic().timezone);
    for (const item of lowStock(ctx) as { id: string; sku: string; name: string; qty_on_hand: number; reorder_level: number }[]) {
      push(ctx, {
        kind: 'low_stock', title: `Low stock: ${item.name}`,
        body: `${item.sku} has ${item.qty_on_hand} remaining (reorder level ${item.reorder_level}).`,
        entity: 'inventory_items', entityId: item.id, severity: 'warning', dedupeKey: `low_stock:${item.id}:${today}`,
      });
    }
    for (const lot of expiries(ctx, 30) as { id: string; name: string; batch_no: string; expiry_date: string; remaining: number }[]) {
      push(ctx, {
        kind: 'expiry', title: `Expiring stock: ${lot.name}`,
        body: `Batch ${lot.batch_no} (${lot.remaining} units) expires ${lot.expiry_date}.`,
        entity: 'inventory_items', entityId: lot.id, severity: 'warning', dedupeKey: `expiry:${lot.id}:${lot.batch_no}:${today}`,
      });
    }
    const appts = ctx.db
      .prepare(
        `SELECT a.id, a.starts_at, p.name FROM appointments a JOIN patients p ON p.id = a.patient_id
         WHERE substr(a.starts_at, 1, 10) = ? AND a.status IN ('scheduled','confirmed')`,
      )
      .all(today) as { id: string; starts_at: string; name: string }[];
    if (appts.length) {
      push(ctx, {
        kind: 'appointment_today', title: `${appts.length} appointment${appts.length > 1 ? 's' : ''} today`,
        body: appts.slice(0, 4).map((a) => `${a.starts_at.slice(11, 16)} ${a.name}`).join(' · ') + (appts.length > 4 ? ` +${appts.length - 4} more` : ''),
        entity: 'appointments', severity: 'info', dedupeKey: `appointments:${today}:${appts.length}`,
      });
    }
    const followUps = ctx.db
      .prepare(
        `SELECT v.id, p.name, v.follow_up_date FROM visits v JOIN patients p ON p.id = v.patient_id
         WHERE v.follow_up_date IS NOT NULL AND v.follow_up_date <= ? AND v.status != 'cancelled'`,
      )
      .all(today) as { id: string; name: string; follow_up_date: string }[];
    for (const f of followUps.slice(0, 20)) {
      push(ctx, {
        kind: 'followup_due', title: `Follow-up due: ${f.name}`,
        body: `Scheduled follow-up date ${f.follow_up_date}.`,
        entity: 'visits', entityId: f.id, severity: 'info', dedupeKey: `followup:${f.id}:${f.follow_up_date}`,
      });
    }
    const lastBackup = ctx.db.prepare("SELECT created_at FROM backups WHERE status = 'ok' ORDER BY created_at DESC LIMIT 1").get() as { created_at: string } | undefined;
    if (!lastBackup || Date.now() - new Date(lastBackup.created_at).getTime() > 7 * 24 * 3600 * 1000) {
      push(ctx, {
        kind: 'backup', title: 'Backup recommended',
        body: lastBackup ? 'The last successful backup is more than 7 days old.' : 'No backup has ever been created on this system.',
        entity: 'backups', severity: 'critical', dedupeKey: `backup-reminder:${today}`,
      });
    }
  });
  const after = (ctx.db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c;
  return { created: after - before };
}

export function listNotifications(ctx: Ctx, q: NotificationListQuery) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.unreadOnly) where.push('read_at IS NULL');
  if (q.kind) { where.push('kind = @kind'); params.kind = q.kind; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM notifications ${whereSql}`).get(params) as { c: number }).c;
  const rows = ctx.db
    .prepare(`SELECT * FROM notifications ${whereSql} ORDER BY created_at DESC, id LIMIT @lim OFFSET @off`)
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize });
  return makePage(rows, total, q.page, q.pageSize);
}

export function unreadCount(ctx: Ctx): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE read_at IS NULL').get() as { c: number }).c;
}

export function markRead(ctx: Ctx, ids: string[]): void {
  tx(ctx.db, () => {
    const stmt = ctx.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL');
    const now = nowIso();
    for (const id of ids) stmt.run(now, id);
  });
}
