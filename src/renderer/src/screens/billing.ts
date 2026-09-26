// Billing — invoices (create/finalize/void), payments (record/refund), statements, printing.
// All figures are integer paisa server-side; the UI only formats.
import { api, hasRole, ApiError } from '../api';
import { h, mount, icon, toast, modal, field, readForm, dataTable, pagerStrip, badge, fmtDate, taka, todayStr, confirmDialog, PagedResult, El } from '../ui';
import { navigate } from '../app';

interface InvoiceRow {
  id: string; invoice_no: string; patient_id: string; patient_name?: string;
  date: string; status: string; subtotal_paisa: number; discount_paisa: number;
  tax_bp: number; tax_paisa: number; total_paisa: number; paid_paisa: number; due_paisa?: number;
}
interface InvoiceDetail extends InvoiceRow {
  items: { id: string; description: string; tooth: number | null; qty: number; unit_price_paisa: number; discount_paisa: number; line_total_paisa: number }[];
  payments: { id: string; receipt_no: string; date: string; method: string; amount_paisa: number; direction: string }[];
  patient: { name: string; code: string; phone?: string };
}
interface InvoicePage extends PagedResult<InvoiceRow> { }

export async function billingScreen(q: URLSearchParams): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  const state = { page: 1, pageSize: 25, outstanding: q.get('outstanding') === '1', patientId: '' };

  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h1', { text: 'Billing' }), h('p', { class: 'muted', text: 'Invoices, payments and deposits' })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: openStatementPicker }, 'Patient statement'),
      h('button', { class: 'btn btn-primary', onclick: () => openCreateInvoice() }, h('span', {}, icon('add')), 'New invoice'),
    ));

  const filterBar = h('div', { class: 'btn-row align-center' },
    h('label', { class: 'chk-inline' },
      h('input', { type: 'checkbox', checked: state.outstanding, onchange: (e: Event) => { state.outstanding = (e.target as HTMLInputElement).checked; state.page = 1; void load(); } }),
      h('span', { text: 'Show only unpaid' })),
  );
  const listHost = h('div', { class: 'card-host' });

  async function load(): Promise<void> {
    try {
      const res = await api<InvoicePage>('invoices.list', { page: state.page, pageSize: state.pageSize, status: state.outstanding ? 'unpaid' : undefined, q: '' });
      mount(listHost,
        dataTable<InvoiceRow>([
          { label: 'Invoice', render: (r) => h('span', { class: 'mono', text: r.invoice_no }), width: '140px' },
          { label: 'Patient', render: (r) => h('span', { class: 'primary-cell', text: r.patient_name ?? '—' }) },
          { label: 'Date', render: (r) => fmtDate(r.date), width: '120px' },
          { label: 'Total', align: 'right', render: (r) => taka(r.total_paisa) },
          { label: 'Paid', align: 'right', render: (r) => taka(r.paid_paisa) },
          {
            label: 'Status', width: '110px', render: (r) => {
              if (r.status === 'voided') return badge('muted', 'voided');
              if (r.status === 'draft') return badge('info', 'draft');
              const due = r.total_paisa - r.paid_paisa;
              return due <= 0 ? badge('ok', 'paid') : r.paid_paisa > 0 ? badge('warn', 'partial') : badge('err', 'unpaid');
            },
          },
        ], res.rows, { empty: state.outstanding ? 'No unpaid invoices' : 'No invoices issued yet', onRow: (r) => navigate(`/invoice?id=${r.id}`) }),
        pagerStrip(res, (p) => { state.page = p; void load(); }));
    } catch (e) {
      mount(listHost, h('div', { class: 'empty-title', text: (e as Error).message }));
    }
  }

  async function openStatementPicker(): Promise<void> {
    const { patientPickerModal } = await import('../widgets');
    patientPickerModal(async (p) => {
      const stmt = await api<{ lines: { date: string; kind: string; ref: string; description: string; debitPaisa: number; creditPaisa: number; balancePaisa: number }[]; openingPaisa: number; closingPaisa: number }>(
        'statements.patient', { patientId: p.id });
      type Line = (typeof stmt.lines)[number];
      modal(`Account statement — ${p.name}`, () => h('div', { class: 'col-gap' },
        stmt.openingPaisa ? h('div', { class: 'btn-row end muted', text: `Opening balance: ${taka(stmt.openingPaisa)}` }) : '',
        dataTable(
          [
            { label: 'Date', render: (e: Line) => fmtDate(e.date) },
            { label: 'Entry', render: (e: Line) => `${e.kind} · ${e.ref}` },
            { label: 'Description', render: (e: Line) => e.description || '—' },
            { label: 'Debit', align: 'right' as const, render: (e: Line) => e.debitPaisa ? taka(e.debitPaisa) : '—' },
            { label: 'Credit', align: 'right' as const, render: (e: Line) => e.creditPaisa ? taka(e.creditPaisa) : '—' },
            { label: 'Balance', align: 'right' as const, render: (e: Line) => h('strong', { text: taka(e.balancePaisa) }) },
          ],
          stmt.lines,
          { empty: 'No account activity' },
        ),
        h('div', { class: 'btn-row end' }, h('strong', { text: `Closing balance: ${taka(stmt.closingPaisa)}` })),
      ), { wide: true });
    });
  }

  async function openCreateInvoice(presetPatientId?: string): Promise<void> {
    interface Txn { id: string; name: string; price_paisa: number }
    let txns: Txn[] = [];
    const rows = await api<{ rows: Txn[] }>('treatments.list', { page: 1, pageSize: 500, q: '', category: '', includeInactive: false });
    txns = rows.rows;
    let picked: { id: string; name: string } | null = presetPatientId ? { id: presetPatientId, name: '' } : null;
    const lines: { itemType: string; refId: string | null; description: string; tooth: number | null; qty: number; unitPricePaisa: number; discountPaisa: number }[] = [];
    const linesHost = h('div', { class: 'list' });
    const totalsBox = h('div', { class: 'invoice-totals' });

    function totals(): { sub: number; disc: number; taxBp: number; tax: number; total: number } {
      const sub = lines.reduce((a, l) => a + l.qty * l.unitPricePaisa - l.discountPaisa, 0);
      const extraDisc = Math.max(0, numVal(totalsBox.querySelector('[data-name=discount]') as HTMLInputElement)) * 100;
      const taxBp = Math.max(0, numVal(totalsBox.querySelector('[data-name=taxPct]') as HTMLInputElement)) * 100; // percent → bps
      const taxable = sub - extraDisc;
      const tax = taxable > 0 ? Math.round((taxable * taxBp) / 10000) : 0;
      return { sub, disc: extraDisc, taxBp, tax, total: taxable + tax };
    }
    function numVal(el: HTMLInputElement | null): number { const n = Number(el?.value ?? 0); return Number.isFinite(n) ? n : 0; }

    function renderLines(): void {
      const t = totals();
      mount(linesHost, ...(lines.length
        ? lines.map((l, i) => h('div', { class: 'list-row static' },
            h('span', { class: 'list-title', text: `${l.description}` }),
            h('span', { class: 'muted', text: `${l.tooth ? `Tooth ${l.tooth} · ` : ''}${l.qty} × ${taka(l.unitPricePaisa)}` }),
            h('span', { class: 'money', text: taka(l.qty * l.unitPricePaisa - l.discountPaisa) }),
            h('button', { class: 'btn-link danger', onclick: () => { lines.splice(i, 1); renderLines(); } }, 'Remove')))
        : [h('div', { class: 'empty-title', text: 'No billable items yet' })]));
      totalsBox.querySelector('[data-calc=total]')!.textContent =
        `Subtotal ${taka(t.sub)}  −  Discount ${taka(t.disc)}  +  Tax ${taka(t.tax)}  =  ${taka(t.total)}`;
    }

    modal('New invoice', (close) => {
      const pick = h('div', { class: 'field' },
        h('label', { class: 'field-label' }, 'Patient'),
        h('button', {
          class: 'btn', onclick: async () => {
            const { patientPickerModal } = await import('../widgets');
            patientPickerModal((p) => { picked = p; (pick.querySelector('.picked') as HTMLElement).textContent = p.name; });
          },
        }, 'Choose patient'),
        h('span', { class: 'picked muted' }));
      const addForm = h('div', { class: 'form-grid' },
        field({ name: 'service', label: 'Service', type: 'select', options: [{ value: '', label: 'Custom line…' }, ...txns.map((t) => ({ value: t.id, label: `${t.name} · ${taka(t.price_paisa)}` }))] }),
        field({ name: 'custom', label: 'Custom description', placeholder: 'e.g. Consultation fee' }),
        field({ name: 'qty', label: 'Qty', type: 'number', value: 1, min: 1, max: 1000 }),
        field({ name: 'price', label: 'Unit price (Tk)', type: 'number', min: 0 }),
        field({ name: 'tooth', label: 'Tooth (FDI, optional)', type: 'number' }),
      );
      totalsBox.append(
        h('div', { class: 'form-grid narrow' },
          field({ name: 'discount', label: 'Discount (Tk)', type: 'number', value: 0, min: 0 }),
          field({ name: 'taxPct', label: 'Tax %', type: 'number', value: 0, min: 0, max: 100 }),
        ),
        h('div', { class: 'invoice-total-line', 'data-calc': 'total' }),
      );
      totalsBox.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', renderLines));
      const err2 = h('div', { class: 'login-err' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn', onclick: () => save(false) }, 'Save draft'),
        h('button', { class: 'btn btn-primary', onclick: () => save(true) }, 'Finalize invoice'));
      async function save(finalize: boolean): Promise<void> {
        err2.textContent = '';
        if (!picked) { err2.textContent = 'Choose a patient'; return; }
        if (!lines.length) { err2.textContent = 'Add at least one line item'; return; }
        const t = totals();
        try {
          const inv = await api<{ id: string }>('invoices.create', {
            patientId: (picked as { id: string }).id, visitId: null, lines,
            discountPaisa: t.disc, taxBp: t.taxBp, notes: '', finalize,
          });
          toast('ok', finalize ? 'Invoice finalized' : 'Draft saved');
          close();
          navigate(`/invoice?id=${inv.id}`);
        } catch (e) { err2.textContent = (e as ApiError).message; }
      }
      const addBtn = h('button', {
        class: 'btn', onclick: () => {
          const v = readForm(addForm);
          const sel = txns.find((t) => t.id === v.service);
          const isCustom = !sel;
          const desc = isCustom ? String(v.custom ?? '').trim() : sel!.name;
          if (!desc) { toast('err', 'Describe the line or pick a service'); return; }
          const priceTk = Number(v.price ?? NaN);
          const unitPricePaisa = Number.isFinite(priceTk) && v.price !== null ? Math.round(priceTk * 100) : (sel?.price_paisa ?? 0);
          lines.push({
            itemType: sel ? 'service' : 'custom', refId: sel?.id ?? null, description: desc,
            tooth: v.tooth ? Number(v.tooth) : null, qty: Math.max(1, Number(v.qty ?? 1)),
            unitPricePaisa, discountPaisa: 0,
          });
          renderLines();
        },
      }, '＋ Add line');
      renderLines();
      return h('div', { class: 'col-gap' }, pick, addForm, addBtn, linesHost, totalsBox, err2, row);
    }, { wide: true });
  }

  root.append(head, filterBar, listHost);
  if (q.get('new') === '1') setTimeout(() => void openCreateInvoice(), 50);
  await load();
  return root;
}

