// Patient 360 — tabbed clinical & financial record. Tabs load lazily per channel call.
import { api, hasRole, ApiError } from '../api';
import { h, mount, icon, toast, modal, field, readForm, dataTable, pagerStrip, badge, fmtDate, taka, confirmDialog, El } from '../ui';
import { navigate } from '../app';
import { ageOf } from './patients';

interface PatientRow {
  id: string; code: string; name: string; phone: string; email: string; dob: string | null;
  gender: string | null; blood_group: string; address: string; occupation: string;
  emergency_contact_name: string; referral_source: string; notes: string; tags: string[];
  created_at: string; archived_at: string | null;
}

interface Overview {
  patient: PatientRow;
  counts: { visits: number; prescriptions: number; invoices: number; payments: number; appointments: number; attachments: number; activePlans: number };
  outstandingPaisa: number;
  lastVisitAt: string | null;
  nextAppointmentAt: string | null;
  alerts: { kind: string; value: string }[];
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'visits', label: 'Visits' },
  { id: 'chart', label: 'Dental chart' },
  { id: 'prescriptions', label: 'Prescriptions' },
  { id: 'billing', label: 'Billing' },
  { id: 'files', label: 'Attachments' },
  { id: 'timeline', label: 'Timeline' },
];

export async function patientScreen(q: URLSearchParams): Promise<HTMLElement> {
  const id = q.get('id')!;
  const initialTab = q.get('tab') ?? 'overview';
  const root = h('div', { class: 'screen' });
  const patient = await api<PatientRow>('patients.get', { id });

  const headRow = h('div', { class: 'p360-head' },
    h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => history.back() }, icon('arrowLeft')),
    h('div', { class: 'p360-id' },
      h('h1', { text: `${patient.name}` }),
      h('div', { class: 'p360-meta muted' },
        h('span', { class: 'mono', text: patient.code }),
        h('span', { text: `${patient.phone || 'no phone'}${patient.dob ? ` · ${ageOf(patient.dob)}${patient.gender ? ` · ${patient.gender}` : ''}` : ''}` }),
      ),
    ),
    h('div', { class: 'btn-row' },
      hasRole('dentist') ? h('button', { class: 'btn', onclick: () => navigate(`/patient?id=${id}&tab=chart`) }, 'Open dental chart') : '',
      h('button', { class: 'btn', onclick: () => openPatientHistorySheet(id) }, 'Medical history'),
      h('button', { class: 'btn btn-primary', onclick: () => navigate(`/calendar?new=1&patientId=${id}`) }, 'Book appointment'),
    ),
  );

  const tabBar = h('div', { class: 'tab-bar' });
  const content = h('div', { class: 'p360-host' });

  let activeTab = initialTab;
  for (const t of TABS) {
    tabBar.append(h('button', {
      class: `tab-btn${t.id === activeTab ? ' active' : ''}`, 'data-tab': t.id,
      onclick: async () => {
        activeTab = t.id;
        tabBar.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === t.id));
        await renderTab();
      },
    }, t.label));
  }

  async function renderTab(): Promise<void> {
    mount(content, h('div', { class: 'screen-loading', text: 'Loading…' }));
    try {
      const el = await (async () => {
        switch (activeTab) {
          case 'overview': return await overviewTab(id);
          case 'visits': return await visitsTab(id);
          case 'chart': return await chartTab(id);
          case 'prescriptions': return await prescriptionsTab(id);
          case 'billing': return await billingTab(id);
          case 'files': return await filesTab(id);
          case 'timeline': return await timelineTab(id);
          default: return h('div', { class: 'empty-title', text: 'Unknown tab' });
        }
      })();
      mount(content, el);
    } catch (e) {
      mount(content, h('div', { class: 'empty-title', text: (e as Error).message }));
    }
  }

  root.append(headRow, tabBar, content);
  await renderTab();
  return root;
}

function kv(label: string, value: string): El {
  return h('div', { class: 'kv' }, h('div', { class: 'kv-k muted', text: label }), h('div', { class: 'kv-v', text: value || '—' }));
}

