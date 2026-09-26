// Dentiva Pro - 0002: add blood_group to patients (new column, legacy rows default to '').
import { Migration } from '../migrate';

export const migration0002: Migration = {
  name: '0002_patient_blood_group',
  up(db) {
    const cols = db.prepare("PRAGMA table_info('patients')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'blood_group')) {
      db.exec("ALTER TABLE patients ADD COLUMN blood_group TEXT NOT NULL DEFAULT ''");
    }
  },
};
