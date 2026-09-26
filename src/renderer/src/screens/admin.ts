// Administration — settings, staff, backup/restore, audit log, treatment catalog, reports.
import { api, hasRole, ApiError, currentUser } from '../api';
import { h, mount, icon, toast, modal, field, readForm, dataTable, pagerStrip, badge, fmtDate, taka, confirmDialog, PagedResult } from '../ui';
import { navigate } from '../app';

// ---------------- settings ----------------
export async function settingsScreen(): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  const s = await api<Record<string, unknown>>('settings.get');
  const form = h('form', { class: 'form-grid wide' });
  form.append(
    field({ name: 'clinicName', label: 'Clinic name', required: true, value: s.clinicName }),
    field({ name: 'dentistName', label: 'Lead dentist display name', value: s.dentistName }),
    field({ name: 'dentistDegrees', label: 'Degrees (printed on documents)', value: s.dentistDegrees }),
    field({ name: 'phone', label: 'Phone', value: s.phone }),
    field({ name: 'email', label: 'Email', type: 'email', value: s.email }),
    field({ name: 'address', label: 'Address', type: 'textarea', rows: 3, value: s.address }),
    field({ name: 'website', label: 'Website', value: s.website }),
    field({ name: 'tagline', label: 'Tagline', value: s.tagline }),
    field({ name: 'registrationNo', label: 'Registration no.', value: s.registrationNo }),
    field({ name: 'invoicePrefix', label: 'Invoice prefix', value: s.invoicePrefix }),
    field({ name: 'taxLabel', label: 'Tax label on documents', value: s.taxLabel }),
    field({ name: 'paperSize', label: 'Print paper size', type: 'select', options: [{ value: 'A4', label: 'A4' }, { value: 'A5', label: 'A5' }, { value: 'letter', label: 'Letter' }], value: s.paperSize }),
    field({ name: 'appointmentDurationMin', label: 'Default appointment length (min)', type: 'number', value: s.appointmentDurationMin, min: 5, max: 480 }),
    field({ name: 'sessionTimeoutMin', label: 'Session timeout (minutes)', type: 'number', value: s.sessionTimeoutMin, min: 5, max: 480 }),
    field({ name: 'autoBackupEnabled', label: '', type: 'checkbox', placeholder: 'Auto-backup before closing the app', value: s.autoBackupEnabled }),
  );
  const rows = h('div', { class: 'col-gap' },
    h('p', { class: 'muted', text: 'All financial figures are stored in paisa (integer). Currency stays BDT (৳). Timezone: Asia/Dhaka. This is permanent by policy — backups keep full fidelity regardless of settings.' }),
  );
  const err2 = h('div', { class: 'login-err' });
  const saveRow = h('div', { class: 'btn-row end' },
    h('button', {
      class: 'btn btn-primary', type: 'button', onclick: async () => {
        err2.textContent = '';
        const v = readForm(form);
        if (!String(v.clinicName ?? '').trim()) { err2.textContent = 'Clinic name is required'; return; }
        try {
          await api('settings.update', {
            ...s,
            clinicName: String(v.clinicName).trim(),
            dentistName: String(v.dentistName ?? ''), dentistDegrees: String(v.dentistDegrees ?? ''),
            phone: String(v.phone ?? ''), email: String(v.email ?? ''), address: String(v.address ?? ''),
            website: String(v.website ?? ''), invoicePrefix: String(v.invoicePrefix ?? 'INV'),
            taxLabel: String(v.taxLabel ?? 'Tax'),
            tagline: String(v.tagline ?? ''), registrationNo: String(v.registrationNo ?? ''),
            paperSize: (['A4', 'A5', 'letter'].includes(String(v.paperSize ?? 'A4')) ? String(v.paperSize) : 'A4'),
            appointmentDurationMin: Number(v.appointmentDurationMin ?? 30),
            sessionTimeoutMin: Number(v.sessionTimeoutMin ?? 30),
            autoBackupEnabled: Boolean(v.autoBackupEnabled),
          });
          toast('ok', 'Settings saved');
        } catch (e) { err2.textContent = (e as ApiError).message; }
      },
    }, 'Save settings'));

  root.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Clinic Settings' }), h('p', { class: 'muted', text: 'Used on printed documents and receipts' }))),
    h('section', { class: 'card' }, form, rows, err2, saveRow),
  );
  return root;
}

