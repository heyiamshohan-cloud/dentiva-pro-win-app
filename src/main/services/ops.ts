// Dentiva Pro - audit log listing + diagnostics.
import { statSync, existsSync } from 'node:fs';
import { makePage } from '../../shared/validation/common';
import { AuditListQuery } from '../../shared/validation/system';
import { Ctx } from './context';
import { integrityCheck } from '../db/connection';
import { SCHEMA_VERSION, APP_VERSION } from '../../shared/constants';

export function listAudit(ctx: Ctx, q: AuditListQuery) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.from) { where.push('at >= @from'); params.from = `${q.from}T00:00:00.000Z`; }
  if (q.to) { where.push('at <= @to'); params.to = `${q.to}T23:59:59.999Z`; }
  if (q.userId) { where.push('user_id = @uid'); params.uid = q.userId; }
  if (q.entity) { where.push('entity = @entity'); params.entity = q.entity; }
  if (q.action) { where.push('action = @action'); params.action = q.action; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM audit_log ${whereSql}`).get(params) as { c: number }).c;
  const rows = ctx.db
    .prepare(`SELECT * FROM audit_log ${whereSql} ORDER BY at DESC, id LIMIT @lim OFFSET @off`)
    .all({ ...params, lim: q.pageSize, off: (q.page - 1) * q.pageSize });
  return makePage(rows, total, q.page, q.pageSize);
}

export function diagnostics(ctx: Ctx, dbFile: string) {
  const integrity = integrityCheck(ctx.db);
  const tables = ctx.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name")
    .all() as { name: string }[];
  const counts: Record<string, number> = {};
  for (const t of tables) {
    counts[t.name] = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number }).c;
  }
  const pageCount = ctx.db.pragma('page_count', { simple: true }) as number;
  const pageSize = ctx.db.pragma('page_size', { simple: true }) as number;
  return {
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    dbFile,
    dbFileSizeBytes: existsSync(dbFile) ? statSync(dbFile).size : 0,
    dbLogicalBytes: pageCount * pageSize,
    integrity: integrity.detail,
    integrityOk: integrity.ok,
    walMode: ctx.db.pragma('journal_mode', { simple: true }),
    foreignKeys: ctx.db.pragma('foreign_keys', { simple: true }) === 1,
    tableCounts: counts,
    nodeVersion: process.version,
    platform: process.platform,
    generatedAt: new Date().toISOString(),
  };
}
