// Operations — expenses ledger (finance) and CSV import/export (admin-data).
import { api, hasRole, ApiError } from '../api';
import { h, mount, icon, toast, modal, field, readForm, dataTable, pagerStrip, badge, fmtDate, taka, PagedResult } from '../ui';

const METHODS = ['cash', 'bank', 'card', 'bkash', 'nagad', 'rocket', 'upay'];

// ---------------- expenses ----------------
interface ExpenseRow { id: string; date: string; category: string; amount_paisa: number; method: string; vendor: string; notes: string }

export async function expensesScreen(): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  const state = { page: 1, pageSize: 25, from: '', to: '' };
  const listHost = h('div');
  const fromInput = h('input', { type: 'date', class: 'search-input', style: 'max-width:170px' }) as HTMLInputElement;
  const toInput = h('input', { type: 'date', class: 'search-input', style: 'max-width:170px' }) as HTMLInputElement;
  fromInput.addEventListener('change', () => { state.from = fromInput.value; state.page = 1; void load(); });
  toInput.addEventListener('change', () => { state.to = toInput.value; state.page = 1; void load(); });

  async function load(): Promise<void> {
    const res = await api<PagedResult<ExpenseRow>>('expenses.list', { page: state.page, pageSize: state.pageSize, from: state.from || undefined, to: state.to || undefined });
    const sum = res.rows.reduce((a, r) => a + r.amount_paisa, 0);
    mount(listHost,
      dataTable<ExpenseRow>([
        { label: 'Date', render: (r) => fmtDate(r.date), width: '120px' },
        { label: 'Category', render: (r) => h('span', { class: 'primary-cell', text: r.category }) },
        { label: 'Vendor', render: (r) => r.vendor || '—' },
        { label: 'Method', render: (r) => badge('info', r.method) },
        { label: 'Notes', render: (r) => h('span', { class: 'muted', text: r.notes || '—' }) },
        { label: 'Amount', align: 'right', render: (r) => h('strong', { text: taka(r.amount_paisa) }) },
        {
          label: '', align: 'right', render: (r) => hasRole('admin') ? h('div', { class: 'btn-row end' },
            h('button', { class: 'btn-link', onclick: () => openExpense(r) }, 'Edit'),
            h('button', {
              class: 'btn-link danger', onclick: async () => {
                await api('expenses.delete', { id: r.id }); toast('ok', 'Expense removed'); await load();
              },
            }, 'Delete')) : '',
        },
      ], res.rows, { empty: 'No expenses recorded' }),
      pagerStrip(res, (p) => { state.page = p; void load(); }),
      h('div', { class: 'btn-row end muted', text: `Page total: ${taka(sum)}` }));
  }

  function openExpense(r?: ExpenseRow): void {
    modal(r ? 'Edit expense' : 'Record expense', (close) => {
      const form = h('div', { class: 'form-grid' },
        field({ name: 'category', label: 'Category', required: true, placeholder: 'e.g. Rent, Utilities, Lab fee, Materials', value: r?.category ?? '' }),
        field({ name: 'amount', label: 'Amount (Tk)', type: 'number', required: true, min: 0, value: r ? (r.amount_paisa / 100).toFixed(2) : '' }),
        field({ name: 'date', label: 'Date', type: 'date', value: r?.date ?? new Date().toISOString().slice(0, 10) }),
        field({ name: 'method', label: 'Paid via', type: 'select', value: r?.method ?? 'cash', options: METHODS }),
        field({ name: 'vendor', label: 'Vendor / payee', value: r?.vendor ?? '' }),
        field({ name: 'notes', label: 'Notes', value: r?.notes ?? '' }),
      );
      const err2 = h('div', { class: 'login-err' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            err2.textContent = '';
            const v = readForm(form);
            const tk = Number(v.amount);
            if (!String(v.category ?? '').trim()) { err2.textContent = 'Category required'; return; }
            if (!(tk > 0)) { err2.textContent = 'Amount must be positive'; return; }
            const payload = {
              category: String(v.category).trim(), amountPaisa: Math.round(tk * 100),
              date: v.date ? String(v.date) : undefined,
              method: String(v.method ?? 'cash'), vendor: String(v.vendor ?? ''), notes: String(v.notes ?? ''),
            };
            try {
              if (r) await api('expenses.update', { ...payload, id: r.id });
              else await api('expenses.create', payload);
              toast('ok', 'Saved'); close(); await load();
            } catch (e) { err2.textContent = (e as ApiError).message; }
          },
        }, 'Save'));
      return h('div', {}, form, err2, row);
    });
  }

  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Expenses' }), h('p', { class: 'muted', text: 'Clinic overheads & supplier payments' })),
      hasRole('admin') ? h('button', { class: 'btn btn-primary', onclick: () => openExpense() }, h('span', {}, icon('add')), 'Record expense') : ''),
    h('div', { class: 'btn-row align-center' }, h('span', { class: 'muted', text: 'From' }), fromInput, h('span', { class: 'muted', text: 'To' }), toInput),
    listHost,
  );
  await load();
  return root;
}

// ---------------- import / export ----------------
const EXPORT_ENTITIES = [
  { value: 'patients', label: 'Patients' },
  { value: 'invoices', label: 'Invoices' },
  { value: 'payments', label: 'Payments' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'appointments', label: 'Appointments' },
  { value: 'visits', label: 'Visits' },
];

