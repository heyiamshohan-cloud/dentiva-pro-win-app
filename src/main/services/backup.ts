// Dentiva Pro - backup: consistent snapshot (VACUUM INTO) + manifest + SHA256, zipped.
// Restore is in restore.ts. Backups stay fully local (offline-first privacy rule).
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { err } from '../../shared/errors';
import { uuid } from '../../shared/ids';
import { nowIso } from '../../shared/dates';
import { APP_VERSION, SCHEMA_VERSION } from '../../shared/constants';
import { Ctx, tx } from './context';
import { logger } from '../util/log';

export const BACKUP_MANIFEST = 'manifest.json';
export const BACKUP_DB = 'database.db';
export const BACKUP_CHECKSUMS = 'checksums.txt';
const ALLOWED_ENTRIES = new Set([BACKUP_MANIFEST, BACKUP_DB, BACKUP_CHECKSUMS]);

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

export interface BackupManifest {
  format: 'dentiva-backup';
  formatVersion: 1;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  createdBy: string;
  dbSha256: string;
  dbSize: number;
  note: string;
}

function stamp(): string {
  return nowIso().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

export async function createBackup(ctx: Ctx | null, dbFile: string, targetDir: string, note = '', username = 'system'): Promise<{ path: string; size: number; sha256: string }> {
  const workDir = join(targetDir, `.backup-tmp-${uuid()}`);
  try {
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    // 1. Consistent snapshot. VACUUM INTO produces a transactionally consistent copy.
    const snapshot = join(workDir, 'snapshot.db');
    if (ctx) ctx.db.pragma('wal_checkpoint(TRUNCATE)');
    const { default: Database } = await import('better-sqlite3');
    const src = new Database(dbFile, { readonly: true });
    try {
      src.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
    const dbHash = await sha256File(snapshot);
    const dbSize = statSync(snapshot).size;
    const manifest: BackupManifest = {
      format: 'dentiva-backup', formatVersion: 1, appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION,
      createdAt: nowIso(), createdBy: username, dbSha256: dbHash, dbSize, note,
    };
    // 2. Assemble the archive.
    const zip = new AdmZip();
    zip.addFile(BACKUP_DB, readFileSync(snapshot));
    zip.addFile(BACKUP_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)));
    zip.addFile(BACKUP_CHECKSUMS, Buffer.from(`sha256  ${dbHash}  ${BACKUP_DB}\n`));
    const finalName = `dentiva-backup-${stamp()}.zip`;
    const tmpZip = join(workDir, finalName);
    zip.writeZip(tmpZip);
    // 3. Atomic move into place.
    const finalPath = join(targetDir, finalName);
    renameSync(tmpZip, finalPath);
    const zipHash = await sha256File(finalPath);
    const size = statSync(finalPath).size;
    if (ctx) {
      tx(ctx.db, () => {
        ctx.db.prepare('INSERT INTO backups(id, created_at, path, size, sha256, app_version, schema_version, status, note) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(uuid(), nowIso(), finalPath, size, zipHash, APP_VERSION, SCHEMA_VERSION, 'ok', note);
        ctx.audit('backup.create', 'backups', finalPath, { size, sha256: zipHash });
      });
    }
    return { path: finalPath, size, sha256: zipHash };
  } catch (e) {
    if (ctx) {
      try { tx(ctx.db, () => ctx.audit('backup.failed', 'backups', '', { reason: e instanceof Error ? e.message : String(e) })); } catch { /* audit must not mask the real error */ }
    }
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw err.backup('Not enough disk space to create the backup. Free some space and try again.');
    }
    throw err.backup(`The backup could not be created: ${e instanceof Error ? e.message : String(e)}. Your database has not been changed.`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function backupHistory(ctx: Ctx) {
  const rows = ctx.db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map((r) => ({ ...r, exists: existsSync(String(r.path)) }));
}

/** Validate an archive candidate. Throws DomainError('RESTORE') on any violation. */
export function inspectBackupArchive(zipPath: string, maxSchemaVersion: number): { manifest: BackupManifest; zip: AdmZip } {
  if (!existsSync(zipPath)) throw err.restore('The selected backup file does not exist.');
  if (statSync(zipPath).size === 0) throw err.restore('The selected backup file is empty.');
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch {
    throw err.restore('The selected file is not a valid Dentiva Pro backup archive.');
  }
  const entries = zip.getEntries().map((e) => e.entryName);
  // Zip-slip / path-traversal protection: exact whitelist, no separators, no dot-segments, no drives.
  for (const name of entries) {
    if (
      !ALLOWED_ENTRIES.has(name) ||
      name.includes('/') || name.includes('\\') || name.includes('..') ||
      name.includes(':') || name.startsWith('.')
    ) {
      throw err.restore(`The backup archive contains an unexpected or unsafe entry ("${name}") and was rejected. Your current database has not been changed.`);
    }
  }
  const manifestEntry = zip.getEntry(BACKUP_MANIFEST);
  const dbEntry = zip.getEntry(BACKUP_DB);
  if (!manifestEntry || !dbEntry) {
    throw err.restore('The archive is missing required backup contents (manifest or database). Your current database has not been changed.');
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as BackupManifest;
  } catch {
    throw err.restore('The backup manifest is unreadable. Your current database has not been changed.');
  }
  if (manifest.format !== 'dentiva-backup' || manifest.formatVersion !== 1) {
    throw err.restore('This file is not a Dentiva Pro v1 backup. Your current database has not been changed.');
  }
  if (typeof manifest.schemaVersion !== 'number' || manifest.schemaVersion > maxSchemaVersion) {
    throw err.restore(
      `This backup was created by a newer version of Dentiva Pro (schema ${manifest.schemaVersion}). Update the application before restoring. Your current database has not been changed.`,
    );
  }
  return { manifest, zip };
}

/** Extract the database to a verified staging file (integrity + checksum verified). */
export function stageBackupDatabase(zip: AdmZip, manifest: BackupManifest, stagingPath: string): void {
  const dbEntry = zip.getEntry(BACKUP_DB);
  if (!dbEntry) throw err.restore('Backup database entry is missing.');
  mkdirSync(join(stagingPath, '..'), { recursive: true });
  writeFileSync(stagingPath, dbEntry.getData());
  const hash = createHash('sha256').update(dbEntry.getData()).digest('hex');
  if (hash !== manifest.dbSha256) {
    rmSync(stagingPath, { force: true });
    throw err.restore('The backup database failed its integrity checksum and was rejected. Your current database has not been changed.');
  }
  logger.info('backup.staged', { stagingPath, sha256: hash });
}
