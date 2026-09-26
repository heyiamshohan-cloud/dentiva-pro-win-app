// Dentiva Pro - backup/restore forensics: valid restore, invalid/corrupt/malicious inputs,
// interrupted-restore recovery, zip-slip rejection, inventory of safety guarantees.
import { describe, it, expect, afterEach } from 'vitest';
import { SCHEMA_VERSION } from '../../src/shared/constants';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { makeTestEnv, TestEnv, seedPatient, expectFail } from '../helpers';
import { createBackup, inspectBackupArchive, sha256File } from '../../src/main/services/backup';
import { executeRestore, restorePaths, recoverInterruptedRestore, validateRestore } from '../../src/main/services/restore';
import { openDb, integrityCheck } from '../../src/main/db/connection';
import { migrate } from '../../src/main/db/migrate';
import { makeCtx } from '../../src/main/services/context';

let env: TestEnv;
let work: string;
afterEach(() => {
  env?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
});

async function setupWork() {
  env = await makeTestEnv();
  work = mkdtempSync(join(tmpdir(), 'dentiva-restore-'));
}

const noOpRelinquish = () => { /* tests swap paths on a separate dataDir, not the live handle */ };

describe('backup', () => {
  it('creates a verifiable archive with manifest + checksum', async () => {
    await setupWork();
    await seedPatient(env, 'Backup Patient');
    const ctx = makeCtx(env.db, null);
    const b = await createBackup(ctx, env.dbFile, join(work, 'backups'), 'test backup', 'admin');
    expect(existsSync(b.path)).toBe(true);
    const zip = new AdmZip(b.path);
    const names = zip.getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(['checksums.txt', 'database.db', 'manifest.json']);
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString());
    expect(manifest.format).toBe('dentiva-backup');
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.dbSha256).toMatch(/^[0-9a-f]{64}$/);
    // checksum actually verifies the embedded database
    const cryptoDb = (await import('node:crypto')).createHash('sha256').update(zip.getEntry('database.db')!.getData()).digest('hex');
    expect(cryptoDb).toBe(manifest.dbSha256);
    // backup history recorded in DB
    const hist = env.db.prepare('SELECT * FROM backups').all() as { status: string }[];
    expect(hist).toHaveLength(1);
    expect(hist[0]!.status).toBe('ok');
  });

  it('snapshot is consistent even right after writes (no half transactions)', async () => {
    await setupWork();
    const ctx = makeCtx(env.db, null);
    for (let i = 0; i < 50; i++) await seedPatient(env, `B${i}`, `0171${String(1000000 + i)}`);
    const b = await createBackup(ctx, env.dbFile, join(work, 'backups'));
    const zip = new AdmZip(b.path);
    // extraction sharp check: the staged DB passes SQLite quick_check
    writeFileSync(join(work, 'snap.db'), zip.getEntry('database.db')!.getData());
    const check = integrityCheck(openDb(join(work, 'snap.db')));
    expect(check.ok).toBe(true);
  });
});