export async function dataScreen(): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });

  // --- export card ---
  const expForm = h('div', { class: 'form-grid' },
    field({ name: 'entity', label: 'Data to export', type: 'select', options: EXPORT_ENTITIES }),
    field({ name: 'from', label: 'From (optional)', type: 'date' }),
    field({ name: 'to', label: 'To (optional)', type: 'date' }),
  );
  const expOut = h('div', { class: 'muted' });
  const exportCard = h('section', { class: 'card' },
    h('div', { class: 'card-title' }, h('h3', { text: 'Export to CSV' })),
    expForm,
    expOut,
    h('div', { class: 'btn-row end' },
      h('button', {
        class: 'btn btn-primary', onclick: async () => {
          const v = readForm(expForm);
          try {
            const r = await api<{ csv: string; rows: number }>('export.run', { entity: String(v.entity), from: v.from ? String(v.from) : undefined, to: v.to ? String(v.to) : undefined });
            const blob = new Blob([`﻿${r.csv}`], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `dentiva-${v.entity}-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            expOut.textContent = `Exported ${r.rows} rows.`;
          } catch (e) { toast('err', (e as Error).message); }
        },
      }, h('span', {}, icon('download')), 'Download CSV')),
  );

  // --- import card ---
  const impState = { entity: 'patients', csvText: '', mapping: {} as Record<string, string>, dryOk: false };
  const fileName = h('span', { class: 'muted', text: 'No file chosen' });
  const impBody = h('div', { class: 'col-gap' });
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = '.csv'; fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    impState.csvText = await f.text();
    fileName.textContent = `${f.name} (${(f.size / 1024).toFixed(0)} KB)`;
    void autoMapAndDryRun();
  });
  const impEntity = h('select', { class: 'search-input', style: 'max-width:220px' },
    ...[{ value: 'patients', label: 'Patients' }, { value: 'inventory', label: 'Inventory items' }]
      .map((o) => { const el = document.createElement('option'); el.value = o.value; el.textContent = o.label; return el; }));
  impEntity.addEventListener('change', () => { impState.entity = impEntity.value; if (impState.csvText) void autoMapAndDryRun(); });

  async function autoMapAndDryRun(): Promise<void> {
    mount(impBody, h('div', { class: 'screen-loading', text: 'Validating (dry run)…' }));
    try {
      const firstLine = impState.csvText.split(/\r?\n/, 1)[0] ?? '';
      const headers = parseCsvLine(firstLine);
      const fields = impState.entity === 'patients'
        ? ['name', 'phone', 'altPhone', 'email', 'dob', 'gender', 'address', 'occupation', 'notes']
        : ['sku', 'name', 'category', 'unit', 'purchasePricePaisa', 'salePricePaisa', 'reorderLevel', 'notes'];
      const mapping: Record<string, string> = {};
      for (const hName of headers) {
        const norm = hName.trim().toLowerCase().replace(/[^a-z]/g, '');
        const hit = fields.find((fd) => fd.toLowerCase() === norm || fd.toLowerCase().includes(norm) || norm.includes(fd.toLowerCase()));
        if (hit) mapping[hName.trim()] = hit;
      }
      impState.mapping = mapping;
      const dry = await api<{ dryRun: boolean; totalRows: number; valid: number; errors: { row: number; message: string }[]; duplicates: { row: number; matched: string }[] }>(
        'import.run', { entity: impState.entity, csv: impState.csvText, mapping, dryRun: true });
      const mapTable = h('table', { class: 'tbl' },
        h('tbody', {},
          ...Object.entries(mapping).length
            ? Object.entries(mapping).map(([csv, f]) => h('tr', {}, h('td', { class: 'mono', text: csv }), h('td', { text: `→ ${f}` })))
            : [h('tr', {}, h('td', { text: 'No headers could be auto-mapped — expected headers like name/phone/email (patients) or sku/name/unit (items).' }))]));
      mount(impBody,
        h('h4', { text: 'Column mapping (auto)' }), mapTable,
        h('div', { class: dry.errors.length ? 'warn-text' : 'muted', text: `${dry.totalRows} data rows · ${dry.valid} valid${dry.duplicates.length ? ` · ${dry.duplicates.length} duplicates` : ''}${dry.errors.length ? ` · ${dry.errors.length} errors` : ''}` }),
        ...dry.errors.slice(0, 5).map((e) => h('div', { class: 'muted small', text: `Row ${e.row}: ${e.message}` })),
      );
      impState.dryOk = dry.errors.length === 0 && dry.valid > 0;
    } catch (e) {
      mount(impBody, h('div', { class: 'warn-text', text: (e as Error).message }));
      impState.dryOk = false;
    }
  }
  function parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  const importCard = h('section', { class: 'card' },
    h('div', { class: 'card-title' }, h('h3', { text: 'Import from CSV' })),
    h('p', { class: 'muted', text: 'Duplicate-safe: exact phone matches are reported, never re-inserted. A dry run always happens first.' }),
    h('div', { class: 'btn-row align-center' }, h('span', { class: 'muted', text: 'Data type' }), impEntity,
      h('button', { class: 'btn', onclick: () => fileInput.click() }, h('span', {}, icon('upload')), 'Choose CSV…'), fileName,
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-primary', onclick: async () => {
          if (!impState.dryOk) { toast('err', 'Run a clean dry-run first'); return; }
          try {
            const r = await api<{ inserted: number; skipped: number }>('import.run', { entity: impState.entity, csv: impState.csvText, mapping: impState.mapping, mode: 'skip', dryRun: false });
            toast('ok', `Imported ${r.inserted} rows (${r.skipped} skipped)`);
          } catch (e) { toast('err', (e as Error).message); }
        },
      }, 'Run import')),
    impBody,
  );

  root.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Import & Export' }), h('p', { class: 'muted', text: 'CSV in/out — no cloud involved' }))),
    exportCard, importCard,
  );
  return root;
}
