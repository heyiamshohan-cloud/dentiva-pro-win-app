// Dentiva Pro - ordered, transactional migration runner with version tracking.
import { Db } from './connection';
import { migration0001 } from './migrations/0001_init';
import { migration0002 } from './migrations/0002_patient_blood_group';

export interface Migration {
  name: string;
  up(db: Db): void;
}

export const MIGRATIONS: Migration[] = [migration0001, migration0002];

export function appliedMigrations(db: Db): string[] {
  try {
    const rows = db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[];
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  version: number;
}

export function migrate(db: Db): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations(
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set(appliedMigrations(db));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    const run = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO _migrations(name, applied_at) VALUES (?, ?)').run(m.name, new Date().toISOString());
    });
    run();
    applied.push(m.name);
  }
  db.pragma(`user_version = ${MIGRATIONS.length}`);
  return { applied, alreadyApplied: [...done], version: MIGRATIONS.length };
}