// ---------------- invoice detail ----------------
export async function invoiceScreen(q: URLSearchParams): Promise<HTMLElement> {
  const id = q.get('id')!;
  const inv = await api<InvoiceDetail>('invoices.get', { id });
  const root = h('div', { class: 'screen' });
  const due = inv.status === 'final' ? inv.total_paisa - inv.paid_paisa : 0;

  const head = h('div', { class: 'page-head' },
    h('div', { class: 'btn-row align-center gap' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => history.back() }, icon('arrowLeft')),
      h('div', {},
        h('h1', { text: inv.invoice_no }),
        h('p', { class: 'muted', text: `${inv.patient?.name ?? ''} · ${fmtDate(inv.date)}` })),
    ),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => void printInvoice(inv.id) }, h('span', {}, icon('print')), 'Print'),
      due > 0 ? h('button', { class: 'btn btn-primary', onclick: openPayment }, 'Record payment') : '',
      hasRole('admin') && inv.status !== 'voided' ? h('button', { class: 'btn btn-danger', onclick: openVoid }, 'Void') : '',
    ));

  const summary = h('div', { class: 'stat-grid four' },
    h('div', { class: 'stat-card' }, h('div', { class: 'stat-label', text: 'Total' }), h('div', { class: 'stat-value', text: taka(inv.total_paisa) })),
    h('div', { class: 'stat-card' }, h('div', { class: 'stat-label', text: 'Paid' }), h('div', { class: 'stat-value', text: taka(inv.paid_paisa) })),
    h('div', { class: 'stat-card' }, h('div', { class: 'stat-label', text: 'Due' }), h('div', { class: 'stat-value' + (due > 0 ? ' danger' : ''), text: taka(due) })),
    h('div', { class: 'stat-card' }, h('div', { class: 'stat-label', text: 'Status' }), h('div', { class: 'stat-value' }, inv.status === 'voided' ? badge('muted', 'voided') : due <= 0 && inv.status === 'final' ? badge('ok', 'paid') : badge('warn', inv.status === 'draft' ? 'draft' : 'open'))));

  const items = dataTable(
    [
      { label: 'Service / product', render: (it: InvoiceDetail['items'][number]) => h('span', { class: 'primary-cell', text: it.description }) },
      { label: 'Tooth', render: (it: InvoiceDetail['items'][number]) => it.tooth ? String(it.tooth) : '—', width: '70px' },
      { label: 'Qty', align: 'right' as const, render: (it: InvoiceDetail['items'][number]) => String(it.qty), width: '60px' },
      { label: 'Unit price', align: 'right' as const, render: (it: InvoiceDetail['items'][number]) => taka(it.unit_price_paisa) },
      { label: 'Discount', align: 'right' as const, render: (it: InvoiceDetail['items'][number]) => it.discount_paisa ? taka(it.discount_paisa) : '—' },
      { label: 'Line total', align: 'right' as const, render: (it: InvoiceDetail['items'][number]) => h('strong', { text: taka(it.line_total_paisa) }) },
    ],
    inv.items,
  );

  const totalsBlock = h('div', { class: 'invoice-totals-list' },
    h('div', { class: 'total-row' }, h('span', { text: 'Subtotal' }), h('span', { text: taka(inv.subtotal_paisa) })),
    inv.discount_paisa ? h('div', { class: 'total-row' }, h('span', { text: 'Discount' }), h('span', { text: `− ${taka(inv.discount_paisa)}` })) : '',
    inv.tax_paisa ? h('div', { class: 'total-row' }, h('span', { text: `Tax (${(inv.tax_bp / 100).toFixed(2)}%)` }), h('span', { text: taka(inv.tax_paisa) })) : '',
    h('div', { class: 'total-row grand' }, h('span', { text: 'Total' }), h('span', { text: taka(inv.total_paisa) })),
  );

  const payments = dataTable(
    [
      { label: 'Receipt', render: (p: InvoiceDetail['payments'][number]) => h('span', { class: 'mono', text: p.receipt_no }) },
      { label: 'Date', render: (p: InvoiceDetail['payments'][number]) => fmtDate(p.date, true) },
      { label: 'Method', render: (p: InvoiceDetail['payments'][number]) => p.method },
      { label: 'Amount', align: 'right' as const, render: (p: InvoiceDetail['payments'][number]) => `${p.direction === 'refund' ? '− ' : ''}${taka(p.amount_paisa)}` },
      {
        label: '', align: 'right' as const, render: (p: InvoiceDetail['payments'][number]) => hasRole('admin') && p.direction === 'payment'
          ? h('button', { class: 'btn-link danger', onclick: () => void refundPayment(p) }, 'Refund') : '',
      },
    ],
    inv.payments,
    { empty: 'No payments recorded' },
  );

  async function printInvoice(invId: string): Promise<void> {
    const r = await api<{ path: string; pageCount: number }>('docs.generate', { kind: 'invoice', id: invId });
    toast('ok', `PDF generated (${r.pageCount} page${r.pageCount === 1 ? '' : 's'})`);
  }
  function openPayment(): void {
    modal(`Record payment · ${inv.invoice_no}`, (close) => {
      const form = h('div', { class: 'form-grid' },
        field({ name: 'amount', label: `Amount (Tk) · due ${taka(due)}`, type: 'number', value: (due / 100).toFixed(2), min: 0 }),
        field({ name: 'method', label: 'Method', type: 'select', options: ['cash', 'bkash', 'nagad', 'rocket', 'upay', 'bank', 'card'] }),
        field({ name: 'reference', label: 'Reference (Txn id / cheque)', type: 'text' }),
        field({ name: 'notes', label: 'Note', type: 'text' }),
      );
      const err2 = h('div', { class: 'login-err' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            const v = readForm(form);
            const tk = Number(v.amount);
            if (!(tk > 0)) { err2.textContent = 'Amount must be positive'; return; }
            try {
              await api('payments.create', {
                patientId: inv.patient_id, invoiceId: inv.id, amountPaisa: Math.round(tk * 100),
                method: String(v.method), reference: String(v.reference ?? ''), notes: String(v.notes ?? ''),
                idempotencyKey: `pay-${inv.id}-${Date.now()}`,
              });
              toast('ok', 'Payment recorded'); close(); location.reload();
            } catch (e) {
              err2.textContent = (e as ApiError).message;
            }
          },
        }, 'Record'),
      );
      return h('div', {}, form, err2, row);
    });
  }
  async function openVoid(): Promise<void> {
    modal(`Void ${inv.invoice_no}`, (close) => {
      const form = h('div', { class: 'col-gap' },
        h('p', { class: 'warn-text', text: 'Voiding locks the invoice. This cannot be undone; paid amounts must be refunded first.' }),
        field({ name: 'reason', label: 'Reason', type: 'textarea', rows: 2 }),
      );
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-danger', onclick: async () => {
            const v = readForm(form);
            if (!String(v.reason ?? '').trim()) { toast('err', 'Reason is required'); return; }
            try {
              await api('invoices.void', { id: inv.id, reason: String(v.reason) });
              toast('ok', 'Invoice voided'); close(); location.reload();
            } catch (e) { toast('err', (e as Error).message); }
          },
        }, 'Void invoice'));
      return h('div', {}, form, row);
    });
  }
  async function refundPayment(p: InvoiceDetail['payments'][number]): Promise<void> {
    const okTo = await confirmDialog('Refund payment', `Refund ${taka(p.amount_paisa)} (receipt ${p.receipt_no})? A refund entry will be recorded.`, 'Refund');
    if (!okTo) return;
    try {
      await api('payments.refund', { patientId: inv.patient_id, originalPaymentId: p.id, amountPaisa: p.amount_paisa, method: p.method === 'cash' ? 'cash' : p.method, reason: 'Customer refund' });
      toast('ok', 'Refunded');
      location.reload();
    } catch (e) { toast('err', (e as Error).message); }
  }

  root.append(head, summary,
    h('section', { class: 'card' }, h('div', { class: 'card-title' }, h('h3', { text: 'Line items' })), items, totalsBlock),
    h('section', { class: 'card' }, h('div', { class: 'card-title' }, h('h3', { text: 'Payments' })), payments),
  );
  return root;
}
