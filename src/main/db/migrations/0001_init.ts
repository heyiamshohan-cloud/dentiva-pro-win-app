// Dentiva Pro - 0001_init: full production schema.
import { Migration } from '../migrate';

export const migration0001: Migration = {
  name: '0001_init',
  up(db) {
    db.exec(`
CREATE TABLE settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sequences(
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE users(
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','dentist','receptionist','accountant','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log(
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  user_id TEXT,
  username TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE patients(
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  gender TEXT CHECK (gender IN ('male','female','other') OR gender IS NULL),
  dob TEXT,
  phone TEXT NOT NULL DEFAULT '',
  phone_digits TEXT NOT NULL DEFAULT '',
  alt_phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  email_lower TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  emergency_contact_name TEXT NOT NULL DEFAULT '',
  emergency_contact_phone TEXT NOT NULL DEFAULT '',
  occupation TEXT NOT NULL DEFAULT '',
  referral_source TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  created_by TEXT
);
CREATE INDEX idx_patients_name ON patients(name_lower);
CREATE INDEX idx_patients_phone ON patients(phone_digits);
CREATE INDEX idx_patients_created ON patients(created_at);
CREATE INDEX idx_patients_dob ON patients(dob);

CREATE TABLE patient_tags(
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (patient_id, tag)
);

CREATE TABLE patient_medical(
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('allergy','medication','condition','medical_note','dental_note')),
  value TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_medical_patient ON patient_medical(patient_id, kind);

CREATE VIRTUAL TABLE patients_fts USING fts5(
  patient_id UNINDEXED, name, code, phone, email, tokenize = 'unicode61'
);
CREATE TRIGGER patients_fts_ai AFTER INSERT ON patients BEGIN
  INSERT INTO patients_fts(rowid, patient_id, name, code, phone, email)
  VALUES (new.rowid, new.id, new.name, new.code, new.phone, new.email);
END;
CREATE TRIGGER patients_fts_ad AFTER DELETE ON patients BEGIN
  DELETE FROM patients_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER patients_fts_au AFTER UPDATE ON patients BEGIN
  DELETE FROM patients_fts WHERE rowid = old.rowid;
  INSERT INTO patients_fts(rowid, patient_id, name, code, phone, email)
  VALUES (new.rowid, new.id, new.name, new.code, new.phone, new.email);
END;

CREATE TABLE visits(
  id TEXT PRIMARY KEY,
  visit_no TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  dentist_id TEXT,
  appointment_id TEXT,
  started_at TEXT NOT NULL,
  chief_complaint TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  symptoms TEXT NOT NULL DEFAULT '',
  findings TEXT NOT NULL DEFAULT '',
  diagnosis TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  follow_up_date TEXT,
  referral TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_visits_patient ON visits(patient_id, started_at DESC);
CREATE INDEX idx_visits_started ON visits(started_at);
CREATE INDEX idx_visits_followup ON visits(follow_up_date);

CREATE TABLE visit_procedures(
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  treatment_id TEXT,
  name TEXT NOT NULL,
  tooth INTEGER,
  surface TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL CHECK (qty > 0),
  price_paisa INTEGER NOT NULL DEFAULT 0 CHECK (price_paisa >= 0),
  anesthesia TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_procedures_visit ON visit_procedures(visit_id);

CREATE TABLE prescriptions(
  id TEXT PRIMARY KEY,
  rx_no TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  visit_id TEXT,
  dentist_id TEXT,
  date TEXT NOT NULL,
  cc TEXT NOT NULL DEFAULT '[]',
  oe TEXT NOT NULL DEFAULT '[]',
  re TEXT NOT NULL DEFAULT '',
  advice TEXT NOT NULL DEFAULT '',
  follow_up_date TEXT,
  finalized_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_rx_patient ON prescriptions(patient_id, date DESC);

CREATE TABLE prescription_items(
  id TEXT PRIMARY KEY,
  rx_id TEXT NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  drug_name TEXT NOT NULL,
  strength TEXT NOT NULL DEFAULT '',
  dose TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL DEFAULT '',
  duration TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT 'oral',
  instructions TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_rx_items ON prescription_items(rx_id);

CREATE TABLE dental_chart(
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  dentition TEXT NOT NULL CHECK (dentition IN ('adult','primary')),
  tooth INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sound','caries','restoration','crown','root_canal','missing','implant','fractured','impacted','watch')),
  notes TEXT NOT NULL DEFAULT '',
  visit_id TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (patient_id, dentition, tooth)
);

CREATE TABLE dental_chart_history(
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  dentition TEXT NOT NULL,
  tooth INTEGER NOT NULL,
  prev_state TEXT,
  new_state TEXT,
  notes TEXT NOT NULL DEFAULT '',
  visit_id TEXT,
  changed_at TEXT NOT NULL,
  changed_by TEXT
);
CREATE INDEX idx_chart_history ON dental_chart_history(patient_id, changed_at);

CREATE TABLE treatments(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  category TEXT NOT NULL DEFAULT 'General',
  description TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL DEFAULT 30,
  price_paisa INTEGER NOT NULL DEFAULT 0 CHECK (price_paisa >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  clinical_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_treatments_category ON treatments(category);

CREATE TABLE treatment_plans(
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','accepted','rejected','completed')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_plans_patient ON treatment_plans(patient_id);

CREATE TABLE treatment_plan_items(
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  treatment_id TEXT,
  name TEXT NOT NULL,
  tooth INTEGER,
  qty INTEGER NOT NULL CHECK (qty > 0),
  est_price_paisa INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','done','dropped')),
  visit_id TEXT,
  invoice_id TEXT
);
CREATE INDEX idx_plan_items ON treatment_plan_items(plan_id, seq);

CREATE TABLE appointments(
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  dentist_id TEXT,
  chair TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Consultation',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','confirmed','arrived','in_progress','completed','cancelled','no_show','rescheduled')),
  reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rescheduled_from TEXT
);
CREATE INDEX idx_appt_starts ON appointments(starts_at);
CREATE INDEX idx_appt_dentist ON appointments(dentist_id, starts_at);
CREATE INDEX idx_appt_patient ON appointments(patient_id, starts_at DESC);

CREATE TABLE queue_entries(
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  serial INTEGER NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  appointment_id TEXT,
  dentist_id TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','called','in_treatment','completed','skipped')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (day, serial)
);
CREATE INDEX idx_queue_day ON queue_entries(day, serial);

CREATE TABLE invoices(
  id TEXT PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  visit_id TEXT,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'final' CHECK (status IN ('draft','final','void')),
  subtotal_paisa INTEGER NOT NULL CHECK (subtotal_paisa >= 0),
  discount_paisa INTEGER NOT NULL DEFAULT 0 CHECK (discount_paisa >= 0),
  tax_bp INTEGER NOT NULL DEFAULT 0,
  tax_paisa INTEGER NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  total_paisa INTEGER NOT NULL CHECK (total_paisa >= 0),
  paid_paisa INTEGER NOT NULL DEFAULT 0 CHECK (paid_paisa >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  void_reason TEXT,
  voided_at TEXT,
  CHECK (total_paisa = subtotal_paisa - discount_paisa + tax_paisa)
);
CREATE INDEX idx_invoices_patient ON invoices(patient_id, date DESC);
CREATE INDEX idx_invoices_date ON invoices(date);
CREATE INDEX idx_invoices_status ON invoices(status);

CREATE TABLE invoice_items(
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL DEFAULT 'service' CHECK (item_type IN ('treatment','product','service','custom')),
  ref_id TEXT,
  description TEXT NOT NULL,
  tooth INTEGER,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_paisa INTEGER NOT NULL CHECK (unit_price_paisa >= 0),
  discount_paisa INTEGER NOT NULL DEFAULT 0 CHECK (discount_paisa >= 0),
  line_total_paisa INTEGER NOT NULL,
  CHECK (line_total_paisa = qty * unit_price_paisa - discount_paisa)
);
CREATE INDEX idx_invoice_items ON invoice_items(invoice_id);

CREATE TABLE payments(
  id TEXT PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  invoice_id TEXT REFERENCES invoices(id),
  date TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','bank','card','bkash','nagad','rocket','upay')),
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
  direction TEXT NOT NULL DEFAULT 'payment' CHECK (direction IN ('payment','refund')),
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT UNIQUE,
  original_payment_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  voided_at TEXT
);
CREATE INDEX idx_payments_patient ON payments(patient_id, date DESC);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);
CREATE INDEX idx_payments_date ON payments(date);

CREATE TABLE adjustments(
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  invoice_id TEXT REFERENCES invoices(id),
  amount_paisa INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_adjust_patient ON adjustments(patient_id);

CREATE TABLE expenses(
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
  method TEXT NOT NULL DEFAULT 'cash',
  vendor TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_expenses_date ON expenses(date);
CREATE INDEX idx_expenses_cat ON expenses(category);

CREATE TABLE suppliers(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE inventory_items(
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  unit TEXT NOT NULL DEFAULT 'pcs',
  supplier_id TEXT REFERENCES suppliers(id),
  purchase_price_paisa INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price_paisa >= 0),
  sale_price_paisa INTEGER NOT NULL DEFAULT 0 CHECK (sale_price_paisa >= 0),
  qty_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  reorder_level INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_items_name ON inventory_items(name);
CREATE INDEX idx_items_category ON inventory_items(category);

CREATE TABLE stock_movements(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  kind TEXT NOT NULL CHECK (kind IN ('purchase','sale','use','adjust','waste','return')),
  qty_delta INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  batch_no TEXT NOT NULL DEFAULT '',
  expiry_date TEXT,
  unit_cost_paisa INTEGER NOT NULL DEFAULT 0,
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  CHECK (qty_delta <> 0)
);
CREATE INDEX idx_move_item ON stock_movements(item_id, created_at DESC);
CREATE INDEX idx_move_expiry ON stock_movements(expiry_date);

CREATE TABLE purchases(
  id TEXT PRIMARY KEY,
  po_no TEXT NOT NULL UNIQUE,
  supplier_id TEXT REFERENCES suppliers(id),
  date TEXT NOT NULL,
  total_paisa INTEGER NOT NULL CHECK (total_paisa >= 0),
  paid_paisa INTEGER NOT NULL DEFAULT 0 CHECK (paid_paisa >= 0),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','draft')),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_purchases_date ON purchases(date);

CREATE TABLE purchase_items(
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_cost_paisa INTEGER NOT NULL CHECK (unit_cost_paisa >= 0),
  line_total_paisa INTEGER NOT NULL,
  batch_no TEXT NOT NULL DEFAULT '',
  expiry_date TEXT,
  CHECK (line_total_paisa = qty * unit_cost_paisa)
);
CREATE INDEX idx_purchase_items ON purchase_items(purchase_id);

CREATE TABLE notifications(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE UNIQUE INDEX idx_notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX idx_notifications_read ON notifications(read_at);

CREATE TABLE attachments(
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  visit_id TEXT,
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attach_patient ON attachments(patient_id);

CREATE TABLE backups(
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  app_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','failed')),
  note TEXT NOT NULL DEFAULT ''
);
`);
  },
};