// ---------------- users ----------------
interface UserRow { id: string; username: string; display_name: string; role: string; active: number; last_login_at: string | null; locked_until: string | null }

export async function usersScreen(): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  const listHost = h('div');
  async function load(): Promise<void> {
    const rows = await api<UserRow[]>('users.list');
    mount(listHost, dataTable<UserRow>([
      { label: 'Username', render: (r) => h('span', { class: 'mono', text: r.username }), width: '150px' },
      { label: 'Display name', render: (r) => h('span', { class: 'primary-cell', text: r.display_name }) },
      {
        label: 'Role', width: '140px', render: (r) =>
          badge(r.role === 'admin' ? 'warn' : r.role === 'dentist' ? 'info' : 'muted', r.role === 'admin' ? 'Administrator' : r.role === 'dentist' ? 'Dentist' : 'Staff'),
      },
      { label: 'Status', width: '120px', render: (r) => (r.locked_until && new Date(r.locked_until) > new Date()) ? badge('err', 'locked') : r.active ? badge('ok', 'active') : badge('muted', 'disabled') },
      { label: 'Last sign-in', render: (r) => r.last_login_at ? fmtDate(r.last_login_at, true) : 'Never' },
      {
        label: '', align: 'right', render: (r) => h('div', { class: 'btn-row end' },
          h('button', { class: 'btn-link', onclick: () => openEditUser(r) }, 'Edit'),
          h('button', { class: 'btn-link', onclick: () => openResetPassword(r) }, 'Reset password')),
      },
    ], rows, { empty: 'No staff accounts' }));
  }
  function openNewUser(): void {
    modal('New staff account', (close) => {
      const form = h('div', { class: 'form-grid' },
        field({ name: 'username', label: 'Username', required: true }),
        field({ name: 'displayName', label: 'Display name', required: true }),
        field({ name: 'role', label: 'Role', type: 'select', options: [{ value: 'staff', label: 'Staff (front desk)' }, { value: 'dentist', label: 'Dentist' }, { value: 'admin', label: 'Administrator' }] }),
        field({ name: 'password', label: 'Temporary password (min 8)', type: 'password', required: true }),
        field({ name: 'confirm', label: 'Repeat password', type: 'password', required: true }),
      );
      const err2 = h('div', { class: 'login-err' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            err2.textContent = '';
            const v = readForm(form);
            if (v.password !== v.confirm) { err2.textContent = 'Passwords do not match'; return; }
            try {
              await api('users.create', {
                username: String(v.username ?? ''), displayName: String(v.displayName ?? ''),
                role: String(v.role ?? 'staff'), password: String(v.password), active: true,
              });
              toast('ok', 'Account created'); close(); await load();
            } catch (e) { err2.textContent = (e as ApiError).message; }
          },
        }, 'Create account'));
      return h('div', {}, form, err2, row);
    });
  }
  function openEditUser(r: UserRow): void {
    modal(`Edit ${r.display_name}`, (close) => {
      const form = h('div', { class: 'form-grid' },
        field({ name: 'displayName', label: 'Display name', value: r.display_name, required: true }),
        field({ name: 'role', label: 'Role', type: 'select', value: r.role, options: [{ value: 'staff', label: 'Staff (front desk)' }, { value: 'dentist', label: 'Dentist' }, { value: 'admin', label: 'Administrator' }] }),
        field({ name: 'active', label: '', type: 'checkbox', placeholder: 'Account active (can sign in)', value: !!r.active }),
      );
      const err2 = h('div', { class: 'login-err' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            const v = readForm(form);
            try {
              await api('users.update', { id: r.id, displayName: String(v.displayName), role: String(v.role), active: Boolean(v.active) });
              toast('ok', 'Saved'); close(); await load();
            } catch (e) { err2.textContent = (e as ApiError).message; }
          },
        }, 'Save'));
      return h('div', {}, form, err2, row);
    });
  }
  function openResetPassword(r: UserRow): void {
    modal(`Reset password — ${r.display_name}`, (close) => {
      const form = h('div', { class: 'col-gap' },
        field({ name: 'password', label: 'New password (min 8)', type: 'password' }),
        field({ name: 'confirm', label: 'Repeat password', type: 'password' }),
      );
      const err2 = h('div', { class: 'login-err' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            const v = readForm(form);
            if (v.password !== v.confirm) { err2.textContent = 'Passwords do not match'; return; }
            try {
              await api('users.resetPassword', { id: r.id, newPassword: String(v.password) });
              toast('ok', 'Password reset'); close();
            } catch (e) { err2.textContent = (e as ApiError).message; }
          },
        }, 'Reset'));
      return h('div', {}, form, err2, row);
    });
  }
  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Staff & Permissions' }), h('p', { class: 'muted', text: 'Three roles: Administrator, Dentist, Staff' })),
      h('button', { class: 'btn btn-primary', onclick: openNewUser }, h('span', {}, icon('add')), 'New account')),
    listHost,
  );
  await load();
  return root;
}

