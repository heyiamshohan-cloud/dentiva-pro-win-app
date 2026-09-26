// Dentiva Pro renderer — application shell: hash router, session, sidebar, topbar,
// global search (Ctrl+K), notifications, command palette.
import { api, apiRaw, currentUser, setSession, SessionUser, ApiError } from './api';
import { h, mount, icon, toast, modal, icons } from './ui';

export interface Route { hash: string; title: string; screen: HTMLElement }

const screens: Record<string, () => Promise<HTMLElement>> = {};
const navGroups: { label: string; items: { hash: string; label: string; icon: string; roles?: string[] }[] }[] = [];

export function registerScreen(hash: string, groupLabel: string, label: string, iconName: string, loader: () => Promise<HTMLElement>, roles?: string[]): void {
  screens[hash] = loader;
  let group = navGroups.find((g) => g.label === groupLabel);
  if (!group) { group = { label: groupLabel, items: [] }; navGroups.push(group); }
  group.items.push({ hash, label, icon: iconName, roles });
}

let mainEl: HTMLElement;
let shellEl: HTMLElement;
let currentHash = '';

export async function navigate(hash: string): Promise<void> {
  if (location.hash !== hash) location.hash = hash;
  else await renderCurrent();
}

export async function renderCurrent(): Promise<void> {
  const raw = location.hash.replace(/^#/, '') || '/dashboard';
  const base = raw.split('?')[0]!;
  const loader = screens[base] ?? screens['/dashboard'];
  if (!loader) return;
  currentHash = base;
  document.title = 'Dentiva Pro';
  // active nav state
  shellEl.querySelectorAll('.nav-link').forEach((n) => n.classList.toggle('active', (n as HTMLElement).dataset.hash === base));
  mount(mainEl, h('div', { class: 'screen-loading', text: 'Loading…' }));
  try {
    const el = await loader();
    mount(mainEl, el);
  } catch (e) {
    mount(mainEl, h('div', { class: 'screen-error' },
      h('div', { class: 'empty-title', text: 'This screen failed to load' }),
      h('p', { class: 'muted', text: (e as Error).message })));
  }
}

// ---------------- login ----------------
async function renderLogin(root: HTMLElement): Promise<void> {
  const status = await apiRaw('auth.status');
  const needsSetup = status.ok && (status.data as { needsSetup: boolean }).needsSetup;
  const remembered = await api<{ lastUsername: string }>('auth.status').catch(() => ({ lastUsername: '' }));

  const form = h('form', { class: 'login-form', onsubmit: async (e: Event) => {
    e.preventDefault();
    errBox.textContent = '';
    const username = (form.querySelector('[name=username]') as HTMLInputElement).value.trim();
    const password = (form.querySelector('[name=password]') as HTMLInputElement).value;
    if (!username || !password) { errBox.textContent = 'Enter your username and password'; return; }
    try {
      const r = await api<{ token: string; user: SessionUser }>('auth.login', { username, password });
      setSession(r.user, r.token);
      await enterApp();
    } catch (err) {
      errBox.textContent = (err as ApiError).message;
    }
  } });

  const errBox = h('div', { class: 'login-err', role: 'alert' });
  form.append(
    h('div', { class: 'login-field' }, h('label', { text: 'Username' }), h('input', { name: 'username', autocomplete: 'username', value: remembered.lastUsername ?? '' })),
    h('div', { class: 'login-field' }, h('label', { text: 'Password' }), h('input', { name: 'password', type: 'password', autocomplete: 'current-password' })),
    errBox,
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in'),
  );

  const card = h('div', { class: 'login-card' },
    h('div', { class: 'login-brand' },
      h('div', { class: 'login-logo' }, icon('chart')),
      h('h1', { text: 'Dentiva Pro' }),
      h('p', { class: 'muted', text: 'Sign in to your clinic workspace' }),
    ),
    form,
  );

  if (needsSetup) {
    // first-run setup: create admin + clinic
    const setupForm = h('form', { class: 'login-form', onsubmit: async (e: Event) => {
      e.preventDefault();
      const g = (n: string) => (setupForm.querySelector(`[name=${n}]`) as HTMLInputElement).value;
      const err2 = setupForm.querySelector('.login-err')!;
      err2.textContent = '';
      if (g('password') !== g('confirm')) { err2.textContent = 'Passwords do not match'; return; }
      try {
        await api('auth.setup', {
          clinicName: g('clinicName').trim(), adminDisplayName: g('displayName').trim(),
          username: g('username').trim(), password: g('password'), confirmPassword: g('confirm'),
        });
        const r = await api<{ token: string; user: SessionUser }>('auth.login', { username: g('username').trim(), password: g('password') });
        setSession(r.user, r.token);
        await enterApp();
      } catch (err) { err2.textContent = (err as ApiError).message; }
    } });
    setupForm.append(
      h('p', { class: 'setup-note', text: 'First run: create your clinic and the administrator account.' }),
      h('div', { class: 'login-field' }, h('label', { text: 'Clinic name' }), h('input', { name: 'clinicName', required: 'true' })),
      h('div', { class: 'login-field' }, h('label', { text: 'Your name (Administrator)' }), h('input', { name: 'displayName', required: 'true' })),
      h('div', { class: 'login-field' }, h('label', { text: 'Username' }), h('input', { name: 'username', autocomplete: 'username' })),
      h('div', { class: 'login-field' }, h('label', { text: 'Password (min 8 characters)' }), h('input', { name: 'password', type: 'password', autocomplete: 'new-password' })),
      h('div', { class: 'login-field' }, h('label', { text: 'Repeat password' }), h('input', { name: 'confirm', type: 'password', autocomplete: 'new-password' })),
      h('div', { class: 'login-err' }),
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create clinic & sign in'),
    );
    mount(card, h('div', { class: 'login-brand' }, h('div', { class: 'login-logo' }, icon('chart')), h('h1', { text: 'Welcome to Dentiva Pro' })), setupForm);
  }

  mount(root, h('div', { class: 'login-root' }, card));
}

// ---------------- shell ----------------
async function buildShell(root: HTMLElement): Promise<void> {
  const user = currentUser()!;
  const clinic = await api<{ clinicName?: string }>('settings.get').catch(() => ({ clinicName: undefined as string | undefined }));
  const clinicName = String(clinic.clinicName ?? 'Dentiva Pro');

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar-brand' },
      h('span', { class: 'brand-mark' }, icon('chart')),
      h('span', { class: 'brand-name', title: clinicName }, clinicName),
    ),
    h('div', { class: 'sidebar-search', role: 'button', onclick: openPalette, title: 'Search patients, invoices, commands (Ctrl+K)' },
      icon('search'), h('span', { class: 'muted', text: 'Search…' }), h('kbd', { text: 'Ctrl K' }),
    ),
    h('nav', { class: 'sidebar-nav' },
      ...navGroups.map((g) =>
        h('div', { class: 'nav-group' },
          h('div', { class: 'nav-group-label', text: g.label }),
          ...g.items
            .filter((it) => !it.roles || it.roles.includes(user.role))
            .map((it) => h('a', { class: 'nav-link', href: it.hash, 'data-hash': it.hash, title: it.label }, icon(it.icon), h('span', { text: it.label }))),
        ),
      ),
    ),
  );

  const notifBadge = h('span', { class: 'notif-badge hidden' });
  const notifBtn = h('button', { class: 'icon-btn topbar-btn', 'aria-label': 'Notifications', onclick: openNotifications }, icon('inbox'), notifBadge);

  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-clock muted', id: 'topbar-clock' }),
    h('div', { class: 'topbar-actions' },
      notifBtn,
      h('button', { class: 'user-chip', onclick: openUserMenu },
        h('span', { class: 'user-avatar', text: user.displayName.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() }),
        h('span', { class: 'user-meta' },
          h('span', { class: 'user-name', text: user.displayName }),
          h('span', { class: 'user-role muted', text: user.role === 'admin' ? 'Administrator' : user.role === 'dentist' ? 'Dentist' : 'Staff' }),
        ),
      ),
    ),
  );

  mainEl = h('main', { class: 'main' });
  shellEl = h('div', { class: 'shell' }, sidebar, h('div', { class: 'content-col' }, topbar, mainEl));
  mount(root, shellEl);

  updateClock();
  setInterval(updateClock, 30_000);
  refreshNotifBadge();
  setInterval(refreshNotifBadge, 60_000);
  window.addEventListener('hashchange', renderCurrent);
}

