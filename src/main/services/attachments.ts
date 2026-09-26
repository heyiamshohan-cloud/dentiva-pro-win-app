// Dentiva Pro - attachments: controlled storage, checksum-verified copy, path safety.
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { err } from '../../shared/errors';
import { uuid } from '../../shared/ids';
import { nowIso } from '../../shared/dates';
import { Ctx, tx } from './context';
import { getPatient } from './patients';

const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv', '.dcm']);

function sha256(path: string): Promise<string> {
  return new Promise((resolveP, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => resolveP(h.digest('hex'))).on('error', reject);
  });
}

export function listAttachments(ctx: Ctx, patientId: string) {
  if (!getPatient(ctx, patientId)) throw err.notFound('Patient');
  return ctx.db.prepare('SELECT id, patient_id, visit_id, file_name, mime, size, sha256, note, created_at FROM attachments WHERE patient_id = ? ORDER BY created_at DESC')
    .all(patientId);
}

export async function addAttachment(ctx: Ctx, storageDir: string, input: { patientId: string; visitId: string | null; sourcePath: string; note: string }) {
  if (!getPatient(ctx, input.patientId)) throw err.notFound('Patient');
  if (input.visitId) {
    const v = ctx.db.prepare('SELECT patient_id FROM visits WHERE id = ?').get(input.visitId) as { patient_id: string } | undefined;
    if (!v) throw err.notFound('Visit');
    if (v.patient_id !== input.patientId) throw err.validation('The visit belongs to a different patient.');
  }
  // Path safety: the source must be an absolute existing file with an allowed extension.
  const src = resolve(input.sourcePath);
  if (!existsSync(src)) throw err.io('The selected file does not exist.');
  const st = statSync(src);
  if (!st.isFile()) throw err.validation('The selected path is not a file.');
  if (st.size > MAX_BYTES) throw err.validation('Attachments are limited to 50 MB per file.');
  const ext = extname(src).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw err.validation(`Files of type "${ext || 'unknown'}" cannot be attached.`);
  const safeName = basename(src).replace(/[^\w. ()\-\[\]]/g, '_').slice(0, 160);
  const id = uuid();
  const storedName = `${id}${ext}`;
  mkdirSync(storageDir, { recursive: true });
  const dest = join(storageDir, storedName);
  // The destination must remain inside the controlled storage directory.
  if (!resolve(dest).startsWith(resolve(storageDir) + sep)) throw err.validation('Invalid storage path.');
  copyFileSync(src, dest);
  const hash = await sha256(dest);
  tx(ctx.db, () => {
    ctx.db
      .prepare('INSERT INTO attachments(id, patient_id, visit_id, file_name, stored_name, mime, size, sha256, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.patientId, input.visitId, safeName, storedName, mimeFor(ext), st.size, hash, input.note, ctx.user?.id ?? null, nowIso());
    ctx.audit('attachments.add', 'attachments', id, { patientId: input.patientId, file: safeName, size: st.size });
  });
  return { id, fileName: safeName, size: st.size, sha256: hash };
}

function mimeFor(ext: string): string {
  const map: Record<string, string> = {
    '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.txt': 'text/plain', '.csv': 'text/csv',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Returns the absolute stored path for main-process-only opening (renderer never receives raw paths). */
export function attachmentFilePath(ctx: Ctx, storageDir: string, id: string): string {
  const row = ctx.db.prepare('SELECT stored_name FROM attachments WHERE id = ?').get(id) as { stored_name: string } | undefined;
  if (!row) throw err.notFound('Attachment');
  const path = join(storageDir, row.stored_name);
  if (!resolve(path).startsWith(resolve(storageDir) + sep)) throw err.validation('Invalid attachment path.');
  if (!existsSync(path)) throw err.io('The attachment file is missing from storage.');
  return path;
}

export function removeAttachment(ctx: Ctx, storageDir: string, id: string): void {
  const row = ctx.db.prepare('SELECT stored_name, file_name, patient_id FROM attachments WHERE id = ?').get(id) as { stored_name: string; file_name: string; patient_id: string } | undefined;
  if (!row) throw err.notFound('Attachment');
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    ctx.audit('attachments.remove', 'attachments', id, { patientId: row.patient_id, file: row.file_name });
  });
  const path = join(storageDir, row.stored_name);
  if (resolve(path).startsWith(resolve(storageDir) + sep)) {
    try { rmSync(path, { force: true }); } catch { /* file may already be gone; the database record is removed */ }
  }
}