async function overviewTab(patientId: string): Promise<El> {
  const o = await api<Overview>('patients.overview', { id: patientId });
  const p = o.patient;
  if (!p) return h('div', { class: 'empty-title', text: 'Patient not found' });
  const medical = await medicalPanel(patientId);
  const cols = h('div', { class: 'p360-cols' },
    h('section', { class: 'card' }, h('div', { class: 'card-title' }, h('h3', { text: 'Patient details' })),
      h('div', { class: 'kv-grid' },
        kv('Full name', p.name), kv('Patient code', p.code), kv('Phone', p.phone), kv('Email', p.email),
        kv('Date of birth', p.dob ? `${fmtDate(p.dob)} (${ageOf(p.dob)})` : '—'), kv('Gender', p.gender ?? '—'),
        kv('Blood group', p.blood_group), kv('Address', p.address), kv('Occupation', p.occupation),
        kv('Emergency contact', p.emergency_contact_name), kv('Referred by', p.referral_source), kv('Registered', fmtDate(p.created_at)),
      ),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => openEditPatient(p) }, 'Edit details'),
        hasRole('admin') ? h('button', { class: 'btn', onclick: () => void archivePatient(p) }, p.archived_at ? 'Restore from archive' : 'Move to archive') : '',
      ),
    ),
    medical,
  );
  const alertBar = o.alerts?.length
    ? h('div', { class: 'warn-text' }, '⚠ ' + o.alerts.map((a) => `${a.kind === 'allergy' ? 'Allergy' : 'Condition'}: ${a.value}`).join('  ·  '))
    : '';
  const summary = h('div', { class: 'stat-grid four' },
    h('div', { class: 'stat-card' }, h('div', { class: 'stat-label', text: 'Visits' }), h('div', { class: 'stat-value', text: String(o.counts?.visits ?? 0) })),
    h('div', { class: 'stat-card' }, h('div', { class: 'stat-label', text: 'Balance due' }), h('div', { class: 'stat-value', text: taka(o.outstandingPaisa ?? 0) })),
    h('div', { class: 'stat-card' }, h('div', { class: 'stat-label', text: 'Last visit' }), h('div', { class: 'stat-value stat-pill', text: o.lastVisitAt ? fmtDate(o.lastVisitAt) : 'none yet' })),
    h('div', { class: 'stat-card' }, h('div', { class: 'stat-label', text: 'Next appointment' }), h('div', { class: 'stat-value stat-pill', text: o.nextAppointmentAt ? fmtDate(o.nextAppointmentAt, true) : 'none booked' })),
  );
  return h('div', { class: 'col-gap' }, alertBar, summary, cols);
}

async function medicalPanel(patientId: string): Promise<El> {
  const state = { items: [] as { id: string; kind: string; value: string; notes: string; active: boolean | number }[] };
  const body = h('div', { class: 'list' });
  const host = h('section', { class: 'card' }, h('div', { class: 'card-title' }, h('h3', { text: 'Medical history' }),
    h('button', { class: 'btn-link', onclick: openAdd }, '+ Add')));
  async function reload(): Promise<void> {
    state.items = await api<{ id: string; kind: string; value: string; notes: string; active: boolean | number }[]>('patients.medical.list', { patientId });
    mount(body, ...(state.items.length
      ? state.items.map((m) => h('div', { class: 'list-row static' },
          badge(m.kind === 'allergy' ? 'err' : m.kind === 'condition' ? 'warn' : 'info', m.kind),
          h('span', { class: 'list-title', text: m.value }),
          h('span', { class: 'muted', text: m.notes }),
          m.active ? h('button', { class: 'btn-link danger', onclick: async () => { await api('patients.medical.remove', { id: m.id }); await reload(); } }, 'Remove') : badge('muted', 'inactive'),
        ))
      : [h('div', { class: 'empty-title', text: 'No medical history recorded' })]));
  }
  function openAdd(): void {
    modal('Add medical history item', (close) => {
      const form = h('div', { class: 'col-gap' },
        field({ name: 'kind', label: 'Kind', type: 'select', options: [{ value: 'allergy', label: 'Allergy' }, { value: 'condition', label: 'Condition' }, { value: 'medication', label: 'Current medication' }, { value: 'medical_note', label: 'Medical note' }] }),
        field({ name: 'value', label: 'Description', required: true, placeholder: 'e.g. Penicillin allergy' }),
        field({ name: 'notes', label: 'Notes', type: 'textarea', rows: 2 }),
        h('div', { class: 'btn-row end' },
          h('button', { class: 'btn', onclick: close }, 'Cancel'),
          h('button', {
            class: 'btn btn-primary', onclick: async () => {
              const v = readForm(form);
              if (!String(v.value ?? '').trim()) { toast('err', 'Description is required'); return; }
              await api('patients.medical.add', { patientId, item: { kind: String(v.kind), value: String(v.value), notes: String(v.notes ?? '') } });
              toast('ok', 'Recorded'); close(); await reload();
            },
          }, 'Save'),
        ),
      );
      return form;
    });
  }
  mount(host, body);
  await reload();
  return host;
}

