// Scheduling — day/week/month calendar + daily queue with resource-scoped conflict handling + check-in flow.
import { api, ApiError } from '../api';
import { h, mount, icon, toast, modal, field, readForm, dataTable, badge, fmtDate, todayStr, El } from '../ui';
import { navigate } from '../app';

interface AppointmentRow {
  id: string; patient_id: string; patient_name: string; patient_code: string;
  starts_at: string; ends_at: string; type: string; status: string; chair: string; reason: string;
}
interface PatientHit { id: string; code: string; name: string; phone: string }

const viewModes = ['day', 'week', 'month', 'agenda'] as const;
type ViewMode = typeof viewModes[number];

export async function calendarScreen(q: URLSearchParams): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  let mode: ViewMode = 'day';
  let anchor = todayStr();

  const headBar = h('div', { class: 'page-head' },
    h('div', {}, h('h1', { text: 'Appointments' }), h('p', { class: 'muted', text: 'Chair-side scheduling' })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => { anchor = todayStr(); void load(); } }, 'Today'),
      h('button', { class: 'btn', onclick: () => step(-1) }, '‹'),
      h('button', { class: 'btn', onclick: () => step(1) }, '›'),
      h('button', { class: 'btn btn-primary', onclick: () => openBooking() }, h('span', {}, icon('add')), 'New appointment'),
    ));

  const segBar = h('div', { class: 'seg-bar' },
    ...viewModes.map((m) => h('button', { class: `btn seg${m === mode ? ' active' : ''}`, 'data-m': m, onclick: () => setMode(m) }, m[0]!.toUpperCase() + m.slice(1))));
  const listHost = h('div', { class: 'card-host' });

  function step(dir: number): void {
    const d = new Date(`${anchor}T00:00:00`);
    if (mode === 'day') d.setDate(d.getDate() + dir);
    else if (mode === 'week') d.setDate(d.getDate() + dir * 7);
    else if (mode === 'month') d.setMonth(d.getMonth() + dir);
    anchor = d.toISOString().slice(0, 10);
    void load();
  }
  function setMode(m: ViewMode): void {
    mode = m;
    segBar.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.m === m));
    void load();
  }

  function range(): { from: string; to: string } {
    const d = new Date(`${anchor}T00:00:00`);
    if (mode === 'day') return { from: anchor, to: anchor };
    if (mode === 'week') {
      const dow = (d.getDay() + 6) % 7; // Monday
      const start = new Date(d); start.setDate(d.getDate() - dow);
      const end = new Date(start); end.setDate(start.getDate() + 6);
      return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
    }
    if (mode === 'month') {
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
    }
    const end = new Date(d); end.setDate(d.getDate() + 30);
    return { from: anchor, to: end.toISOString().slice(0, 10) };
  }

  async function load(): Promise<void> {
    const r = range();
    const res = await api<{ rows: AppointmentRow[]; dayCount?: Record<string, number> }>('appointments.list', { page: 1, pageSize: 200, from: r.from, to: r.to });
    const rows = res.rows;
    const monthLabel = mode === 'day' ? fmtDate(anchor) : mode === 'week' ? `Week of ${fmtDate(r.from)}` : mode === 'month' ? `Month of ${fmtDate(r.from)}` : `Next 30 days from ${fmtDate(anchor)}`;
    if (mode === 'month') {
      renderMonth(rows, r);
      return;
    }
    const table = dataTable<AppointmentRow>([
      { label: 'Date', render: (a) => fmtDate(a.starts_at), width: '120px' },
      { label: 'Time', render: (a) => `${a.starts_at.slice(11, 16)} – ${a.ends_at.slice(11, 16)}`, width: '130px' },
      { label: 'Patient', render: (a) => h('span', { class: 'primary-cell', text: `${a.patient_name}` }) },
      { label: 'Type', render: (a) => a.type || 'Consultation' },
      { label: 'Chair', render: (a) => a.chair || '—', width: '90px' },
      { label: 'Status', render: (a) => badge(a.status === 'completed' ? 'ok' : a.status === 'checked_in' ? 'warn' : a.status.startsWith('cancel') || a.status === 'no_show' ? 'muted' : 'info', a.status.replace('_', ' ')), width: '120px' },
      {
        label: '', align: 'right', render: (a) => h('div', { class: 'btn-row end' },
          a.status === 'scheduled' ? h('button', { class: 'btn-link', onclick: async (e: MouseEvent) => { e.stopPropagation(); await checkIn(a); } }, 'Check in') : '',
          a.status === 'scheduled' || a.status === 'checked_in' ? h('button', { class: 'btn-link', onclick: async (e: MouseEvent) => { e.stopPropagation(); await cancelAppt(a); } }, 'Cancel') : '',
        ),
      },
    ], rows, { empty: 'Nothing booked in this range', onRow: (a) => navigate(`/patient?id=${a.patient_id}`) });
    mount(listHost, h('div', { class: 'range-bar muted', text: monthLabel }), table);
  }

  function renderMonth(rows: AppointmentRow[], r: { from: string; to: string }): void {
    const buckets: Record<string, AppointmentRow[]> = {};
    for (const a of rows) {
      const dayKey = a.starts_at.slice(0, 10);
      (buckets[dayKey] ??= []).push(a);
    }
    const start = new Date(`${r.from}T00:00:00`);
    const grid = h('div', { class: 'cal-month' });
    const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    grid.append(...wd.map((w) => h('div', { class: 'cal-head muted', text: w })));
    const firstDow = (start.getDay() + 6) % 7;
    for (let i = 0; i < firstDow; i++) grid.append(h('div', { class: 'cal-cell cal-empty' }));
    const d = new Date(start);
    while (d.toISOString().slice(0, 10) <= r.to) {
      const key = d.toISOString().slice(0, 10);
      const dayAppts = buckets[key] ?? [];
      grid.append(h('div', { class: `cal-cell${key === todayStr() ? ' today' : ''}` },
        h('div', { class: 'cal-day', text: String(d.getDate()) }),
        ...dayAppts.slice(0, 3).map((a) => h('div', { class: 'cal-event', text: `${a.starts_at.slice(11, 16)} ${a.patient_name}` })),
        dayAppts.length > 3 ? h('div', { class: 'muted small', text: `+${dayAppts.length - 3} more` }) : '',
      ));
      d.setDate(d.getDate() + 1);
    }
    mount(listHost, grid);
  }

  async function patientPicker(onPick: (p: PatientHit) => void): Promise<El> {
    const wrap = h('div', { class: 'picker' });
    const input = h('input', { class: 'search-input', placeholder: 'Search patient by name/code/phone…' });
    const hits = h('div', { class: 'picker-hits' });
    let t = 0;
    input.addEventListener('input', () => {
      clearTimeout(t); t = window.setTimeout(async () => {
        const qstr = input.value.trim();
        if (qstr.length < 2) { mount(hits); return; }
        const rows = await api<{ rows: PatientHit[] }>('patients.list', { page: 1, pageSize: 8, q: qstr, archived: false, tag: '', sortBy: 'name', sortDir: 'asc' });
        mount(hits, ...rows.rows.map((p) => h('button', { class: 'picker-row', onclick: () => onPick(p) }, h('span', { class: 'primary-cell', text: p.name }), h('span', { class: 'muted', text: `${p.code} · ${p.phone}` }))));
      }, 180);
    });
    wrap.append(input, hits);
    return wrap;
  }

  async function openBooking(presetPatientId?: string): Promise<void> {
    let picked: PatientHit | null = null;
    let presetName = '';
    if (presetPatientId) {
      const p = await api<{ id: string; name: string }>('patients.get', { id: presetPatientId });
      picked = { id: p.id, name: p.name, code: '', phone: '' };
      presetName = p.name;
    }
    modal('New appointment', (close) => {
      const pickedLabel = h('div', { class: 'picked-label', text: presetName });
      const pickBtn = h('button', { class: 'btn', onclick: async () => {
        const picker = await patientPicker((p) => { picked = p; pickedLabel.textContent = `${p.name} (${p.code})`; pickBtn.textContent = 'Change patient'; });
        modal('Choose patient', () => picker);
      } }, presetPatientId ? 'Change patient' : 'Choose patient');
      const form = h('div', { class: 'form-grid' },
        field({ name: 'date', label: 'Date', type: 'date', value: anchor, required: true }),
        field({ name: 'startTime', label: 'Start time', type: 'time', value: '10:00', required: true }),
        field({ name: 'durationMin', label: 'Duration (min)', type: 'number', value: 30, min: 5, max: 480 }),
        field({ name: 'chair', label: 'Chair / room', placeholder: 'e.g. Chair 1' }),
        field({ name: 'type', label: 'Type', value: 'Consultation' }),
        field({ name: 'reason', label: 'Reason / notes', type: 'textarea', rows: 2 }),
      );
      const err2 = h('div', { class: 'login-err' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            err2.textContent = '';
            if (!picked) { err2.textContent = 'Choose a patient first'; return; }
            const v = readForm(form);
            try {
              await api('appointments.create', {
                patientId: (picked as PatientHit).id, date: String(v.date), startTime: String(v.startTime),
                durationMin: Number(v.durationMin ?? 30), chair: String(v.chair ?? ''), type: String(v.type ?? 'Consultation'),
                reason: String(v.reason ?? ''), notes: '',
              });
              toast('ok', 'Appointment booked');
              close(); await load();
            } catch (e) { err2.textContent = (e as ApiError).message; }
          },
        }, 'Book'),
      );
      return h('div', { class: 'col-gap' },
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Patient'), pickedLabel, pickBtn),
        form, err2, row);
    }, { wide: true });
  }

  async function checkIn(a: AppointmentRow): Promise<void> {
    await api('queue.add', { patientId: a.patient_id, appointmentId: a.id });
    await api('appointments.setStatus', { id: a.id, status: 'arrived' });
    toast('ok', `${a.patient_name} checked in to the queue`);
    await load();
  }
  async function cancelAppt(a: AppointmentRow): Promise<void> {
    const { confirmDialog } = await import('../ui');
    if (!(await confirmDialog('Cancel appointment', `Cancel ${a.patient_name}'s ${a.type.toLowerCase()}?`, 'Cancel appointment'))) return;
    await api('appointments.setStatus', { id: a.id, status: 'cancelled' });
    toast('ok', 'Cancelled'); await load();
  }

  root.append(headBar, segBar, listHost);
  if (q.get('new') === '1') setTimeout(() => void openBooking(q.get('patientId') ?? undefined), 50);
  await load();
  return root;
}

