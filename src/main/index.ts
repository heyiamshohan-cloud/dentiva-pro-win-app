// Dentiva Pro - Electron main process: lifecycle, hardened window, gateway wiring.
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { openDb, Db } from './db/connection';
import { migrate } from './db/migrate';
import { SessionManager } from './security/session';
import { createGateway, Gateway } from './ipc/gateway';
import { recoverInterruptedRestore, restorePaths } from './services/restore';
import { initLogging, logger } from './util/log';
import { makeCtx, hasUsers } from './services/context';
import { refreshNotifications } from './services/notifications';
import { createBackup } from './services/backup';
import { APP_NAME } from '../shared/constants';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let db: Db | null = null;
let gateway: Gateway | null = null;
let mainWindow: BrowserWindow | null = null;
let lastUsername = '';

const paths = {
  get dataDir() { return join(app.getPath('userData'), 'dentiva-data'); },
  get dbFile() { return join(this.dataDir, 'dentiva.db'); },
  get attachmentsDir() { return join(this.dataDir, 'attachments'); },
  get backupsDir() { return join(this.dataDir, 'backups'); },
  get docsDir() { return join(this.dataDir, 'documents'); },
  get logFile() { return join(this.dataDir, 'logs', 'app.log'); },
};

function openDatabase(): Db {
  mkdirSync(paths.dataDir, { recursive: true });
  const d = openDb(paths.dbFile);
  migrate(d);
  return d;
}

function relinquishDb(): void {
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
}

function reopenDb(): void {
  relinquishDb();
  db = openDatabase();
  gateway?.sessions.destroyAll();
  mainWindow?.webContents.send('app:db-restored');
}

function buildGateway(): Gateway {
  const sessions = new SessionManager(30);
  return createGateway({
    getDb: () => { if (!db) db = openDatabase(); return db!; },
    sessions,
    dbFile: paths.dbFile,
    dataDir: paths.dataDir,
    attachmentsDir: paths.attachmentsDir,
    backupsDir: paths.backupsDir,
    docsDir: paths.docsDir,
    relinquishDb,
    reopenDb,
    getLastUsername: () => lastUsername,
    setLastUsername: (u) => { lastUsername = u; },
    pickFile: async (kind) => {
      if (!mainWindow) return null;
      const filters = kind === 'backup'
        ? [{ name: 'Dentiva Backup', extensions: ['zip'] }]
        : kind === 'import'
          ? [{ name: 'CSV', extensions: ['csv'] }]
          : kind === 'logo'
            ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
            : [{ name: 'Documents & Images', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv', 'dcm'] }];
      const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
    pickDir: async () => {
      if (!mainWindow) return null;
      const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0f1722',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // Navigation is locked to the packaged renderer.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function wireIpc(): void {
  ipcMain.handle('dentiva:invoke', async (_e, msg: { channel: string; payload: unknown; token: string | null }) => {
    if (!gateway) return { ok: false, error: { code: 'INTERNAL', message: 'Application is not ready.' } };
    // Channel allowlist is enforced inside the gateway as well.
    return gateway.invoke(msg.token, msg.channel as never, msg.payload);
  });
  ipcMain.handle('dentiva:open-path', async (_e, path: string) => {
    // Only paths inside our controlled directories may be opened.
    const allowed = [paths.docsDir, paths.attachmentsDir, paths.backupsDir].some((d) => String(path).startsWith(d));
    if (!allowed) return { ok: false };
    const r = await shell.openPath(String(path));
    return { ok: !r, error: r || undefined };
  });
  ipcMain.handle('dentiva:show-in-folder', async (_e, path: string) => {
    const allowed = [paths.docsDir, paths.attachmentsDir, paths.backupsDir].some((d) => String(path).startsWith(d));
    if (allowed) shell.showItemInFolder(String(path));
    return { ok: allowed };
  });
}

async function startup(): Promise<void> {
  initLogging(paths.logFile);
  logger.info('app.starting', { version: app.getVersion() });
  // Crash-recovery marker from any interrupted restore is resolved BEFORE opening the DB.
  const recovery = recoverInterruptedRestore(restorePaths(paths.dataDir));
  if (recovery.recovered) logger.warn('app.restore_recovery', { detail: recovery.detail });
  mkdirSync(paths.docsDir, { recursive: true });
  mkdirSync(paths.attachmentsDir, { recursive: true });
  mkdirSync(paths.backupsDir, { recursive: true });
  db = openDatabase();
  gateway = buildGateway();
  wireIpc();
  createWindow();
  // Background maintenance: notifications refresh + optional auto-backup.
  try {
    if (hasUsers(db)) {
      const ctx = makeCtx(db, null);
      refreshNotifications(ctx);
      const c = ctx.clinic();
      if (c.autoBackupEnabled && c.autoBackupDir && existsSync(c.autoBackupDir)) {
        const last = db.prepare("SELECT MAX(created_at) AS m FROM backups WHERE status = 'ok'").get() as { m: string | null };
        const due = !last.m || Date.now() - new Date(last.m).getTime() > 24 * 3600 * 1000;
        if (due) {
          const b = await createBackup(ctx, paths.dbFile, c.autoBackupDir, 'Scheduled automatic backup');
          logger.info('backup.auto', { path: b.path });
        }
      }
    }
  } catch (e) {
    logger.warn('app.maintenance_failed', { reason: e instanceof Error ? e.message : String(e) });
  }
  setInterval(() => {
    try {
      if (db && hasUsers(db)) refreshNotifications(makeCtx(db, null));
    } catch { /* notifications refresh is best-effort */ }
  }, 5 * 60 * 1000).unref();
}

app.whenReady().then(() => { void startup(); });
app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});
app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { relinquishDb(); });
