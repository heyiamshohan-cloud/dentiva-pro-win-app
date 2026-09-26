// Patients — registry with real server-side search/pagination, registration with duplicate
// intervention, archive flow. No local filtering of already-truncated lists anywhere.
import { api, ApiError } from '../api';
import { h, mount, icon, toast, modal, field, readForm, dataTable, pagerStrip, badge, fmtDate, PagedResult, confirmDialog } from '../ui';
import { navigate } from '../app';

interface PatientRow {
  id: string; code: string; name: string; phone: string; email: string;
  dob: string | null; gender: string | null; address: string;
  created_at: string; tags: string[];
}
interface PatientPage extends PagedResult<PatientRow> { }

const GENDERS = ['Male', 'Female', 'Other'] as const;

export async function patientsScreen(q: URLSearchParams): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  const state = { page: 1, pageSize: 25, q: '', archived: false };

  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h1', { text: 'Patients' }), h('p', { class: 'muted', text: 'Registered patient registry' })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => { state.archived = !state.archived; state.page = 1; void load(); } }, 'Archived'),
      h('button', { class: 'btn btn-primary', onclick: openCreate }, h('span', {}, icon('add')), 'New patient'),
    ));

  const search = h('input', { class: 'search-input', placeholder: 'Search name, code, phone, or email…', value: state.q });
  let timer = 0;
  search.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { state.q = search.value.trim(); state.page = 1; void load(); }, 220);
  });

  const listHost = h('div', { class: 'card-host' }, h('div', { class: 'screen-loading', text: 'Loading patients…' }));

  async function load(): Promise<void> {
    try {
      const res = await api<PatientPage>('patients.list', { page: state.page, pageSize: state.pageSize, q: state.q, archived: state.archived, tag: '', sortBy: 'created_at', sortDir: 'desc' });
      const tbl = dataTable<PatientRow>([
        { label: 'Code', render: (r) => h('span', { class: 'mono', text: r.code }), width: '110px' },
        { label: 'Name', render: (r) => h('span', { class: 'primary-cell', text: r.name }) },
        { label: 'Phone', render: (r) => r.phone || '—' },
        { label: 'Gender / Age', render: (r) => `${r.gender ?? '—'}${r.dob ? ` · ${ageOf(r.dob)}` : ''}` },
        { label: 'Tags', render: (r) => (r.tags ?? []).slice(0, 3).join(', ') || '—' },
        { label: 'Registered', render: (r) => fmtDate(r.created_at), width: '120px' },
      ], res.rows, { empty: state.q ? `No patients match “${state.q}”` : 'No patients registered yet', onRow: (r) => navigate(`/patient?id=${r.id}`) });
      mount(listHost, tbl, pagerStrip(res, (p) => { state.page = p; void load(); }));
    } catch (e) {
      mount(listHost, h('div', { class: 'empty-title', text: (e as Error).message }));
    }
  }

  function openCreate(): void {
    modal('Register new patient', (close) => {
      const form = h('form', { class: 'form-grid' });
      form.append(
        field({ name: 'title', label: 'Title (Mr/Ms/Dr…)', value: '' }),
        field({ name: 'bloodGroup', label: 'Blood group', value: '' }),
        field({ name: 'name', label: 'Full name', required: true }),
        field({ name: 'phone', label: 'Phone', required: true, placeholder: '01XXXXXXXXX' }),
        field({ name: 'altPhone', label: 'Alternative phone', value: '' }),
        field({ name: 'email', label: 'Email', type: 'email', value: '' }),
        field({ name: 'dob', label: 'Date of birth', type: 'date', value: '' }),
        field({ name: 'gender', label: 'Gender', type: 'select', options: [{ value: '', label: 'Prefer not to say' }, ...GENDERS] } /* fine */),
        field({ name: 'bloodGroup', label: 'Blood group', value: '' }),
        field({ name: 'address', label: 'Address', type: 'textarea', rows: 2, value: '' }),
        field({ name: 'occupation', label: 'Occupation', value: '' }),
        field({ name: 'emergencyContactName', label: 'Emergency contact name', value: '' }),
        field({ name: 'referralSource', label: 'Referred by', value: '' }),
      );
      const err2 = h('div', { class: 'login-err' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', type: 'button', onclick: async () => {
            err2.textContent = '';
            const v = readForm(form);
            if (!String(v.name ?? '').trim()) { err2.textContent = 'Full name is required'; return; }
            if (!String(v.phone ?? '').trim()) { err2.textContent = 'Phone is required'; return; }
            const payload = {
              title: String(v.title ?? ''), name: String(v.name).trim(), phone: String(v.phone).trim(),
              altPhone: String(v.altPhone ?? ''), email: String(v.email ?? ''),
              dob: v.dob ? String(v.dob) : null, gender: v.gender || null,
              bloodGroup: String(v.bloodGroup ?? ''), address: String(v.address ?? ''),
              occupation: String(v.occupation ?? ''), emergencyContactName: String(v.emergencyContactName ?? ''),
              referralSource: String(v.referralSource ?? ''),
            };
            // duplicate pre-check: the service enforces this too — we present the conflict clearly.
            try {
              const list = await api<{ id: string; code: string; name: string; phone: string; matchKind?: string }[]>('patients.duplicates', { name: payload.name, phone: payload.phone, email: payload.email, dob: payload.dob ?? '' });
              if (list.length) {
                const exists = list.map((d) => `${d.code} ${d.name} (${d.phone})`).join(', ');
                const go = await confirmDialog('Possible duplicate', `Possible existing match: ${exists}. Register anyway?`, 'Register anyway', false);
                if (!go) return;
              }
            } catch { /* proceed; service will reject hard duplicates */ }
            try {
              const created = await api<{ id: string }>('patients.create', payload);
              toast('ok', 'Patient registered');
              close();
              navigate(`/patient?id=${created.id}`);
            } catch (e) {
              err2.textContent = (e as ApiError).message;
            }
          },
        }, 'Save patient'),
      );
      return h('div', {}, form, err2, row);
    }, { wide: true });
  }

  root.append(head, search, listHost);
  if (q.get('new') === '1') setTimeout(openCreate, 50);
  await load();
  return root;
}

export function ageOf(dob: string): string {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  let yrs = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) yrs--;
  return `${yrs}y`;
}

