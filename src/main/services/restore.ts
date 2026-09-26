// Dentiva Pro - restore: validate -> safety copy -> marker -> atomic swap -> verify.
// Any failure leaves the clinic's previous database restorable. Crash recovery is
// driven by a durable marker file checked at every application start.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { err } from '../../shared/errors';
import { uuid } from '../../shared/ids';
import { nowIso } from '../../shared/dates';
import { APP_VERSION, SCHEMA_VERSION } from '../../shared/constants';
import { openDb, integrityCheck } from '../db/connection';
import { Ctx } from './context';
import { inspectBackupArchive, stageBackupDatabase } from './backup';
import { logger } from '../util/log';

const MARKER = 'restore-in-progress.json';

export interface RestorePaths {
  dbFile: string;          // live database file
  dataDir: string;         // application data directory
  workRoot: string;        // scratch area (<dataDir>/restore-work)
}

export function restorePaths(dataDir: string, dbFileName = 'dentiva.db'): RestorePaths {
  return { dbFile: join(dataDir, dbFileName), dataDir, workRoot: join(dataDir, 'restore-work') };
}

export interface RestorePlan {
  backupPath: string;
  manifest: unknown;
  dbSize: number;
  schemaVersion: number;
  appVersion: string;
}

export function validateRestore(zipPath: string): RestorePlan {
  const { manifest, zip } = inspectBackupArchive(zipPath, SCHEMA_VERSION);
  const dbEntry = zip.getEntry('database.db')!;
  return {
    backupPath: zipPath, manifest, dbSize: dbEntry.getData().length,
    schemaVersion: manifest.schemaVersion, appVersion: manifest.appVersion,
  };
}

function writeMarker(paths: RestorePaths, state: Record<string, unknown>): void {
  mkdirSync(paths.workRoot, { recursive: true });
  writeFileSync(join(paths.workRoot, MARKER), JSON.stringify({ ...state, at: nowIso() }, null, 2));
}

function clearMarker(paths: RestorePaths): void {
  rmSync(join(paths.workRoot, MARKER), { force: true });
}

function cleanupWork(paths: RestorePaths): void {
  rmSync(paths.workRoot, { recursive: true, force: true });
}

/**
 * Execute a validated restore. `relinquish` must close the live DB connection
 * (the app performs the swap with no handle held), and it is ALWAYS called once.
 */
export async function executeRestore(
  paths: RestorePaths,
  zipPath: string,
  relinquish: () => void,
): Promise<{ restored: true }> {
  const { manifest } = inspectBackupArchive(zipPath, SCHEMA_VERSION);
  try {
    mkdirSync(paths.workRoot, { recursive: true });
    // Phase 1: stage + verify incoming database (checksum-verified file, then SQLite integrity check).
    const staged = join(paths.workRoot, 'staged.db');
    stageBackupDatabaseForPath(zipPath, staged);
    verifySqliteFile(staged, manifest.schemaVersion);
    // Phase 2: release the live connection (clean close checkpoints the WAL into the
    // main file, so the on-disk .db is complete and self-contained).
    relinquish();
    removeDbSidecars(paths.dbFile);
    // Phase 3: safety copy of the live database (now guaranteed complete).
    const safety = join(paths.workRoot, 'pre-restore-safety.db');
    if (existsSync(paths.dbFile)) copyFileSync(paths.dbFile, safety);
    // Phase 4: durable crash marker BEFORE the swap.
    writeMarker(paths, { state: 'restore-in-progress', backup: zipPath, safety, staged, dbFile: paths.dbFile });
    // Phase 5: swap atomically (same-volume renames).
    if (existsSync(paths.dbFile)) renameSync(paths.dbFile, join(paths.workRoot, 'old-live.db'));
    renameSync(staged, paths.dbFile);
    // Phase 5: verify the new live database REALLY opens and is consistent.
    verifySqliteFile(paths.dbFile, manifest.schemaVersion);
    clearMarker(paths);
    cleanupWork(paths);
    logger.info('restore.completed', { backup: zipPath });
    return { restored: true };
  } catch (e) {
    // Rollback path: never leave the clinic without its original database.
    try {
      const oldLive = join(paths.workRoot, 'old-live.db');
      const safety = join(paths.workRoot, 'pre-restore-safety.db');
      if (!existsSync(paths.dbFile)) {
        if (existsSync(oldLive)) renameSync(oldLive, paths.dbFile);
        else if (existsSync(safety)) copyFileSync(safety, paths.dbFile);
      } else {
        const check = integrityCheck(openDb(paths.dbFile));
        if (!check.ok) {
          rmSync(paths.dbFile, { force: true });
          if (existsSync(oldLive)) renameSync(oldLive, paths.dbFile);
          else if (existsSync(safety)) copyFileSync(safety, paths.dbFile);
        }
      }
    } catch (rb) {
      logger.error('restore.rollback_failed', { reason: rb instanceof Error ? rb.message : String(rb) });
    }
    try { clearMarker(paths); } catch { /* best effort */ }
    cleanupWork(paths);
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'EACCES') {
      throw err.restore('Restore failed: the database folder is not writable by this user. Run with sufficient permissions. Your previous database has been preserved.');
    }
    if (e instanceof Error && (e as { code?: string }).code) { /* DomainErrors pass through */ throw e; }
    throw err.restore(`Restore failed: ${e instanceof Error ? e.message : String(e)}. Your previous database has been preserved.`);
  }
}

