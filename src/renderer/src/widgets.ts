// Dentiva Pro — shared micro-widgets (patient picker used by billing/scheduling/documents).
import { api } from './api';
import { h, mount, modal } from './ui';

export interface PatientPick { id: string; code: string; name: string; phone: string }

/** Modal patient picker with debounced server search. Returns immediately; calls onPick. */
export function patientPickerModal(onPick: (p: PatientPick) => void): void {
  const wrap = h('div', { class: 'picker' });
  const input = h('input', { class: 'search-input', placeholder: 'Type name, code, phone…', autocomplete: 'off' });
  const hits = h('div', { class: 'picker-hits' }, h('div', { class: 'muted pad', text: 'Start typing to search the registry' }));
  let timer = 0;
  function pick(p: PatientPick): void {
    close(); onPick(p);
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { mount(hits, h('div', { class: 'muted pad', text: 'Type at least 2 characters' })); return; }
      mount(hits, h('div', { class: 'muted pad', text: 'Searching…' }));
      try {
        const res = await api<{ rows: PatientPick[] }>('patients.list', { page: 1, pageSize: 10, q, archived: false, tag: '', sortBy: 'name', sortDir: 'asc' });
        mount(hits, ...(res.rows.length
          ? res.rows.map((p) => h('button', { class: 'picker-row', onclick: () => pick(p) },
              h('span', { class: 'primary-cell', text: p.name }), h('span', { class: 'muted', text: `${p.code} · ${p.phone || 'no phone'}` })))
          : [h('div', { class: 'muted pad', text: `No patients match “${q}”` })]));
      } catch (e) { mount(hits, h('div', { class: 'muted pad', text: (e as Error).message })); }
    }, 180);
  });
  wrap.append(input, hits);
  const close = modal('Find patient', () => wrap);
  input.focus();
}