describe('restore validation', () => {
  it('rejects nonexistent / empty / non-zip files', async () => {
    await setupWork();
    expect(() => validateRestore(join(work, 'nope.zip'))).toThrowError(/does not exist/);
    writeFileSync(join(work, 'empty.zip'), Buffer.alloc(0));
    expect(() => validateRestore(join(work, 'empty.zip'))).toThrowError(/empty/);
    writeFileSync(join(work, 'garbage.zip'), 'not a zip at all');
    expect(() => validateRestore(join(work, 'garbage.zip'))).toThrowError(/not a valid Dentiva Pro backup/);
  });

  it('rejects archives missing required contents', async () => {
    await setupWork();
    // whitelisted entries only, but the database is absent
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'dentiva-backup', formatVersion: 1, schemaVersion: 1, dbSha256: 'x' })));
    zip.writeZip(join(work, 'bad.zip'));
    expect(() => validateRestore(join(work, 'bad.zip'))).toThrowError(/missing required backup contents/);
  });

  it('blocks zip-slip / path traversal entries (.., /, absolute, dotfiles)', async () => {
    await setupWork();
    for (const evil of ['../evil.db', 'sub/dir/database.db', 'C:\\windows\\evil.dll', '.hidden']) {
      const zip = new AdmZip();
      zip.addFile('manifest.json', Buffer.from('{}'));
      zip.addFile('database.db', Buffer.from('x'));
      zip.addFile(evil, Buffer.from('evil'));
      const file = join(work, 'slip.zip');
      zip.writeZip(file);
      expect(() => validateRestore(file)).toThrowError(/unexpected or unsafe entry/);
    }
  });

  it('blocks extra unexpected contents (whitelist)', async () => {
    await setupWork();
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'dentiva-backup', formatVersion: 1, schemaVersion: 1 })));
    zip.addFile('database.db', Buffer.from('x'));
    zip.addFile('payload.exe', Buffer.from('MZ'));
    const file = join(work, 'extra.zip');
    zip.writeZip(file);
    expect(() => validateRestore(file)).toThrowError(/unexpected or unsafe entry/);
  });

  it('blocks backups from a newer schema version', async () => {
    await setupWork();
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'dentiva-backup', formatVersion: 1, schemaVersion: 99, dbSha256: '', appVersion: '9.9.9' })));
    zip.addFile('database.db', Buffer.from('x'));
    const file = join(work, 'newer.zip');
    zip.writeZip(file);
    expect(() => validateRestore(file)).toThrowError(/newer version of Dentiva Pro/);
  });

  it('blocks backups whose database fails its SHA256 checksum', async () => {
    await setupWork();
    const ctx = makeCtx(env.db, null);
    const b = await createBackup(ctx, env.dbFile, join(work, 'backups'));
    // corrupt the embedded DB bytes but keep structure
    const zip = new AdmZip(readFileSync(b.path));
    zip.deleteFile('database.db');
    zip.addFile('database.db', Buffer.from('corrupted-bytes'));
    const file = join(work, 'corrupt.zip');
    zip.writeZip(file);
    await expect(executeRestore(restorePaths(work, 'live.db'), file, noOpRelinquish)).rejects.toThrowError(/integrity checksum/);
  });
});