function stageBackupDatabaseForPath(zipPath: string, staged: string): void {
  const { manifest, zip } = inspectBackupArchive(zipPath, SCHEMA_VERSION);
  stageBackupDatabase(zip, manifest as never, staged);
}

function removeDbSidecars(dbFile: string): void {
  rmSync(`${dbFile}-wal`, { force: true });
  rmSync(`${dbFile}-shm`, { force: true });
  rmSync(`${dbFile}-journal`, { force: true });
}

function verifySqliteFile(dbPath: string, maxSchema: number): void {
  let db;
  try {
    db = openDb(dbPath);
  } catch {
    throw err.restore('The restored file is not a readable SQLite database. Your previous database has been preserved.');
  }
  try {
    const check = integrityCheck(db);
    if (!check.ok) throw err.restore('The restored database failed its integrity check. Your previous database has been preserved.');
    const uv = db.pragma('user_version', { simple: true }) as number;
    if (typeof uv === 'number' && uv > maxSchema) {
      throw err.restore('The backup uses a newer database schema than this application supports. Update the application before restoring.');
    }
  } finally {
    db.close();
  }
}

/** Called at every application start: complete or roll back an interrupted restore. */
export function recoverInterruptedRestore(paths: RestorePaths): { recovered: boolean; detail: string } {
  const markerPath = join(paths.workRoot, MARKER);
  if (!existsSync(markerPath)) return { recovered: false, detail: 'no marker' };
  let marker: { safety?: string; staged?: string; dbFile?: string } = {};
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    cleanupWork(paths);
    return { recovered: true, detail: 'corrupt marker removed' };
  }
  const safety = marker.safety ?? join(paths.workRoot, 'pre-restore-safety.db');
  const oldLive = join(paths.workRoot, 'old-live.db');
  const dbFile = marker.dbFile ?? paths.dbFile;
  let detail = 'interrupted restore resolved';
  try {
    if (!existsSync(dbFile)) {
      // Swap never completed (or db vanished): restore the previous database.
      if (existsSync(oldLive)) { renameSync(oldLive, dbFile); detail = 'rolled back to previous database (swap had not completed)'; }
      else if (existsSync(safety)) { copyFileSync(safety, dbFile); detail = 'restored from pre-restore safety copy'; }
    } else {
      try {
        const db = openDb(dbFile);
        const check = integrityCheck(db);
        db.close();
        if (!check.ok) throw new Error('integrity');
        detail = 'replacement database verified after crash - restore completed';
      } catch {
        rmSync(dbFile, { force: true });
        if (existsSync(oldLive)) renameSync(oldLive, dbFile);
        else if (existsSync(safety)) copyFileSync(safety, dbFile);
        detail = 'replacement database was corrupt after crash - rolled back to previous database';
      }
    }
  } finally {
    clearMarker(paths);
    cleanupWork(paths);
  }
  logger.warn('restore.recovered', { detail });
  return { recovered: true, detail };
}