function updateClock(): void {
  const el = document.getElementById('topbar-clock');
  if (el) el.textContent = new Date().toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function refreshNotifBadge(): Promise<void> {
  const badge = shellEl?.querySelector('.notif-badge') as HTMLElement | null;
  if (!badge) return;
  try {
    const n = await api<number>('notifications.unreadCount');
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', n === 0);
  } catch { /* ignore */ }
}

function openNotifications(): void {
  modal('Notifications', (close) => {
    const body = h('div', { class: 'notif-list' }, h('div', { class: 'muted', text: 'Loading…' }));
    (async () => {
      try {
        const res = await api<{ rows: { id: string; title: string; body: string; created_at: string; read_at: string | null }[] }>('notifications.list', { page: 1, pageSize: 50 });
        mount(body, ...(res.rows.length
          ? res.rows.map((n) => h('div', { class: `notif-item${n.read_at ? '' : ' unread'}`, onclick: async () => { await api('notifications.markRead', { ids: [n.id] }); refreshNotifBadge(); } },
              h('div', { class: 'notif-title', text: n.title }),
              h('div', { class: 'notif-body', text: n.body }),
              h('div', { class: 'notif-date muted', text: n.created_at.slice(0, 16).replace('T', ' ') })))
          : [h('div', { class: 'empty-title', text: 'No notifications' })]));
        renderCurrent();
      } catch (e) { mount(body, h('div', { class: 'empty-title', text: (e as Error).message })); }
    })();
    const footer = h('div', { class: 'btn-row end' },
      h('button', { class: 'btn', onclick: async () => { await api('notifications.refresh'); toast('ok', 'Checked for new reminders'); renderCurrent(); } }, 'Check now'),
      h('button', { class: 'btn', onclick: close }, 'Close'),
    );
    return h('div', {}, body, footer);
  });
}

function openUserMenu(): void {
  const user = currentUser()!;
  modal(user.displayName, (close) => {
    const wrap = h('div', { class: 'user-menu' },
      h('p', { class: 'muted', text: `Signed in as ${user.username} · ${user.role}` }),
    );
    const row = h('div', { class: 'col-gap' });
    row.append(h('button', { class: 'btn', onclick: async () => {
      close(); openChangePassword();
    } }, 'Change password'));
    row.append(h('button', { class: 'btn btn-danger', onclick: async () => {
      await api('auth.logout').catch(() => undefined);
      setSession(null, null);
      window.location.reload();
    } }, 'Sign out'));
    wrap.append(row);
    return wrap;
  });
}

function openChangePassword(): void {
  modal('Change password', (close) => {
    const form = h('form', { class: 'col-gap', onsubmit: async (e: Event) => {
      e.preventDefault();
      const g = (n: string) => (form.querySelector(`[name=${n}]`) as HTMLInputElement).value;
      try {
        await api('auth.changePassword', { currentPassword: g('oldpw'), newPassword: g('newpw') });
        toast('ok', 'Password changed');
        close();
      } catch (err) { (form.querySelector('.login-err')!).textContent = (err as Error).message; }
    } });
    form.append(
      h('div', { class: 'login-field' }, h('label', { text: 'Current password' }), h('input', { name: 'oldpw', type: 'password' })),
      h('div', { class: 'login-field' }, h('label', { text: 'New password (min 8)' }), h('input', { name: 'newpw', type: 'password' })),
      h('div', { class: 'login-field' }, h('label', { text: 'Repeat new password' }), h('input', { name: 'confirm', type: 'password' })),
      h('div', { class: 'login-err' }),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Update password'),
    );
    return form;
  });
}

// ---------------- command palette ----------------
function paletteCommands(): { icon: string; label: string; hint: string; run: () => void }[] {
  const user = currentUser();
  const cmds = [
    { icon: 'dashboard', label: 'Go to Dashboard', hint: 'home', run: () => navigate('/dashboard') },
    { icon: 'patients', label: 'New patient', hint: 'register intake', run: () => navigate('/patients?new=1') },
    { icon: 'calendar', label: 'New appointment', hint: 'schedule booking', run: () => navigate('/calendar?new=1') },
    { icon: 'queue', label: "Today's queue", hint: 'check-in waiting room', run: () => navigate('/queue') },
    { icon: 'invoice', label: 'New invoice', hint: 'billing charge', run: () => navigate('/billing?new=1') },
    { icon: 'money', label: 'Record payment', hint: 'receipt cash bkash', run: () => navigate('/billing?pay=1') },
  ];
  if (user?.role === 'admin') {
    cmds.push(
      { icon: 'settings', label: 'Clinic settings', hint: 'configure', run: () => navigate('/settings') },
      { icon: 'users', label: 'Staff & permissions', hint: 'users roles', run: () => navigate('/users') },
      { icon: 'backup', label: 'Backup & restore', hint: 'safety snapshot', run: () => navigate('/backup') },
    );
  }
  return cmds;
}

function openPalette(): void {
  const wrap = h('div', { class: 'palette-wrap' });
  const input = h('input', { class: 'palette-input', placeholder: 'Search patients, invoices, or type a command…', autocomplete: 'off' });
  const results = h('div', { class: 'palette-results' });
  let timer = 0;
  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const q = input.value.trim();
      mount(results, h('div', { class: 'muted pad', text: q ? 'Searching…' : '' }));
      try {
        if (!q) {
          mount(results, ...paletteCommands().map((c) =>
            h('button', { class: 'palette-row', onclick: () => { close(); c.run(); } }, icon(c.icon), h('span', { class: 'palette-label', text: c.label }), h('span', { class: 'muted palette-hint', text: c.hint }))));
          return;
        }
        const groups = await api<{ kind: string; total: number; rows: { id: string; label: string; sub: string; route: string }[] }[]>('search.global', { q, limitPerGroup: 12 });
        const cmdMatches = paletteCommands().filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(q.toLowerCase()));
        const rows: HTMLElement[] = [];
        for (const g of groups) {
          rows.push(h('div', { class: 'palette-group-label', text: `${g.kind} (${g.total})` }));
          for (const r of g.rows) rows.push(h('button', { class: 'palette-row', onclick: () => { close(); navigate(r.route); } },
            icon(g.kind === 'patients' ? 'patients' : g.kind === 'invoices' ? 'invoice' : 'inventory'),
            h('span', { class: 'palette-label', text: r.label }), h('span', { class: 'muted palette-hint', text: r.sub })));
        }
        for (const c of cmdMatches) rows.push(h('button', { class: 'palette-row', onclick: () => { close(); c.run(); } }, icon(c.icon), h('span', { class: 'palette-label', text: c.label })));
        mount(results, ...(rows.length ? rows : [h('div', { class: 'muted pad', text: `No matches for “${q}”` })]));
      } catch (err) { mount(results, h('div', { class: 'muted pad', text: (err as Error).message })); }
    }, 160);
  });
  wrap.append(input, results);
  mount(results, h('div', { class: 'muted pad', text: 'Type to search…' }));
  const close = modal('', () => wrap, { wide: true });
  document.querySelector('.modal')?.classList.add('modal-palette');
  input.focus();
}

export function wireGlobalShortcuts(): void {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  });
}

async function enterApp(): Promise<void> {
  try { await api('notifications.refresh'); } catch { /* non-fatal */ }
  await buildShell(document.getElementById('app')!);
  wireGlobalShortcuts();
  if (!location.hash) location.hash = '/dashboard';
  await renderCurrent();
}

// boot
export async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  try {
    const status = await api<{ needsSetup: boolean; user: SessionUser | null }>('auth.status');
    if (status.user && window.dentiva.getToken()) { setSession(status.user, window.dentiva.getToken()); await enterApp(); return; }
  } catch { /* fall through to login */ }
  await renderLogin(root);
}