// ---------------- backup / restore ----------------
interface BackupRow { id: string; file_name: string; created_at: string; size_bytes: number | null; created_by: string | null; kind: string }

export async function backupScreen(): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  const listHost = h('div');
  const restoreHost = h('div');
  async function load(): Promise<void> {
    const rows = await api<BackupRow[]>('backup.history');
    mount(listHost, dataTable<BackupRow>([
      { label: 'File', render: (r) => h('span', { class: 'mono', text: r.file_name }) },
      { label: 'Kind', render: (r) => badge(r.kind === 'auto' ? 'info' : 'ok', r.kind), width: '100px' },
      { label: 'Created', render: (r) => fmtDate(r.created_at, true), width: '170px' },
      { label: 'Size', align: 'right', render: (r) => r.size_bytes ? `${(r.size_bytes / 1024).toFixed(0)} KB` : '—', width: '90px' },
      { label: 'By', render: (r) => r.created_by ?? 'system', width: '120px' },
    ], rows ?? [], { empty: 'No backups yet' }));
  }
  function openBackup(): void {
    void (async () => {
      try {
        toast('warn', 'Creating backup…');
        const r = await api<{ path: string; size: number }>('backup.run', { note: '' });
        toast('ok', `Backup created (${(r.size / 1024).toFixed(0)} KB)`);
        await load();
      } catch (e) { toast('err', (e as Error).message); }
    })();
  }
  function openRestore(): void {
    modal('Restore from backup', (close) => {
      const form = h('div', { class: 'col-gap' },
        h('p', { class: 'warn-text', text: 'Restore replaces the current database with the backup file contents. A safety copy of the current state is made automatically.' }),
        h('button', {
          class: 'btn', onclick: async () => {
            try {
              const picked = await api<{ path: string | null }>('system.pickFile', { kind: 'backup' });
              if (!picked.path) return;
              (form.querySelector('[data-picked]') as HTMLElement).textContent = picked.path;
              (form.querySelector('[data-restore]') as HTMLElement).dataset.path = picked.path;
              const info = await api<{ dbSize: number; schemaVersion: number; appVersion: string }>('restore.validate', { filePath: picked.path }).catch((e) => ({ dbSize: -1, schemaVersion: -1, appVersion: (e as Error).message }));
              (form.querySelector('[data-validate]') as HTMLElement).textContent = info.dbSize >= 0
                ? `✔ Valid backup — app ${info.appVersion}, schema v${info.schemaVersion}, database ${(info.dbSize / 1024).toFixed(0)} KB`
                : `✘ ${info.appVersion}`;
            } catch (e) { toast('err', (e as Error).message); }
          },
        }, 'Choose backup file…'),
        h('div', { class: 'muted mono-wrap', 'data-picked': 'true' }),
        h('div', { class: 'muted', 'data-validate': 'true' }),
      );
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-danger', 'data-restore': 'true', onclick: async () => {
            const path = (form.querySelector('[data-restore]') as HTMLElement).dataset.path;
            if (!path) { toast('err', 'Choose a valid backup file first'); return; }
            const sure = await confirmDialog('Restore database', 'The current data will be replaced by the chosen backup. Continue?', 'Restore now');
            if (!sure) return;
            try {
              await api('restore.run', { filePath: path });
              toast('ok', 'Restored — the app will now reload');
              setTimeout(() => location.reload(), 1200);
            } catch (e) { toast('err', (e as Error).message); }
          },
        }, 'Restore'));
      return h('div', {}, form, row);
    });
  }
  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Backup & Restore' }), h('p', { class: 'muted', text: 'Zip archives with manifest + SHA256 checksum' })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: openRestore }, 'Restore…'),
        h('button', { class: 'btn btn-primary', onclick: openBackup }, h('span', {}, icon('backup')), 'Back up now'))),
    listHost, restoreHost,
  );
  await load();
  return root;
}

