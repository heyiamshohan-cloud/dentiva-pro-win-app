// Dashboard — live operational snapshot. Every figure comes from the DB; zero counters are baked in.
import { api } from '../api';
import { h, icon, taka, fmtDate, badge } from '../ui';
import { navigate } from '../app';

interface DashboardData {
  today: string;
  todayAppointments: { id: string; starts_at: string; ends_at: string; status: string; type: string; patient_name: string; patient_code: string }[];
  queue: { id: string; serial: number; status: string; patient_name: string; patient_code: string }[];
  waitingCount: number;
  collections: { todayPaisa: number; monthPaisa: number };
  outstanding: { invoiceCount: number; totalPaisa: number };
  recentPatients: { id: string; code: string; name: string; phone: string; created_at: string }[];
  followUps: { id: string; follow_up_date: string; patient_name: string; patient_code: string; patient_id: string }[];
  newPatientsMonth: number;
  lowStock: { id: string; name: string; qty_on_hand: number; reorder_level: number }[];
  expiries: { item_name?: string; name?: string; expiry_date: string; qty: number; batch_no?: string }[];
}

export async function dashboardScreen(): Promise<HTMLElement> {
  const d = await api<DashboardData>('dashboard.get');

  const stat = (label: string, value: string, sub: string, onClick?: () => void) =>
    h('div', { class: `stat-card${onClick ? ' stat-click' : ''}`, onclick: onClick },
      h('div', { class: 'stat-label', text: label }),
      h('div', { class: 'stat-value', text: value }),
      h('div', { class: 'stat-sub muted', text: sub }));

  const stats = h('div', { class: 'stat-grid' },
    stat("Today's appointments", String(d.todayAppointments.length), `${d.waitingCount} in queue`, () => navigate('/calendar')),
    stat('Collected today', taka(d.collections.todayPaisa), `This month: ${taka(d.collections.monthPaisa)}`, () => navigate('/billing')),
    stat('Outstanding', taka(d.outstanding.totalPaisa), `${d.outstanding.invoiceCount} invoice${d.outstanding.invoiceCount === 1 ? '' : 's'} unpaid`, () => navigate('/billing?outstanding=1')),
    stat('New patients this month', String(d.newPatientsMonth), 'Since the 1st', () => navigate('/patients')),
  );

  const apptList = h('div', { class: 'list' });
  if (!d.todayAppointments.length) apptList.append(h('div', { class: 'empty-title', text: 'No appointments today' }));
  for (const a of d.todayAppointments) {
    apptList.append(h('button', { class: 'list-row', onclick: () => navigate('/calendar') },
      h('span', { class: 'list-time', text: a.starts_at.slice(11, 16) }),
      h('span', { class: 'list-title', text: a.patient_name }),
      h('span', { class: 'muted', text: a.patient_code }),
      badge(a.status === 'completed' ? 'ok' : a.status === 'cancelled' || a.status === 'no_show' ? 'muted' : 'info', a.status.replace('_', ' ')),
    ));
  }

  const queueList = h('div', { class: 'list' });
  if (!d.queue.length) queueList.append(h('div', { class: 'empty-title', text: 'No one is waiting right now' }));
  for (const q of d.queue) {
    queueList.append(h('div', { class: 'list-row static' },
      h('span', { class: 'serial', text: `#${q.serial}` }),
      h('span', { class: 'list-title', text: q.patient_name }),
      badge(q.status === 'done' ? 'ok' : q.status === 'calling' ? 'warn' : q.status === 'skipped' ? 'muted' : 'info', q.status),
    ));
  }

  const lowStock = h('div', { class: 'list' });
  if (!d.lowStock.length) lowStock.append(h('div', { class: 'empty-title', text: 'All stock levels are healthy' }));
  for (const s of d.lowStock) {
    lowStock.append(h('button', { class: 'list-row', onclick: () => navigate('/inventory') },
      icon('inventory'),
      h('span', { class: 'list-title', text: s.name }),
      h('span', { class: 'muted', text: `${s.qty_on_hand} left · reorder at ${s.reorder_level}` }),
    ));
  }

  const followUps = h('div', { class: 'list' });
  if (!d.followUps.length) followUps.append(h('div', { class: 'empty-title', text: 'No follow-ups due' }));
  for (const f of d.followUps) {
    followUps.append(h('button', { class: 'list-row', onclick: () => navigate(`/patient?id=${f.patient_id}`) },
      h('span', { class: 'list-title', text: f.patient_name }),
      h('span', { class: 'muted', text: `${f.patient_code} · due ${fmtDate(f.follow_up_date)}` }),
    ));
  }

  const card = (title: string, iconName: string, body: HTMLElement, link?: () => void) =>
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', { class: 'card-title' }, icon(iconName), h('h2', { text: title })),
        link ? h('button', { class: 'btn-link', onclick: link }, 'View all') : ''
      ),
      body);

  const grid = h('div', { class: 'dash-grid' },
    card("Today's appointments", 'calendar', apptList, () => navigate('/calendar')),
    card('Queue', 'queue', queueList, () => navigate('/queue')),
    card('Follow-ups due', 'chart', followUps),
    card('Low stock & expiring soon', 'inventory', lowStock, () => navigate('/inventory')),
  );

  return h('div', { class: 'screen' },
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Dashboard' }), h('p', { class: 'muted', text: `Live view for ${fmtDate(d.today)}` })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-primary', onclick: () => navigate('/patients?new=1') }, h('span', {}, icon('add')), 'New patient'),
        h('button', { class: 'btn', onclick: () => navigate('/calendar?new=1') }, 'New appointment'),
      ),
    ),
    stats,
    grid,
  );
}