function openEditPatient(p: PatientRow): void {
  modal('Edit patient', (close) => {
    const form = h('form', { class: 'form-grid' });
    form.append(
      field({ name: 'name', label: 'Full name', required: true, value: p.name }),
      field({ name: 'phone', label: 'Phone', required: true, value: p.phone }),
      field({ name: 'email', label: 'Email', type: 'email', value: p.email }),
      field({ name: 'dob', label: 'Date of birth', type: 'date', value: p.dob ?? '' }),
      field({ name: 'gender', label: 'Gender', type: 'select', value: p.gender ?? '', options: [{ value: '', label: 'Prefer not to say' }, 'Male', 'Female', 'Other'] }),
      field({ name: 'bloodGroup', label: 'Blood group', value: p.blood_group }),
      field({ name: 'address', label: 'Address', type: 'textarea', rows: 2, value: p.address }),
      field({ name: 'occupation', label: 'Occupation', value: p.occupation }),
    );
    const err2 = h('div', { class: 'login-err' });
    const row = h('div', { class: 'btn-row end' },
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary', type: 'button', onclick: async () => {
          const v = readForm(form);
          try {
            await api('patients.update', {
              id: p.id,
              title: String(v.title ?? ''), name: String(v.name).trim(), phone: String(v.phone ?? ''), altPhone: String(v.altPhone ?? ''),
              email: String(v.email ?? ''), dob: v.dob ? String(v.dob) : null, gender: v.gender || null,
              bloodGroup: String(v.bloodGroup ?? ''), address: String(v.address ?? ''),
              emergencyContactName: String(v.emergencyName ?? ''), emergencyContactPhone: String(v.emergencyPhone ?? ''),
              occupation: String(v.occupation ?? ''), referralSource: String(v.referralSource ?? ''),
              notes: String(v.notes ?? ''),
              tags: String(v.tags ?? '').split(',').map((x) => x.trim()).filter(Boolean),
              customFields: {},
            });
            toast('ok', 'Saved'); close(); location.reload();
          } catch (e) { err2.textContent = (e as Error).message; }
        },
      }, 'Save changes'),
    );
    return h('div', {}, form, err2, row);
  }, { wide: true });
}

async function archivePatient(p: PatientRow): Promise<void> {
  const okTo = await confirmDialog('Archive patient',
    p.archived_at ? 'Restore this patient to the active registry?' : `Archive ${p.name}? They will be hidden from daily workflows but kept for records.`,
    p.archived_at ? 'Restore' : 'Archive', false);
  if (!okTo) return;
  await api(p.archived_at ? 'patients.restore' : 'patients.archive', { id: p.id });
  toast('ok', p.archived_at ? 'Restored' : 'Archived');
  location.reload();
}

// ---------------- visits ----------------
interface VisitRow {
  id: string; visit_no?: number; date: string; started_at: string; chief_complaint: string;
  findings: string; diagnosis: string; notes: string; status: string; follow_up_date: string | null;
}

