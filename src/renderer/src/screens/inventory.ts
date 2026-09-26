// Inventory — items, stock movements, low-stock, expiring lots, purchases, suppliers.
import { api, hasRole, ApiError } from '../api';
import { h, mount, icon, toast, modal, field, readForm, dataTable, pagerStrip, badge, fmtDate, taka, PagedResult } from '../ui';

interface ItemRow {
  id: string; sku: string; name: string; category: string; unit: string;
  qty_on_hand: number; reorder_level: number;
  purchase_price_paisa: number; sale_price_paisa: number; notes: string; active: number;
}
interface SupplierRow { id: string; name: string; phone: string; email: string; address: string; notes: string }
interface MovementRow {
  id: string; created_at: string; kind: string; qty_delta: number; reason: string; batch_no: string; item_name?: string;
}
interface ExpiryRow { id: string; sku: string; name: string; batch_no: string; expiry_date: string; remaining: number }
interface PurchaseRow { id: string; po_no: string; supplier_name?: string | null; date: string; total_paisa: number; paid_paisa: number }

const SECTIONS = [
  { id: 'stock', label: 'Stock on hand' },
  { id: 'movements', label: 'Movements' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'purchases', label: 'Purchases' },
  { id: 'suppliers', label: 'Suppliers' },
] as const;