// ---------------- audit ----------------
interface AuditRow { id: string; at: string; username: string; action: string; entity: string; entity_id: string; details: string }

export async function auditScreen(): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  const state = { page: 1, pageSize: 50 };
  const listHost = h('div');
  async function load(): Promise<void> {
    const res = await api<PagedResult<AuditRow>>('audit.list', { page: state.page, pageSize: state.pageSize });
    mount(listHost,
      dataTable<AuditRow>([
        { label: 'When', render: (r) => fmtDate(r.at, true), width: '170px' },
        { label: 'User', render: (r) => h('span', { class: 'mono', text: r.username }), width: '120px' },
        { label: 'Action', render: (r) => badge(r.action.startsWith('auth') ? 'info' : r.action.includes('delete') || r.action.includes('void') ? 'err' : 'muted', r.action), width: '170px' },
        { label: 'Target', render: (r) => `${r.entity}${r.entity_id ? ' · ' + r.entity_id.slice(0, 8) : ''}` },
        { label: 'Details', render: (r) => h('span', { class: 'muted small mono-wrap', text: r.details ?? '' }) },
      ], res.rows, { empty: 'No audit activity yet' }),
      pagerStrip(res, (p) => { state.page = p; void load(); }));
  }
  root.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Audit Log' }), h('p', { class: 'muted', text: 'Every mutation, attributed, newest first' }))), listHost);
  await load();
  return root;
}

// ---------------- treatment catalog ----------------
interface TxRow { id: string; name: string; category: string; price_paisa: number; duration_min: number; active: number }

export async function treatmentsScreen(): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  const state = { page: 1, pageSize: 25, q: '' };
  const search = h('input', { class: 'search-input', placeholder: 'Search treatments…' });
  let t = 0;
  search.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(() => { state.q = search.value.trim(); state.page = 1; void load(); }, 220); });
  const listHost = h('div');
  async function load(): Promise<void> {
    const res = await api<PagedResult<TxRow>>('treatments.list', { page: state.page, pageSize: state.pageSize, q: state.q, category: '', includeInactive: true });
    mount(listHost,
      dataTable<TxRow>([
        { label: 'Name', render: (r) => h('span', { class: 'primary-cell', text: r.name }) },
        { label: 'Category', render: (r) => r.category || 'General', width: '140px' },
        { label: 'Duration', align: 'right', render: (r) => `${r.duration_min} min`, width: '100px' },
        { label: 'Price', align: 'right', render: (r) => taka(r.price_paisa) },
        { label: 'Status', width: '100px', render: (r) => r.active ? badge('ok', 'active') : badge('muted', 'inactive') },
        { label: '', align: 'right', render: (r) => h('button', { class: 'btn-link', onclick: () => openTx(r) }, 'Edit') },
      ], res.rows, { empty: 'No treatments in the catalog' }),
      pagerStrip(res, (p) => { state.page = p; void load(); }));
  }
  function openTx(r?: TxRow): void {
    modal(r ? `Edit ${r.name}` : 'New treatment', (close) => {
      const form = h('div', { class: 'form-grid' },
        field({ name: 'name', label: 'Name', value: r?.name ?? '', required: true }),
        field({ name: 'category', label: 'Category', value: r?.category ?? 'General' }),
        field({ name: 'durationMin', label: 'Duration (min)', type: 'number', value: r?.duration_min ?? 30, min: 0, max: 600 }),
        field({ name: 'price', label: 'Price (Tk)', type: 'number', value: r ? (r.price_paisa / 100).toFixed(2) : 0, min: 0 }),
        field({ name: 'active', label: '', type: 'checkbox', placeholder: 'Active (available for booking/billing)', value: r ? !!r.active : true }),
      );
      const err2 = h('div', { class: 'login-err' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            const v = readForm(form);
            if (!String(v.name ?? '').trim()) { err2.textContent = 'Name required'; return; }
            try {
              const priceTk = Number(v.price ?? 0);
              const payload = { name: String(v.name), category: String(v.category ?? 'General'), durationMin: Number(v.durationMin ?? 30), pricePaisa: Math.round((Number.isFinite(priceTk) ? priceTk : 0) * 100), active: Boolean(v.active), description: '', clinicalNotes: '' };
              if (r) await api('treatments.update', { id: r.id, ...payload });
              else await api('treatments.create', payload);
              toast('ok', 'Saved'); close(); await load();
            } catch (e) { err2.textContent = (e as ApiError).message; }
          },
        }, 'Save'));
      return h('div', {}, form, err2, row);
    });
  }
  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Treatment Catalog' }), h('p', { class: 'muted', text: 'Services and their standard fees' })),
      h('button', { class: 'btn btn-primary', onclick: () => openTx() }, h('span', {}, icon('add')), 'New treatment')),
    search, listHost);
  await load();
  return root;
}

