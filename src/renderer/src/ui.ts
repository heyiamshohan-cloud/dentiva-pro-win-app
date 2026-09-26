// Dentiva Pro renderer — minimal, dependency-free UI component kit.
export type El = HTMLElement;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = String(v); // trusted icon strings only
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else if (k === 'checked') (el as HTMLInputElement).checked = Boolean(v);
    else if (k === 'disabled') (el as HTMLButtonElement).disabled = Boolean(v);
    else if (k === 'selected') (el as HTMLOptionElement).selected = Boolean(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c as Node | string);
  return el;
}

export function mount(target: El, ...children: (Node | string | null | undefined)[]): void {
  target.replaceChildren(...(children.filter((c) => c != null) as (Node | string)[]));
}

// ---------- icons (inline, stroke-based) ----------
export const icons: Record<string, string> = {
  dashboard: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  patients: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="12" cy="8" r="3.6"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M8 2.5v4M16 2.5v4M3 9.5h18"/></svg>',
  chart: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 4c-2 0-3 2-3 4.5S5.5 16 5.5 18.5c0 1 .8 1.5 1.5 1.2L9 18l3 1.5 3-1.5 2 1.7c.7.3 1.5-.2 1.5-1.2C18.5 16 20 12 20 8.5S19 4 17 4c-1.5 0-2 1-5 1s-3.5-1-5-1z"/></svg>',
  queue: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h13M4 12h13M4 18h13"/><path d="M19 6l2 2-2 2" /></svg>',
  invoice: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2.5h12v19l-3-2-3 2-3-2-3 2z"/><path d="M9 7.5h6M9 11h6M9 14.5h3"/></svg>',
  money: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/></svg>',
  inventory: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/></svg>',
  reports: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/></svg>',
  users: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5M16 4.5a3.2 3.2 0 0 1 0 7M17.5 14.7c1.8.8 3 2.4 3 4.8"/></svg>',
  backup: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a7.5 7.5 0 0 1 7.5 7.6v.4a4 4 0 0 1 .5 8H7a5 5 0 0 1-.7-10A7.5 7.5 0 0 1 12 3z"/><path d="M12 12v6M9.5 15.5L12 13l2.5 2.5"/></svg>',
  audit: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 3h14v18H5z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 6h14l2 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16"/></svg>',
  add: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/></svg>',
  print: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 8V3.5h10V8"/><rect x="4" y="8" width="16" height="9" rx="1.5"/><path d="M7 13.5h10v7H7z"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l-7 7 7 7"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v11M7.5 11L12 15.5 16.5 11M4.5 19.5h15"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 15V4M7.5 8L12 3.5 16.5 8M4.5 19.5h15"/></svg>',
  paperclip: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 11.5l-7.8 7.8a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.3-2.4l7.3-7.3"/></svg>',
};
export function icon(name: string): HTMLElement {
  const span = h('span', { class: 'ic', 'aria-hidden': 'true' });
  span.innerHTML = icons[name] ?? icons.search!;
  return span;
}

// ---------- formatters ----------
export function taka(paisa: number | null | undefined, symbol = '৳'): string {
  const n = Number(paisa ?? 0);
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  const t = Math.floor(abs / 100);
  const p = abs % 100;
  const withCommas = t.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${symbol} ${withCommas}.${p.toString().padStart(2, '0')}`;
}
export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  if (!withTime) return dd;
  return `${dd}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}
export function todayStr(): string { return new Date().toISOString().slice(0, 10); }

// ---------- toast ----------
let toastRoot: El | null = null;
export function toast(kind: 'ok' | 'err' | 'warn', text: string): void {
  if (!toastRoot) { toastRoot = h('div', { class: 'toast-root' }); document.body.append(toastRoot); }
  const item = h('div', { class: `toast toast-${kind}`, role: 'status', text });
  toastRoot.append(item);
  setTimeout(() => item.classList.add('show'), 10);
  setTimeout(() => { item.classList.remove('show'); setTimeout(() => item.remove(), 300); }, kind === 'err' ? 6000 : 3500);
}