async function visitsTab(patientId: string): Promise<El> {
  const host = h('div', { class: 'col-gap' });
  const listHost = h('div');
  const head = h('div', { class: 'btn-row' },
    h('button', { class: 'btn btn-primary', onclick: openNewVisit }, h('span', {}, icon('add')), 'Start visit'));
  async function load(): Promise<void> {
    const res = await api<{ rows: VisitRow[] }>('visits.list', { page: 1, pageSize: 50, patientId });
    mount(listHost, dataTable<VisitRow>([
      { label: 'Date', render: (r) => fmtDate(r.started_at, true), width: '150px' },
      { label: 'Chief complaint', render: (r) => h('span', { class: 'primary-cell', text: r.chief_complaint || '—' }) },
      { label: 'Diagnosis', render: (r) => r.diagnosis || '—' },
      { label: 'Status', render: (r) => badge(r.status === 'completed' ? 'ok' : 'info', r.status), width: '110px' },
    ], res.rows, { empty: 'No visits recorded', onRow: (r) => openVisitDetail(r) }));
  }
  function openNewVisit(): void {
    modal('New visit', (close) => {
      const form = h('div', { class: 'col-gap' },
        field({ name: 'chiefComplaint', label: 'Chief complaint', type: 'textarea', rows: 2, required: true }),
        field({ name: 'symptoms', label: 'Symptoms / observation', type: 'textarea', rows: 2 }),
        field({ name: 'notes', label: 'Notes', type: 'textarea', rows: 2 }),
        field({ name: 'followUpDate', label: 'Follow-up date', type: 'date' }),
      );
      const err2 = h('div', { class: 'login-err' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            const v = readForm(form);
            if (!String(v.chiefComplaint ?? '').trim()) { err2.textContent = 'Chief complaint is required'; return; }
            try {
              await api('visits.create', {
                patientId, chiefComplaint: String(v.chiefComplaint), symptoms: String(v.symptoms ?? ''),
                notes: String(v.notes ?? ''), followUpDate: v.followUpDate ? String(v.followUpDate) : null,
                findings: '', diagnosis: '', reason: '', referral: '',
              });
              toast('ok', 'Visit opened'); close(); await load();
            } catch (e) { err2.textContent = (e as ApiError).message; }
          },
        }, 'Open visit'));
      return h('div', {}, form, err2, row);
    });
  }
  function openVisitDetail(v: VisitRow): void {
    modal(`Visit · ${fmtDate(v.started_at, true)}`, (close) => {
      const procedures = h('div', { class: 'list' }, h('div', { class: 'muted', text: 'Loading procedures…' }));
      api<{ procedures: { id: string; name: string; tooth: number | null; price_paisa: number }[]; visit: Record<string, unknown> }>('visits.get', { id: v.id })
        .then((d) => {
          const items = Array.isArray(d.procedures) ? d.procedures : [];
          mount(procedures, ...(items.length
            ? items.map((p) => h('div', { class: 'list-row static' },
                h('span', { class: 'list-title', text: p.name }),
                h('span', { class: 'muted', text: p.tooth ? `Tooth ${p.tooth}` : '' }),
                h('span', { class: 'money', text: taka(p.price_paisa ?? 0) })))
            : [h('div', { class: 'empty-title', text: 'No procedures recorded' })]));
        })
        .catch((e) => mount(procedures, h('div', { class: 'empty-title', text: e.message })));
      const wrap = h('div', { class: 'col-gap' },
        h('div', { class: 'kv-grid' },
          kv('Chief complaint', v.chief_complaint), kv('Findings', v.findings),
          kv('Diagnosis', v.diagnosis), kv('Notes', v.notes),
          kv('Follow-up', v.follow_up_date ? fmtDate(v.follow_up_date) : '—'),
        ),
        h('h4', { text: 'Procedures' }), procedures,
        h('div', { class: 'btn-row' },
          hasRole('dentist') ? h('button', {
            class: 'btn', onclick: () => { close(); openCompleteVisit(v); },
          }, 'Complete visit & procedures') : '',
          h('button', { class: 'btn', onclick: close }, 'Close'),
        ));
      return wrap;
    }, { wide: true });
  }
  function openCompleteVisit(v: VisitRow): void {
    modal('Complete visit', (close) => {
      const host = h('div', { class: 'col-gap' });
      let txns: { id: string; name: string; price_paisa: number }[] = [];
      const lines: { name: string; tooth: number | null; pricePaisa: number; qty: number; treatmentId: string | null }[] = [];
      const txList = h('div', { class: 'list' });
      const selHost = h('div');
      api<{ rows: { id: string; name: string; price_paisa: number }[] }>('treatments.list', { page: 1, pageSize: 200, q: '', category: '', includeInactive: false })
        .then((r) => { txns = r.rows; rerenderSel(); });
      function rerenderSel(): void {
        mount(selHost,
          field({ name: 'tx', label: 'Procedure', type: 'select', options: [{ value: '', label: 'Choose…' }, ...txns.map((t) => ({ value: t.id, label: `${t.name} · ${taka(t.price_paisa)}` }))] }),
          field({ name: 'tooth', label: 'Tooth (FDI, optional)', type: 'number' }),
          field({ name: 'price', label: 'Price (Tk)', type: 'number', min: 0 }),
        );
      }
      function renderLines(): void {
        mount(txList, ...(lines.length
          ? lines.map((l, i) => h('div', { class: 'list-row static' },
              h('span', { class: 'list-title', text: l.name }),
              h('span', { class: 'muted', text: l.tooth ? `Tooth ${l.tooth}` : '' }),
              h('span', { class: 'money', text: taka(l.pricePaisa) }),
              h('button', { class: 'btn-link danger', onclick: () => { lines.splice(i, 1); renderLines(); } }, 'Remove')))
          : [h('div', { class: 'empty-title', text: 'No procedures added' })]));
      }
      const err2 = h('div', { class: 'login-err' });
      host.append(
        h('h4', { text: 'Procedures performed' }), selHost,
        h('button', {
          class: 'btn', onclick: () => {
            const v2 = readForm(selHost);
            const tx = txns.find((t) => t.id === v2.tx);
            if (!tx) { toast('err', 'Choose a procedure'); return; }
            const priceTk = Number(v2.price ?? NaN);
            lines.push({ name: tx.name, treatmentId: tx.id, tooth: v2.tooth ? Number(v2.tooth) : null, pricePaisa: Number.isFinite(priceTk) ? Math.round(priceTk * 100) : tx.price_paisa, qty: 1 });
            renderLines();
          },
        }, '＋ Add procedure'),
        txList,
        field({ name: 'diagnosis', label: 'Diagnosis', type: 'textarea', rows: 2 }),
        field({ name: 'notes', label: 'Visit notes', type: 'textarea', rows: 2 }),
        field({ name: 'followUpDate', label: 'Follow-up date', type: 'date' }),
        err2,
        h('div', { class: 'btn-row end' },
          h('button', { class: 'btn', onclick: close }, 'Cancel'),
          h('button', {
            class: 'btn btn-primary', onclick: async () => {
              err2.textContent = '';
              try {
                const v2 = readForm(host);
                for (const l of lines) {
                  await api('visits.addProcedure', { visitId: v.id, treatmentId: l.treatmentId, name: l.name, tooth: l.tooth, surface: '', qty: l.qty, pricePaisa: l.pricePaisa, anesthesia: '', notes: '' });
                }
                await api('visits.update', {
                  id: v.id, patientId, chiefComplaint: v.chief_complaint || 'Visit', symptoms: '', findings: '',
                  diagnosis: String((v2.diagnosis as string) ?? ''), notes: String((v2.notes as string) ?? ''),
                  followUpDate: v2.followUpDate ? String(v2.followUpDate) : null, reason: '', referral: '',
                });
                await api('visits.setStatus', { id: v.id, status: 'completed' });
                toast('ok', 'Visit completed');
                close(); await load();
              } catch (e) { err2.textContent = (e as ApiError).message; }
            },
          }, 'Save & complete')),
      );
      renderLines();
      return host;
    }, { wide: true });
  }
  host.append(head, listHost);
  await load();
  return host;
}