// ---------------- reports ----------------
const REPORTS: { id: string; label: string; desc: string }[] = [
  { id: 'daily_collections', label: 'Daily collections', desc: 'Cash taken per day' },
  { id: 'revenue_summary', label: 'Revenue summary', desc: 'Period totals with averages' },
  { id: 'payments_by_method', label: 'Collections by method', desc: 'cash / bKash / cards per day' },
  { id: 'outstanding_balances', label: 'Outstanding list', desc: 'Unpaid & part-paid invoices' },
  { id: 'treatment_activity', label: 'Treatment activity', desc: 'Services performed & billed' },
  { id: 'appointments_summary', label: 'Appointments summary', desc: 'Bookings, completion & no-shows' },
  { id: 'patient_growth', label: 'Patient growth', desc: 'Registrations over time' },
  { id: 'dentist_activity', label: 'Dentist activity', desc: 'Production by clinician' },
  { id: 'inventory_valuation', label: 'Inventory valuation', desc: 'Stock value on hand' },
  { id: 'low_stock', label: 'Low stock report', desc: 'Below reorder level' },
  { id: 'expiry_report', label: 'Expiry report', desc: 'Lots nearing expiry' },
  { id: 'expense_summary', label: 'Expense summary', desc: 'Overheads by category' },
];

export async function reportsScreen(): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  const cards = REPORTS.map((r) => h('button', {
    class: 'report-card', onclick: () => void runReport(r),
  }, h('div', { class: 'report-title', text: r.label }), h('div', { class: 'muted', text: r.desc })));

  const host = h('div', { class: 'card-host' });
  async function runReport(r: { id: string; label: string }): Promise<void> {
    modal(`${r.label}`, (close) => {
      const form = h('div', { class: 'form-grid' },
        field({ name: 'from', label: 'From', type: 'date', value: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10) }),
        field({ name: 'to', label: 'To', type: 'date', value: new Date().toISOString().slice(0, 10) }),
      );
      const out = h('div', { class: 'report-out' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Close'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            const v = readForm(form);
            mount(out, h('div', { class: 'screen-loading', text: 'Running…' }));
            try {
              const result = await api<{ columns: string[]; rows: Record<string, unknown>[] }>('reports.run', { kind: r.id, from: String(v.from), to: String(v.to) });
              if (!result.rows?.length) {
                mount(out, h('div', { class: 'empty-title', text: 'No data in that range' }));
                return;
              }
              const cols = result.columns ?? Object.keys(result.rows[0]!);
              mount(out, dataTable(
                cols.map((c) => ({
                  label: c.replace(/_/g, ' '),
                  render: (row: Record<string, unknown>) => typeof row[c] === 'number' && /paisa/i.test(c) ? taka(row[c] as number) : String(row[c] ?? '—'),
                  align: /paisa|qty|count|total/i.test(c) ? ('right' as const) : ('left' as const),
                })),
                result.rows.slice(0, 200),
              ), h('div', { class: 'btn-row end' },
                h('button', {
                  class: 'btn', onclick: async () => {
                    const csv = [cols.join(','), ...result.rows.map((rr) => cols.map((c) => JSON.stringify(rr[c] ?? '')).join(','))].join('\n');
                    void csv;
                    toast('ok', 'Use Export from documents to save this report');
                  },
                }, 'Export')));
            } catch (e) {
              mount(out, h('div', { class: 'empty-title', text: (e as Error).message }));
            }
          },
        }, 'Run report'));
      return h('div', { class: 'col-gap' }, form, out, row);
    }, { wide: true });
  }
  root.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Reports' }), h('p', { class: 'muted', text: 'Choose a report to run' }))),
    h('div', { class: 'reports-grid' }, ...cards),
    host,
  );
  return root;
}

// safe re-export to keep currentUser referenced (role-aware menus elsewhere)
export { currentUser };