describe('restore execution', () => {
  it('restores a valid backup completely and verifies state', async () => {
    await setupWork();
    // A: original data
    const first = await seedPatient(env, 'Original Patient', '01711111111');
    const ctx = makeCtx(env.db, null);
    const backup1 = await createBackup(ctx, env.dbFile, join(work, 'backups'));
    // B: more data AFTER backup
    await seedPatient(env, 'Later Patient', '01722222222');
    const countAfter = (env.db.prepare('SELECT COUNT(*) AS c FROM patients').get() as { c: number }).c;
    expect(countAfter).toBe(2);
    // C: restore into a separate sandbox data directory simulating the live location
    const simDir = join(work, 'sim');
    const simPaths = restorePaths(simDir);
    mkdirSync(simDir, { recursive: true });
    writeFileSync(simPaths.dbFile, readFileSync(env.dbFile));
    const r1 = await executeRestore(simPaths, backup1.path, noOpRelinquish);
    expect(r1.restored).toBe(true);
    const restored = openDb(simPaths.dbFile);
    const check = integrityCheck(restored);
    expect(check.ok).toBe(true);
    const rows = restored.prepare('SELECT name FROM patients').all() as { name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Original Patient');
    restored.close();
    void first;
  });

  it('on failure mid-restore the previous database is recoverable', async () => {
    await setupWork();
    const ctx = makeCtx(env.db, null);
    const backup1 = await createBackup(ctx, env.dbFile, join(work, 'backups'));
    const simDir = join(work, 'sim2');
    const simPaths = restorePaths(simDir);
    mkdirSync(simDir, { recursive: true });
    writeFileSync(simPaths.dbFile, 'ORIGINAL-LIVE-BYTES');
    // intercept: sabotage staged verification by corrupting manifest checksum AFTER validation? Instead
    // sabotage via a failing SQLite stage: build archive with valid checksum but non-SQLite payload.
    const zip = new AdmZip();
    const payload = Buffer.from('VALID-BUT-NOT-SQLITE');
    const hash = (await import('node:crypto')).createHash('sha256').update(payload).digest('hex');
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'dentiva-backup', formatVersion: 1, schemaVersion: 1, dbSha256: hash, appVersion: '1.0.0' })));
    zip.addFile('database.db', payload);
    const evilFile = join(work, 'notsqlite.zip');
    zip.writeZip(evilFile);
    await expect(executeRestore(simPaths, evilFile, noOpRelinquish)).rejects.toThrowError(/not a readable SQLite database|integrity check/);
    // live file preserved?
    expect(readFileSync(simPaths.dbFile, 'utf8')).toBe('ORIGINAL-LIVE-BYTES');
    void backup1;
  });

  it('recoverInterruptedRestore completes or rolls back after simulated crash', async () => {
    await setupWork();
    const simDir = join(work, 'sim3');
    const simPaths = restorePaths(simDir);
    mkdirSync(join(simDir, 'restore-work'), { recursive: true });
    // materialize a real (valid) sqlite file to represent the intact previous live DB
    const validDb = join(work, 'valid.db');
    const tmp = openDb(validDb); migrate(tmp); tmp.close();
    const validBytes = readFileSync(validDb);
    // Case 1: swap never happened; previous live db intact -> kept as-is, marker cleaned
    writeFileSync(simPaths.dbFile, validBytes);
    writeFileSync(join(simPaths.workRoot, 'restore-in-progress.json'), JSON.stringify({ safety: join(simPaths.workRoot, 'pre-restore-safety.db'), staged: 'x', dbFile: simPaths.dbFile }));
    writeFileSync(join(simPaths.workRoot, 'pre-restore-safety.db'), validBytes);
    let rec = recoverInterruptedRestore(simPaths);
    expect(rec.recovered).toBe(true);
    expect(rec.detail).toMatch(/verified|completed/i);
    expect(readFileSync(simPaths.dbFile).length).toBe(validBytes.length);
    expect(existsSync(join(simPaths.workRoot, 'restore-in-progress.json'))).toBe(false);
    // Case 2: live db missing, safety exists -> restored from safety
    rmSync(simPaths.dbFile, { force: true });
    mkdirSync(join(simDir, 'restore-work'), { recursive: true });
    writeFileSync(join(simPaths.workRoot, 'pre-restore-safety.db'), 'SAFETY-DB');
    writeFileSync(join(simPaths.workRoot, 'restore-in-progress.json'), JSON.stringify({ safety: join(simPaths.workRoot, 'pre-restore-safety.db'), dbFile: simPaths.dbFile }));
    rec = recoverInterruptedRestore(simPaths);
    expect(rec.recovered).toBe(true);
    expect(readFileSync(simPaths.dbFile, 'utf8')).toBe('SAFETY-DB');
  });

  it('restore into a pristine directory succeeds (reinstall-then-restore workflow)', async () => {
    await setupWork();
    await seedPatient(env, 'Pristine Restore Patient');
    // back up data from the live env
    const ctx = makeCtx(env.db, null);
    const b = await createBackup(ctx, env.dbFile, join(work, 'backups'));
    // simulate a fresh install: empty data directory that does not exist yet
    const simPaths = restorePaths(join(work, 'fresh-install', 'data'));
    const r = await executeRestore(simPaths, b.path, noOpRelinquish);
    expect(r.restored).toBe(true);
    const db = openDb(simPaths.dbFile);
    const check = integrityCheck(db);
    expect(check.ok).toBe(true);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM patients').get() as { c: number }).c;
    expect(count).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

describe('restore via gateway (RBAC enforced)', () => {
  it('only administrators can restore', async () => {
    await setupWork();
    const staff = await env.tokenFor('staff', 'inv1', 'InvPass111');
    const r = await env.call(staff, 'restore.run', { filePath: '/tmp/anything.zip' });
    expectFail(r, 'FORBIDDEN');
  });
});

describe('full database equality after backup for sha determinism', () => {
  it('backup file sha is stored and is a real hex digest', async () => {
    await setupWork();
    const ctx = makeCtx(env.db, null);
    const b = await createBackup(ctx, env.dbFile, join(work, 'backups'));
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    const actual = await sha256File(b.path);
    expect(actual).toBe(b.sha256);
  });
});