// ---------------- dental chart ----------------
const ADULT_TEETH = [[18, 17, 16, 15, 14, 13, 12, 11], [21, 22, 23, 24, 25, 26, 27, 28], [48, 47, 46, 45, 44, 43, 42, 41], [31, 32, 33, 34, 35, 36, 37, 38]];
const PRIMARY_TEETH = [[55, 54, 53, 52, 51], [61, 62, 63, 64, 65], [85, 84, 83, 82, 81], [71, 72, 73, 74, 75]];
const STATES = ['sound', 'caries', 'restoration', 'crown', 'root_canal', 'missing', 'implant', 'fractured', 'impacted', 'watch'];

async function chartTab(patientId: string): Promise<El> {
  let dentition: 'adult' | 'primary' = 'adult';
  const host = h('div', { class: 'col-gap' });
  const chartHost = h('div');
  const toolbar = h('div', { class: 'btn-row align-center' },
    h('span', { class: 'muted', text: 'Dentition:' }),
    h('button', { class: 'btn seg', 'data-d': 'adult', onclick: () => setD('adult') }, 'Adult'),
    h('button', { class: 'btn seg', 'data-d': 'primary', onclick: () => setD('primary') }, 'Primary'),
    h('span', { class: 'spacer' }),
    hasRole('dentist') ? h('span', { class: 'muted', text: 'Select a tooth to set its state' }) : h('span', { class: 'muted', text: 'Read-only for your role' }),
  );
  function setD(d: 'adult' | 'primary'): void {
    dentition = d;
    toolbar.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.d === d));
    void load();
  }
  async function load(): Promise<void> {
    const chart = await api<{ teeth: { tooth: number; state: string; notes: string }[] }>('chart.get', { patientId, dentition });
    const state: Record<number, string> = {};
    for (const t of chart.teeth ?? []) state[t.tooth] = t.state;
    renderChart(state);
  }
  function renderChart(state: Record<number, string>): void {
    mount(chartHost, h('div', { class: 'chart-legend' },
      ...STATES.map((s) => h('span', { class: 'legend-item' }, h('span', { class: `legend-swatch tooth-${s}` }), h('span', { text: s.replace('_', ' ') }))),
    ));
    const rows = dentition === 'adult' ? ADULT_TEETH : PRIMARY_TEETH;
    const grid = h('div', { class: `odontogram` });
    rows.forEach((quadrant, qi) => {
      const qRow = h('div', { class: `q-row qpos-${qi}` });
      for (const t of quadrant) {
        const cur = state[t] ?? 'sound';
        const btn = h('button', {
          class: `tooth tooth-${cur}`, 'aria-label': `Tooth ${t}: ${cur}`,
          title: `Tooth ${t} — ${cur.replace('_', ' ')}\nClick to change`,
          onclick: () => hasRole('dentist') && void pickToothState(t, cur),
        }, h('span', { class: 'tooth-no', text: String(t) }));
        qRow.append(btn);
      }
      grid.append(qRow);
    });
    chartHost.append(grid);
  }
  async function pickToothState(tooth: number, cur: string): Promise<void> {
    modal(`Tooth ${tooth}`, (close) => {
      const list = h('div', { class: 'tooth-states' });
      for (const s of STATES) {
        list.append(h('button', {
          class: `state-btn tooth-${s}${s === cur ? ' active' : ''}`,
          onclick: async () => {
            await api('chart.setTooth', { patientId, dentition, tooth, state: s, notes: '' });
            toast('ok', `Tooth ${tooth} set to ${s.replace('_', ' ')}`);
            close(); await load();
          },
        }, h('span', { class: 'legend-swatch tooth-' + s }), s.replace('_', ' ')));
      }
      return list;
    });
  }
  host.append(toolbar, chartHost);
  setD('adult');
  await load();
  return host;
}