// ---------------- daily queue ----------------
export async function queueScreen(): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  interface QueueRow { id: string; serial: number; status: string; patient_id: string; patient_name: string; patient_code: string; appointment_id: string | null; arrived_at?: string }
  const listHost = h('div');
  const stats = h('div', { class: 'btn-row' });
  async function load(): Promise<void> {
    const rows = await api<QueueRow[]>('queue.today');
    const waiting = rows.filter((q) => q.status === 'waiting' || q.status === 'called');
    mount(stats,
      h('span', { class: 'stat-pill', text: `${waiting.length} in queue` }),
      h('span', { class: 'stat-pill', text: `${rows.filter((q) => q.status === 'done').length} seen` }));
    mount(listHost, dataTable<QueueRow>([
      { label: '#', render: (q) => h('span', { class: 'serial', text: String(q.serial) }), width: '70px' },
      { label: 'Patient', render: (q) => h('span', { class: 'primary-cell', text: q.patient_name }) },
      { label: 'Status', render: (q) => badge(q.status === 'done' ? 'ok' : q.status === 'called' ? 'warn' : q.status === 'skipped' ? 'muted' : 'info', q.status), width: '110px' },
      {
        label: '', align: 'right', render: (q) => h('div', { class: 'btn-row end' },
          q.status === 'waiting' ? h('button', { class: 'btn-link', onclick: async () => { await api('queue.setStatus', { id: q.id, status: 'called' }); await load(); } }, 'Call') : '',
          q.status === 'called' ? h('button', { class: 'btn-link', onclick: async () => { await api('queue.setStatus', { id: q.id, status: 'completed' }); await load(); navigate(`/patient?id=${q.patient_id}&tab=visits`); } }, 'Mark seen') : '',
          (q.status === 'waiting' || q.status === 'called') ? h('button', { class: 'btn-link danger', onclick: async () => { await api('queue.setStatus', { id: q.id, status: 'skipped' }); await load(); } }, 'Skip') : '',
        ),
      },
    ], rows, { empty: 'No check-ins yet today. Check in patients from the Appointments list.' }));
  }
  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { text: "Today's queue" }), h('p', { class: 'muted', text: fmtDate(todayStr()) })),
      stats),
    listHost,
  );
  await load();
  return root;
}