export async function inventoryScreen(): Promise<HTMLElement> {
  const root = h('div', { class: 'screen' });
  let section: (typeof SECTIONS)[number]['id'] = 'stock';
  const tabBar = h('div', { class: 'tab-bar' });
  const content = h('div', { class: 'card-host' });
  for (const s of SECTIONS) {
    tabBar.append(h('button', {
      class: `tab-btn${s.id === section ? ' active' : ''}`, 'data-s': s.id,
      onclick: () => { section = s.id; tabBar.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.s === s.id)); void render(); },
    }, s.label));
  }
  async function render(): Promise<void> {
    mount(content, h('div', { class: 'screen-loading', text: 'Loading…' }));
    try {
      if (section === 'stock') mount(content, await stockSection());
      else if (section === 'movements') mount(content, await movementsSection());
      else if (section === 'alerts') mount(content, await alertsSection());
      else if (section === 'purchases') mount(content, await purchasesSection());
      else mount(content, await suppliersSection());
    } catch (e) {
      mount(content, h('div', { class: 'empty-title', text: (e as Error).message }));
    }
  }
  root.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Inventory' }), h('p', { class: 'muted', text: 'Clinic supplies and materials' })),
      hasRole('admin') ? h('button', { class: 'btn btn-primary', onclick: () => void openNewItem() }, h('span', {}, icon('add')), 'New item') : ''),
    tabBar, content);
  await render();
  return root;

  // ---------- items ----------
  async function stockSection(): Promise<HTMLElement> {
    const state = { page: 1, pageSize: 25, q: '' };
    const host = h('div', { class: 'col-gap' });
    const search = h('input', { class: 'search-input', placeholder: 'Search SKU or name…' });
    let t = 0;
    search.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(() => { state.q = search.value.trim(); state.page = 1; void load(); }, 220); });
    const listHost = h('div');
    async function load(): Promise<void> {
      const res = await api<PagedResult<ItemRow>>('inventory.list', { page: state.page, pageSize: state.pageSize, q: state.q });
      mount(listHost,
        dataTable<ItemRow>([
          { label: 'SKU', render: (r) => h('span', { class: 'mono', text: r.sku }), width: '130px' },
          { label: 'Item', render: (r) => h('span', { class: 'primary-cell', text: r.name }) },
          { label: 'On hand', align: 'right', render: (r) => `${r.qty_on_hand} ${r.unit}` },
          { label: 'Reorder at', align: 'right', render: (r) => String(r.reorder_level), width: '100px' },
          { label: 'Unit cost', align: 'right', render: (r) => taka(r.purchase_price_paisa) },
          {
            label: '', align: 'right', render: (r) => h('div', { class: 'btn-row end' },
              h('button', { class: 'btn-link', onclick: () => openAdjust(r) }, 'Adjust'),
              hasRole('admin') ? h('button', { class: 'btn-link', onclick: () => openEditItem(r) }, 'Edit') : ''),
          },
        ], res.rows, { empty: state.q ? `No items match “${state.q}”` : 'No items yet' }),
        pagerStrip(res, (p) => { state.page = p; void load(); }));
    }
    host.append(search, listHost);
    await load();
    return host;
  }

  function itemForm(r?: ItemRow): { form: HTMLElement; err2: HTMLElement } {
    const form = h('div', { class: 'form-grid' },
      field({ name: 'sku', label: 'SKU', required: true, value: r?.sku ?? '' }),
      field({ name: 'name', label: 'Name', required: true, value: r?.name ?? '' }),
      field({ name: 'category', label: 'Category', value: r?.category ?? 'Consumable' }),
      field({ name: 'unit', label: 'Unit', value: r?.unit ?? 'pcs' }),
      field({ name: 'purchasePrice', label: 'Purchase price (Tk)', type: 'number', min: 0, value: r ? (r.purchase_price_paisa / 100).toFixed(2) : '' }),
      field({ name: 'salePrice', label: 'Sale price (Tk)', type: 'number', min: 0, value: r ? (r.sale_price_paisa / 100).toFixed(2) : '' }),
      field({ name: 'reorderLevel', label: 'Reorder level', type: 'number', min: 0, value: r?.reorder_level ?? 0 }),
      field({ name: 'notes', label: 'Notes', value: r?.notes ?? '' }),
    );
    const err2 = h('div', { class: 'login-err' });
    return { form, err2 };
  }
  function itemPayload(form: HTMLElement): Record<string, unknown> {
    const v = readForm(form);
    return {
      sku: String(v.sku ?? '').trim(), name: String(v.name ?? '').trim(),
      category: String(v.category ?? 'General'), unit: String(v.unit ?? 'pcs'),
      supplierId: null,
      purchasePricePaisa: moneyToPaisa(v.purchasePrice), salePricePaisa: moneyToPaisa(v.salePrice),
      reorderLevel: Math.max(0, Number(v.reorderLevel ?? 0) || 0), notes: String(v.notes ?? ''), active: true,
    };
  }
  function openNewItem(): void {
    modal('New inventory item', (close) => {
      const { form, err2 } = itemForm();
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            try {
              await api('inventory.create', itemPayload(form));
              toast('ok', 'Item created'); close(); void render();
            } catch (e) { err2.textContent = (e as ApiError).message; }
          },
        }, 'Save'));
      return h('div', {}, form, err2, row);
    }, { wide: true });
  }
  function openEditItem(r: ItemRow): void {
    modal(`Edit ${r.name}`, (close) => {
      const { form, err2 } = itemForm(r);
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            try {
              await api('inventory.update', { ...itemPayload(form), id: r.id, active: !!r.active });
              toast('ok', 'Updated'); close(); void render();
            } catch (e) { err2.textContent = (e as ApiError).message; }
          },
        }, 'Save'));
      return h('div', {}, form, err2, row);
    });
  }
  function openAdjust(r: ItemRow): void {
    modal(`Adjust ${r.name}`, (close) => {
      const form = h('div', { class: 'form-grid' },
        field({ name: 'kind', label: 'Movement kind', type: 'select', options: [
          { value: 'use', label: 'Used in treatment (−)' },
          { value: 'waste', label: 'Wasted / damaged (−)' },
          { value: 'adjust', label: 'Manual correction (+/−)' },
          { value: 'return', label: 'Returned to supplier (−)' },
          { value: 'sale', label: 'Sold to patient (−)' },
        ] }),
        field({ name: 'delta', label: 'Quantity change (negative to reduce)', type: 'number', value: -1 }),
        field({ name: 'reason', label: 'Reason', required: true, placeholder: 'e.g. Used in root canal' }),
        field({ name: 'batchNo', label: 'Lot / batch # (optional)', value: '' }),
      );
      const err2 = h('div', { class: 'login-err' });
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            const v = readForm(form);
            const delta = Number(v.delta ?? 0);
            if (!Number.isInteger(delta) || delta === 0) { err2.textContent = 'Quantity change must be a non-zero integer'; return; }
            const kind = String(v.kind ?? 'adjust');
            if (kind !== 'adjust' && delta > 0) { err2.textContent = `“${kind}” movements reduce stock — enter a negative quantity`; return; }
            if (!String(v.reason ?? '').trim()) { err2.textContent = 'Reason required'; return; }
            try {
              await api('inventory.adjust', { itemId: r.id, kind, qtyDelta: delta, reason: String(v.reason).trim(), batchNo: String(v.batchNo ?? ''), expiryDate: null });
              toast('ok', 'Stock updated'); close(); void render();
            } catch (e) { err2.textContent = (e as ApiError).message; }
          },
        }, 'Apply'));
      return h('div', {}, form, err2, row);
    });
  }

  // ---------- movements ----------
  async function movementsSection(): Promise<HTMLElement> {
    const state = { page: 1, pageSize: 50 };
    const host = h('div');
    async function load(): Promise<void> {
      const res = await api<PagedResult<MovementRow>>('inventory.movements', { page: state.page, pageSize: state.pageSize });
      mount(host,
        dataTable<MovementRow>([
          { label: 'When', render: (r) => fmtDate(r.created_at, true), width: '160px' },
          { label: 'Item', render: (r) => h('span', { class: 'primary-cell', text: r.item_name ?? '—' }) },
          { label: 'Kind', render: (r) => badge(r.qty_delta >= 0 ? 'ok' : 'warn', r.kind.replace(/_/g, ' ')), width: '120px' },
          { label: 'Δ qty', align: 'right', render: (r) => h('strong', { text: `${r.qty_delta >= 0 ? '+' : ''}${r.qty_delta}` }), width: '80px' },
          { label: 'Lot', render: (r) => r.batch_no || '—', width: '110px' },
          { label: 'Reason', render: (r) => r.reason || '—' },
        ], res.rows, { empty: 'No stock movements recorded' }),
        pagerStrip(res, (p) => { state.page = p; void load(); }));
    }
    await load();
    return host;
  }

  // ---------- alerts ----------
  async function alertsSection(): Promise<HTMLElement> {
    const host = h('div', { class: 'p360-cols' });
    const lowHost = h('div');
    const expHost = h('div');
    const low = await api<{ id: string; sku: string; name: string; qty_on_hand: number; reorder_level: number; unit: string }[]>('inventory.lowStock', {});
    mount(lowHost, dataTable<{ id: string; sku: string; name: string; qty_on_hand: number; reorder_level: number; unit: string }>([
      { label: 'Item', render: (r) => h('span', { class: 'primary-cell', text: `${r.name} (${r.sku})` }) },
      { label: 'On hand', align: 'right', render: (r) => h('span', { class: 'due-hot', text: `${r.qty_on_hand} ${r.unit}` }) },
      { label: 'Reorder at', align: 'right', render: (r) => String(r.reorder_level), width: '110px' },
    ], low ?? [], { empty: 'Nothing is below its reorder level' }));
    const exp = await api<ExpiryRow[]>('inventory.expiries', { withinDays: 90 });
    mount(expHost, dataTable<ExpiryRow>([
      { label: 'Item', render: (r) => h('span', { class: 'primary-cell', text: `${r.name} (${r.sku})` }) },
      { label: 'Lot', render: (r) => r.batch_no || '—', width: '120px' },
      { label: 'Expiry', render: (r) => fmtDate(r.expiry_date), width: '120px' },
      { label: 'Remaining', align: 'right', render: (r) => String(r.remaining), width: '90px' },
    ], exp ?? [], { empty: 'Nothing expires within 90 days' }));
    host.append(
      h('section', { class: 'card' }, h('div', { class: 'card-title' }, h('h3', { text: 'Low stock' })), lowHost),
      h('section', { class: 'card' }, h('div', { class: 'card-title' }, h('h3', { text: 'Expiring within 90 days' })), expHost));
    return host;
  }

  // ---------- purchases ----------
  async function purchasesSection(): Promise<HTMLElement> {
    const host = h('div', { class: 'col-gap' });
    const head = h('div', { class: 'btn-row' },
      hasRole('admin') ? h('button', { class: 'btn', onclick: () => openNewPurchase() }, 'Record purchase') : '');
    const listHost = h('div');
    async function load(): Promise<void> {
      const res = await api <PagedResult<PurchaseRow>>('purchases.list', { page: 1, pageSize: 50 });
      mount(listHost, dataTable<PurchaseRow>([
        { label: 'PO', render: (r) => h('span', { class: 'mono', text: r.po_no }), width: '140px' },
        { label: 'Supplier', render: (r) => r.supplier_name ?? '—' },
        { label: 'Date', render: (r) => fmtDate(r.date), width: '120px' },
        { label: 'Total', align: 'right', render: (r) => taka(r.total_paisa) },
        { label: 'Paid', align: 'right', render: (r) => taka(r.paid_paisa) },
        {
          label: '', align: 'right', render: (r) => r.total_paisa - r.paid_paisa > 0 && hasRole('admin')
            ? h('button', { class: 'btn-link', onclick: () => void openPayPurchase(r) }, 'Record payment')
            : badge('ok', 'settled'),
        },
      ], res.rows, { empty: 'No purchases recorded' }));
    }
    function openPayPurchase(r: PurchaseRow): void {
      modal(`Pay supplier · ${r.po_no}`, (close) => {
        const due = r.total_paisa - r.paid_paisa;
        const form = h('div', { class: 'form-grid' },
          field({ name: 'amount', label: `Amount (Tk) · due ${taka(due)}`, type: 'number', value: (due / 100).toFixed(2), min: 0 }),
          field({ name: 'method', label: 'Method', type: 'select', options: ['cash', 'bank', 'card', 'bkash', 'nagad', 'rocket', 'upay'] }),
          field({ name: 'reference', label: 'Reference' }),
        );
        const err2 = h('div', { class: 'login-err' });
        const row = h('div', { class: 'btn-row end' },
          h('button', { class: 'btn', onclick: close }, 'Cancel'),
          h('button', {
            class: 'btn btn-primary', onclick: async () => {
              const v = readForm(form);
              const paisa = moneyToPaisa(v.amount);
              if (!(paisa > 0)) { err2.textContent = 'Amount must be positive'; return; }
              try {
                await api('purchases.pay', { purchaseId: r.id, amountPaisa: paisa, method: String(v.method), reference: String(v.reference ?? '') });
                toast('ok', 'Payment recorded'); close(); await load();
              } catch (e) { err2.textContent = (e as ApiError).message; }
            },
          }, 'Record'));
        return h('div', {}, form, err2, row);
      });
    }
    function openNewPurchase(): void {
      modal('Record purchase', (close) => {
        let items: { id: string; name: string; purchase_price_paisa: number }[] = [];
        void api<PagedResult<{ id: string; name: string; purchase_price_paisa: number }>>('inventory.list', { page: 1, pageSize: 500, q: '' }).then((r) => { items = r.rows; refillSel(); });
        let suppliers: { id: string; name: string }[] = [];
        void api<SupplierRow[]>('suppliers.list', { q: '' }).then((s) => { suppliers = Array.isArray(s) ? s : []; refillSel(); });
        const lines: { itemId: string; name: string; qty: number; unitCostPaisa: number; expiryDate: string | null; batchNo: string }[] = [];
        const sel = h('div', { class: 'form-grid' });
        function refillSel(): void {
          mount(sel,
            field({ name: 'supplierId', label: 'Supplier', type: 'select', options: [{ value: '', label: 'Walk-in (no supplier)' }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))] }),
            field({ name: 'item', label: 'Item', type: 'select', options: [{ value: '', label: 'Choose…' }, ...items.map((i) => ({ value: i.id, label: i.name }))] }),
            field({ name: 'qty', label: 'Qty', type: 'number', value: 1, min: 1 }),
            field({ name: 'cost', label: 'Unit cost (Tk)', type: 'number', min: 0 }),
            field({ name: 'expiry', label: 'Expiry (optional)', type: 'date' }),
            field({ name: 'batch', label: 'Lot / batch #', type: 'text' }),
          );
        }
        refillSel();
        const linesHost = h('div', { class: 'list' });
        function renderLines(): void {
          mount(linesHost, ...(lines.length
            ? lines.map((l, i) => h('div', { class: 'list-row static' },
                h('span', { class: 'list-title', text: l.name }),
                h('span', { class: 'muted', text: `${l.qty} × ${taka(l.unitCostPaisa)}${l.expiryDate ? ` · exp ${fmtDate(l.expiryDate)}` : ''}` }),
                h('button', { class: 'btn-link danger', onclick: () => { lines.splice(i, 1); renderLines(); } }, 'Remove')))
            : [h('div', { class: 'empty-title', text: 'No lines added' })]));
        }
        renderLines();
        const err2 = h('div', { class: 'login-err' });
        const wrap = h('div', { class: 'col-gap' },
          sel,
          h('button', {
            class: 'btn', onclick: () => {
              const v = readForm(sel);
              const it = items.find((x) => x.id === v.item);
              if (!it) { toast('err', 'Choose an item'); return; }
              const costPaisa = v.cost === null || v.cost === '' || v.cost === undefined ? it.purchase_price_paisa : moneyToPaisa(v.cost);
              lines.push({
                itemId: it.id, name: it.name, qty: Math.max(1, Number(v.qty ?? 1)),
                unitCostPaisa: costPaisa,
                expiryDate: v.expiry ? String(v.expiry) : null, batchNo: String(v.batch ?? ''),
              });
              renderLines();
            },
          }, '＋ Add line'),
          linesHost, err2,
          h('div', { class: 'btn-row end' },
            h('button', { class: 'btn', onclick: close }, 'Cancel'),
            h('button', {
              class: 'btn btn-primary', onclick: async () => {
                err2.textContent = '';
                if (!lines.length) { err2.textContent = 'Add at least one line'; return; }
                const v = readForm(sel);
                try {
                  await api('purchases.create', {
                    supplierId: v.supplierId ? String(v.supplierId) : null,
                    lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitCostPaisa: l.unitCostPaisa, expiryDate: l.expiryDate, batchNo: l.batchNo })),
                    notes: '', receive: true,
                  });
                  toast('ok', 'Purchase recorded & stock updated'); close(); await load();
                } catch (e) { err2.textContent = (e as ApiError).message; }
              },
            }, 'Save purchase')),
        );
        return wrap;
      }, { wide: true });
    }
    host.append(head, listHost);
    await load();
    return host;
  }

  // ---------- suppliers ----------
  async function suppliersSection(): Promise<HTMLElement> {
    const host = h('div', { class: 'col-gap' });
    const head = h('div', { class: 'btn-row' },
      hasRole('admin') ? h('button', { class: 'btn', onclick: () => openSupplier() }, h('span', {}, icon('add')), 'New supplier') : '');
    const listHost = h('div');
    async function load(): Promise<void> {
      const rows = await api<SupplierRow[]>('suppliers.list', { q: '' });
      mount(listHost, dataTable<SupplierRow>([
        { label: 'Name', render: (r) => h('span', { class: 'primary-cell', text: r.name }) },
        { label: 'Phone', render: (r) => r.phone || '—' },
        { label: 'Email', render: (r) => r.email || '—' },
        { label: 'Address', render: (r) => r.address || '—' },
        { label: '', align: 'right', render: (r) => hasRole('admin') ? h('button', { class: 'btn-link', onclick: () => openSupplier(r) }, 'Edit') : '' },
      ], rows ?? [], { empty: 'No suppliers recorded' }));
    }
    function openSupplier(r?: SupplierRow): void {
      modal(r ? `Edit ${r.name}` : 'New supplier', (close) => {
        const form = h('div', { class: 'form-grid' },
          field({ name: 'name', label: 'Name', value: r?.name ?? '', required: true }),
          field({ name: 'phone', label: 'Phone', value: r?.phone ?? '' }),
          field({ name: 'email', label: 'Email', value: r?.email ?? '' }),
          field({ name: 'address', label: 'Address', type: 'textarea', rows: 2, value: r?.address ?? '' }),
          field({ name: 'notes', label: 'Notes', value: r?.notes ?? '' }),
        );
        const err2 = h('div', { class: 'login-err' });
        const row = h('div', { class: 'btn-row end' },
          h('button', { class: 'btn', onclick: close }, 'Cancel'),
          h('button', {
            class: 'btn btn-primary', onclick: async () => {
              const v = readForm(form);
              if (!String(v.name ?? '').trim()) { err2.textContent = 'Name required'; return; }
              try {
                const payload = { name: String(v.name).trim(), phone: String(v.phone ?? ''), email: String(v.email ?? ''), address: String(v.address ?? ''), notes: String(v.notes ?? '') };
                if (r) await api('suppliers.update', { ...payload, id: r.id });
                else await api('suppliers.create', payload);
                toast('ok', 'Saved'); close(); await load();
              } catch (e) { err2.textContent = (e as ApiError).message; }
            },
          }, 'Save'));
        return h('div', {}, form, err2, row);
      });
    }
    host.append(head, listHost);
    await load();
    return host;
  }
}

function moneyToPaisa(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