// ---------------- prescriptions ----------------
interface RxRow { id: string; rx_no: string; date: string; finalized_at: string | null; item_count: number }

async function prescriptionsTab(patientId: string): Promise<El> {
  const host = h('div', { class: 'col-gap' });
  const listHost = h('div');
  const head = h('div', { class: 'btn-row' },
    hasRole('dentist') ? h('button', { class: 'btn btn-primary', onclick: openNewRx }, h('span', {}, icon('add')), 'New prescription') : '');
  async function load(): Promise<void> {
    const res = await api<{ rows: RxRow[] }>('prescriptions.list', { patientId });
    mount(listHost, dataTable<RxRow>([
      { label: 'Rx No', render: (r) => h('span', { class: 'mono', text: r.rx_no }), width: '140px' },
      { label: 'Date', render: (r) => fmtDate(r.date) },
      { label: 'Items', align: 'right', render: (r) => String(r.item_count) },
      { label: 'Status', render: (r) => badge(r.finalized_at ? 'ok' : 'muted', r.finalized_at ? 'final' : 'draft'), width: '90px' },
      {
        label: '', align: 'right', render: (r) => h('div', { class: 'btn-row end' },
          h('button', { class: 'btn-link', onclick: (e: MouseEvent) => { e.stopPropagation(); void printRx(r.id); } }, 'Print'),
        ),
      },
    ], res.rows, { empty: 'No prescriptions yet' }));
  }
  async function printRx(rxId: string): Promise<void> {
    const r = await api<{ path: string; pageCount: number }>('docs.generate', { kind: 'prescription', id: rxId });
    toast('ok', `PDF generated (${r.pageCount} page${r.pageCount === 1 ? '' : 's'})`);
  }
  function openNewRx(): void {
    modal('New prescription', (close) => {
      const CC = ['Pain On', 'G. Carries', 'Swelling', 'Gum Bleeding', 'Bad Breath', 'Sensitivity'];
      const OE = ['Carries', 'G Carries', 'BDR', 'BDC', 'Gingivitis', 'Parodental Pocket', 'Perio Dontitis', 'Impected Teeth', 'Dry Socket', 'Attrition', 'Erosion'];
      const sel: { cc: Record<string, boolean>; oe: Record<string, boolean> } = { cc: {}, oe: {} };
      const ccBox = h('div', { class: 'chips-wrap' }, ...CC.map((c) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', onchange: (e: Event) => { sel.cc[c] = (e.target as HTMLInputElement).checked; } }), c)));
      const oeBox = h('div', { class: 'chips-wrap' }, ...OE.map((c) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', onchange: (e: Event) => { sel.oe[c] = (e.target as HTMLInputElement).checked; } }), c)));
      const items: { drugName: string; strength: string; dose: string; frequency: string; duration: string; route: string; instructions: string }[] = [];
      const itemHost = h('div', { class: 'list' });
      function renderItems(): void {
        mount(itemHost, ...(items.length
          ? items.map((m, i) => h('div', { class: 'list-row static' },
              h('span', { class: 'list-title', text: `${m.drugName} ${m.strength}` }),
              h('span', { class: 'muted', text: `${m.dose} · ${m.frequency} · ${m.duration}` }),
              h('button', { class: 'btn-link danger', onclick: () => { items.splice(i, 1); renderItems(); } }, 'Remove')))
          : [h('div', { class: 'empty-title', text: 'No medicines added' })]));
      }
      const medForm = h('div', { class: 'form-grid med-form' },
        field({ name: 'drugName', label: 'Drug', placeholder: 'e.g. Tab. Amoxicillin' }),
        field({ name: 'strength', label: 'Strength', placeholder: '500 mg' }),
        field({ name: 'dose', label: 'Dose', placeholder: '1 cap' }),
        field({ name: 'frequency', label: 'Frequency', placeholder: 'Three times daily' }),
        field({ name: 'duration', label: 'Duration', placeholder: '7 days' }),
        field({ name: 'route', label: 'Route', value: 'oral' }),
      );
      renderItems();
      const err2 = h('div', { class: 'login-err' });
      const wrap = h('div', { class: 'col-gap' },
        h('h4', { text: 'C/C' }), ccBox,
        h('h4', { text: 'O/E' }), oeBox,
        h('div', { class: 'form-grid' },
          field({ name: 're', label: 'R/E', type: 'textarea', rows: 2 }),
          field({ name: 'advice', label: 'Advice', type: 'textarea', rows: 2 }),
        ),
        h('h4', { text: 'Medications' }), medForm,
        h('button', {
          class: 'btn', onclick: () => {
            const v = readForm(medForm);
            if (!String(v.drugName ?? '').trim()) { toast('err', 'Drug name is required'); return; }
            items.push({
              drugName: String(v.drugName), strength: String(v.strength ?? ''), dose: String(v.dose ?? ''),
              frequency: String(v.frequency ?? ''), duration: String(v.duration ?? ''), route: String(v.route ?? 'oral'),
              instructions: '',
            });
            renderItems();
            medForm.querySelectorAll<HTMLInputElement>('input').forEach((i) => { if (i.type === 'text') i.value = ''; });
          },
        }, '＋ Add medicine'),
        itemHost,
        field({ name: 'followUpDate', label: 'Follow-up date', type: 'date' }),
        err2,
        h('div', { class: 'btn-row end' },
          h('button', { class: 'btn', onclick: close }, 'Cancel'),
          h('button', { class: 'btn', onclick: () => saveRx(false, close, err2, sel, items) }, 'Save draft'),
          h('button', { class: 'btn btn-primary', onclick: () => saveRx(true, close, err2, sel, items) }, 'Finalize & save')),
      );
      async function saveRx(finalize: boolean, cloz: () => void, errEl: HTMLElement, s: typeof sel, meds: typeof items): Promise<void> {
        errEl.textContent = '';
        const formVals = readForm(wrap);
        try {
          await api('prescriptions.create', {
            patientId, cc: Object.keys(s.cc).filter((k) => s.cc[k]), oe: Object.keys(s.oe).filter((k) => s.oe[k]),
            re: String(formVals.re ?? ''), advice: String(formVals.advice ?? ''), items: meds,
            followUpDate: formVals.followUpDate ? String(formVals.followUpDate) : null, finalize, visitId: null, dentistId: null,
          });
          toast('ok', finalize ? 'Prescription finalized' : 'Draft saved');
          cloz(); await load();
        } catch (e) { errEl.textContent = (e as ApiError).message; }
      }
      return wrap;
    }, { wide: true });
  }
  host.append(head, listHost);
  await load();
  return host;
}

// ---------------- billing ----------------
interface Statement { lines: { date: string; kind: string; ref: string; description: string; debitPaisa: number; creditPaisa: number; balancePaisa: number }[]; openingPaisa: number; closingPaisa: number }

async function billingTab(patientId: string): Promise<El> {
  const host = h('div', { class: 'col-gap' });
  const listHost = h('div');
  const stmtHost = h('div');
  async function load(): Promise<void> {
    const res = await api<{ rows: { id: string; invoice_no: string; date: string; total_paisa: number; paid_paisa: number; status: string }[] }>('invoices.list', { patientId, page: 1, pageSize: 50 });
    mount(listHost, h('h3', { text: 'Invoices' }), dataTable([
      { label: 'Invoice', render: (r: typeof res.rows[number]) => h('span', { class: 'mono', text: r.invoice_no }), width: '140px' },
      { label: 'Date', render: (r: typeof res.rows[number]) => fmtDate(r.date) },
      { label: 'Total', align: 'right' as const, render: (r: typeof res.rows[number]) => taka(r.total_paisa) },
      { label: 'Paid', align: 'right' as const, render: (r: typeof res.rows[number]) => taka(r.paid_paisa) },
      { label: 'Due', align: 'right' as const, render: (r: typeof res.rows[number]) => h('span', { class: r.status === 'final' && r.total_paisa - r.paid_paisa > 0 ? 'due-hot' : '', text: taka(r.status === 'final' ? r.total_paisa - r.paid_paisa : 0) }) },
      { label: '', align: 'right' as const, render: (r: typeof res.rows[number]) => h('button', { class: 'btn-link', onclick: () => navigate(`/invoice?id=${r.id}`) }, 'Open') },
    ], res.rows, { empty: 'No invoices yet' }));
    const stmt = await api<Statement>('statements.patient', { patientId });
    type StmtLine = Statement['lines'][number];
    mount(stmtHost, h('h3', { text: 'Account statement' }), dataTable([
      { label: 'Date', render: (e: StmtLine) => fmtDate(e.date) },
      { label: 'Entry', render: (e: StmtLine) => `${e.kind === 'invoice' ? 'Invoice' : e.kind === 'payment' ? 'Payment' : e.kind === 'refund' ? 'Refund' : 'Adjustment'} · ${e.ref}` },
      { label: 'Description', render: (e: StmtLine) => e.description || '—' },
      { label: 'Debit', align: 'right' as const, render: (e: StmtLine) => e.debitPaisa ? taka(e.debitPaisa) : '—' },
      { label: 'Credit', align: 'right' as const, render: (e: StmtLine) => e.creditPaisa ? taka(e.creditPaisa) : '—' },
      { label: 'Balance', align: 'right' as const, render: (e: StmtLine) => h('strong', { text: taka(e.balancePaisa) }) },
    ], stmt.lines, { empty: 'No account activity' }));
  }
  host.append(listHost, stmtHost);
  await load();
  return host;
}

// ---------------- files ----------------
async function filesTab(patientId: string): Promise<El> {
  const host = h('div', { class: 'col-gap' });
  const hostList = h('div');
  async function load(): Promise<void> {
    const rows = await api<{ id: string; file_name: string; size: number; created_at: string; note: string }[]>('attachments.list', { patientId });
    mount(hostList, dataTable<{ id: string; file_name: string; size: number; created_at: string; note: string }>([
      { label: 'File', render: (r) => h('span', { class: 'primary-cell', text: r.file_name }) },
      { label: 'Note', render: (r) => r.note || '—' },
      { label: 'Size', align: 'right', render: (r) => `${Math.round((r.size ?? 0) / 1024)} KB`, width: '90px' },
      { label: 'Added', render: (r) => fmtDate(r.created_at, true), width: '150px' },
      {
        label: '', align: 'right', render: (r) => h('div', { class: 'btn-row end' },
          h('button', { class: 'btn-link', onclick: async () => { await api('attachments.open', { id: r.id }); } }, 'Open'),
          hasRole('admin', 'dentist') ? h('button', {
            class: 'btn-link danger', onclick: async () => {
              if (await confirmDialog('Remove attachment', `Remove ${r.file_name}? This cannot be undone.`)) {
                await api('attachments.remove', { id: r.id }); toast('ok', 'Removed'); await load();
              }
            },
          }, 'Remove') : ''),
      },
    ], rows ?? [], { empty: 'No attachments' }));
  }
  const addBtn = h('button', {
    class: 'btn btn-primary', onclick: async () => {
      try {
        const picked = await api<{ path: string | null }>('system.pickFile', { kind: 'attachment' });
        if (!picked.path) return;
        const res = await api<{ id: string; fileName: string }>('attachments.add', { patientId, visitId: null, sourcePath: picked.path, note: '' });
        toast('ok', `Attached ${res.fileName}`); await load();
      } catch (e) { toast('err', (e as Error).message); }
    },
  }, h('span', {}, icon('paperclip')), 'Attach file…');
  host.append(h('div', { class: 'btn-row' }, addBtn), hostList);
  await load();
  return host;
}

// ---------------- timeline ----------------
async function timelineTab(patientId: string): Promise<El> {
  const host = h('div', { class: 'timeline' }, h('div', { class: 'screen-loading', text: 'Loading timeline…' }));
  const events: { at: string; kind: string; title: string; sub: string }[] = [];
  let cursor: string | undefined;
  async function more(): Promise<void> {
    const res = await api<{ events: { at: string; kind: string; title: string; sub: string }[]; nextCursor: string | null }>('patients.timeline', { patientId: patientId, cursor, limit: 40 });
    events.push(...res.events);
    cursor = res.nextCursor ?? undefined;
    render();
  }
  function render(): void {
    const moreBtn = cursor ? h('button', { class: 'btn', onclick: () => void more() }, 'Load more') : '';
    mount(host, ...(events.length ? events.map((e) =>
      h('div', { class: 'tl-item' },
        h('div', { class: 'tl-date muted', text: fmtDate(e.at, true) }),
        h('div', { class: 'tl-dot' }),
        h('div', { class: 'tl-body' }, h('div', { class: 'tl-title', text: e.title }), h('div', { class: 'muted', text: e.sub })))
      ) : [h('div', { class: 'empty-title', text: 'Nothing recorded yet' })]), moreBtn);
  }
  await more();
  return host;
}

async function openPatientHistorySheet(patientId: string): Promise<void> {
  const o = await api<Overview>('patients.overview', { id: patientId });
  const p = o.patient;
  modal('Record snapshot', () => h('div', { class: 'col-gap' },
    h('div', { class: 'kv-grid' },
      kv('Name', p.name), kv('Code', p.code), kv('Phone', p.phone),
      kv('Date of birth', p.dob ?? '—'), kv('Gender', p.gender ?? '—'), kv('Blood group', p.blood_group),
    ),
    h('p', { class: 'muted small', text: 'This is a read-only snapshot for verification. Open the relevant tab to make changes.' }),
  ));
}

export function medicalNote(): void { /* aggregator re-export safety */ }