// ---------- modal ----------
export function modal(title: string, buildBody: (close: () => void) => Node, opts: { wide?: boolean } = {}): () => void {
  const overlay = h('div', { class: 'modal-overlay', onclick: (e: MouseEvent) => { if (e.target === overlay) close(); } });
  const box = h('div', { class: `modal ${opts.wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
  const escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  box.append(h('div', { class: 'modal-head' }, h('h3', { text: title }), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close'))));
  box.append(h('div', { class: 'modal-body' }, buildBody(close)));
  overlay.append(box);
  document.body.append(overlay);
  document.addEventListener('keydown', escHandler);
  const first = box.querySelector<HTMLElement>('input,select,textarea,button.primary');
  first?.focus();
  return close;
}

export function confirmDialog(title: string, message: string, confirmLabel = 'Confirm', danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    modal(title, (close) => {
      const wrap = h('div', { class: 'confirm-wrap' }, h('p', { class: 'confirm-msg', text: message }));
      const row = h('div', { class: 'btn-row end' });
      row.append(h('button', { class: 'btn', onclick: () => { close(); resolve(false); } }, 'Cancel'));
      row.append(h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { close(); resolve(true); } }, confirmLabel));
      wrap.append(row);
      return wrap;
    });
  });
}

// ---------- form helpers ----------
export interface FieldDef {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'time' | 'email' | 'password' | 'textarea' | 'select' | 'checkbox';
  required?: boolean;
  options?: readonly (string | { value: string; label: string })[];
  placeholder?: string;
  help?: string;
  value?: unknown;
  min?: number | string;
  max?: number | string;
  rows?: number;
  disabled?: boolean;
}
export function field(f: FieldDef): El {
  const wrap = h('div', { class: `field field-${f.type ?? 'text'}`, 'data-name': f.name });
  const idn = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
  wrap.append(h('label', { for: idn, class: 'field-label' }, f.label, f.required ? h('span', { class: 'req', text: ' *' }) : ''));
  let input: El;
  const common: Record<string, unknown> = { id: idn, name: f.name, disabled: f.disabled };
  if (f.type === 'textarea') {
    input = h('textarea', { ...common, rows: f.rows ?? 3, placeholder: f.placeholder ?? '' });
    (input as HTMLTextAreaElement).value = String(f.value ?? '');
  } else if (f.type === 'select') {
    const sel = h('select', { ...common });
    for (const o of f.options ?? []) {
      const opt = typeof o === 'string' ? { value: o, label: o } : o;
      const el = h('option', { value: opt.value, text: opt.label });
      if (String(f.value ?? '') === opt.value) el.selected = true;
      sel.append(el);
    }
    input = sel;
  } else if (f.type === 'checkbox') {
    const cb = h('input', { ...common, type: 'checkbox' }) as HTMLInputElement;
    cb.checked = Boolean(f.value);
    const label = h('label', { class: 'chk-inline' }, cb, h('span', { text: f.placeholder ?? '' }));
    wrap.append(label);
    (cb as any).dataset.name = f.name;
    if (f.help) wrap.append(h('div', { class: 'field-help', text: f.help }));
    return wrap;
  } else {
    input = h('input', { ...common, type: f.type ?? 'text', placeholder: f.placeholder ?? '', min: f.min, max: f.max }) as HTMLInputElement;
    (input as HTMLInputElement).value = String(f.value ?? '');
  }
  (input as any).dataset.name = f.name;
  wrap.append(input);
  if (f.help) wrap.append(h('div', { class: 'field-help', text: f.help }));
  return wrap;
}

export function readForm(root: El): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  root.querySelectorAll<HTMLElement>('[data-name]').forEach((node) => {
    const name = (node as any).dataset.name!;
    if (node instanceof HTMLInputElement) {
      if (node.type === 'checkbox') out[name] = node.checked;
      else if (node.type === 'number') out[name] = node.value === '' ? null : Number(node.value);
      else out[name] = node.value;
    } else if (node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement) {
      out[name] = node.value;
    }
  });
  return out;
}

// ---------- data table with real pagination ----------
export interface ColDef<T> { label: string; render(row: T): Node | string; width?: string; align?: 'left' | 'right' | 'center' }
export interface PagedResult<T> { rows: T[]; total: number; page: number; pageSize: number; totalPages: number }

export function dataTable<T>(cols: ColDef<T>[], rows: T[], opts: { empty?: string; onRow?: (r: T) => void } = {}): El {
  if (!rows.length) {
    return h('div', { class: 'empty' }, h('div', { class: 'empty-title', text: opts.empty ?? 'No records yet' }));
  }
  const table = h('table', { class: 'tbl' });
  const thead = h('thead');
  const trh = h('tr');
  for (const c of cols) trh.append(h('th', { style: c.width ? `width:${c.width}` : '', class: c.align === 'right' ? 'r' : c.align === 'center' ? 'c' : '' }, c.label));
  thead.append(trh);
  const tbody = h('tbody');
  for (const r of rows) {
    const tr = h('tr', opts.onRow ? { class: 'row-click', onclick: () => opts.onRow!(r) } : {});
    for (const c of cols) {
      const td = h('td', { class: c.align === 'right' ? 'r' : c.align === 'center' ? 'c' : '' });
      td.append(c.render(r) as Node | string);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

export function pagerStrip<T>(res: PagedResult<T>, onPage: (p: number) => void): El {
  const strip = h('div', { class: 'pager' });
  const from = (res.page - 1) * res.pageSize + (res.rows.length ? 1 : 0);
  const to = (res.page - 1) * res.pageSize + res.rows.length;
  strip.append(h('span', { class: 'pager-info', text: `Showing ${from}–${to} of ${res.total}` }));
  const nav = h('span', { class: 'pager-nav' });
  const btn = (label: string, page: number, disabled: boolean, active = false) =>
    h('button', { class: `pager-btn${active ? ' active' : ''}`, disabled, onclick: () => onPage(page) }, label);
  nav.append(btn('‹ Prev', res.page - 1, res.page <= 1));
  for (let i = 1; i <= Math.min(res.totalPages, 7); i++) nav.append(btn(String(i), i, false, i === res.page));
  if (res.totalPages > 7) nav.append(h('span', { class: 'pager-info', text: `… ${res.totalPages}` }));
  nav.append(btn('Next ›', res.page + 1, res.page >= res.totalPages));
  strip.append(nav);
  return strip;
}

export function badge(kind: 'ok' | 'warn' | 'err' | 'info' | 'muted', text: string): El {
  return h('span', { class: `badge badge-${kind}`, text });
}
