import { describe, it, expect, afterEach } from 'vitest';
import { makeTestEnv, TestEnv, seedPatient, expectFail } from '../helpers';

let env: TestEnv;
afterEach(() => env?.cleanup());

describe('clinical workflow: visits, second-visit lifecycle, chart, prescriptions, plans', () => {
  it('full multi-visit lifecycle keeps every record isolated and intact', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env, 'Multi Visit');
    // Visit 1
    const v1 = await env.must<{ id: string; visit_no: string }>(env.adminToken, 'visits.create', {
      patientId: p.id, chiefComplaint: 'Pain On', findings: 'Carries 46', diagnosis: 'Irreversible pulpitis',
    });
    await env.must(env.adminToken, 'visits.addProcedure', { visitId: v1.id, name: 'Pulpotomy', tooth: 46, qty: 1, pricePaisa: 250000, treatmentId: null, surface: '', anesthesia: 'LA', notes: '' });
    const rx1 = await env.must<{ id: string; rx_no: string }>(env.adminToken, 'prescriptions.create', {
      patientId: p.id, visitId: v1.id, cc: ['Pain On'], oe: ['Carries'], advice: 'Warm saline rinse',
      items: [{ drugName: 'Ibuprofen', strength: '400mg', dose: '1 tab', frequency: 'TID', duration: '5 days', route: 'oral', instructions: 'After food' }],
      finalize: true,
    });
    const inv1 = await env.must<{ id: string }>(env.adminToken, 'invoices.create', {
      patientId: p.id, visitId: v1.id, lines: [{ description: 'Pulpotomy', tooth: 46, qty: 1, unitPricePaisa: 250000 }], finalize: true,
    });
    await env.must(env.adminToken, 'payments.create', { patientId: p.id, invoiceId: inv1.id, amountPaisa: 100000, method: 'cash' });
    await env.must(env.adminToken, 'visits.setStatus', { id: v1.id, status: 'completed' });

    // Visit 2
    const v2 = await env.must<{ id: string; visit_no: string }>(env.adminToken, 'visits.create', {
      patientId: p.id, chiefComplaint: 'Swelling', findings: 'Abscess 46', diagnosis: 'Apical abscess',
    });
    await env.must(env.adminToken, 'chart.setTooth', { patientId: p.id, dentition: 'adult', tooth: 46, state: 'root_canal', notes: 'RCT started', visitId: v2.id });
    const rx2 = await env.must<{ id: string; rx_no: string }>(env.adminToken, 'prescriptions.create', {
      patientId: p.id, visitId: v2.id, cc: ['Swelling'], oe: ['Carries'], items: [{ drugName: 'Amoxicillin', strength: '500mg', dose: '1 cap', frequency: 'TID', duration: '7 days', route: 'oral', instructions: '' }],
      finalize: false,
    });
    expect(rx1.rx_no).toBe('RX-000001');
    expect(rx2.rx_no).toBe('RX-000002');
    expect(v1.visit_no).not.toBe(v2.visit_no);

    // Isolation: visit 1 untouched by visit 2
    const v1After = await env.must<{ chief_complaint: string; diagnosis: string; status: string; procedures: unknown[] }>(env.adminToken, 'visits.get', { id: v1.id });
    expect(v1After.chief_complaint).toBe('Pain On');
    expect(v1After.diagnosis).toBe('Irreversible pulpitis');
    expect(v1After.status).toBe('completed');
    expect(v1After.procedures).toHaveLength(1);

    // 360 timeline has all events
    const overview = await env.must<{ counts: { visits: number; prescriptions: number; invoices: number; payments: number } }>(env.adminToken, 'patients.overview', { id: p.id });
    expect(overview.counts.visits).toBe(2);
    expect(overview.counts.prescriptions).toBe(2);
    expect(overview.counts.invoices).toBe(1);
    expect(overview.counts.payments).toBe(1);
  });

  it('prescription clinical content is exactly correct and finalized docs are immutable', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    const rx = await env.must<{ id: string }>(env.adminToken, 'prescriptions.create', {
      patientId: p.id, cc: ['Pain On', 'G. Carries', 'Swelling', 'Gum Bleeding', 'Bad Breath', 'Sensitivity'],
      oe: ['Carries', 'G Carries', 'BDR', 'BDC', 'Gingivitis', 'Parodental Pocket', 'Perio Dontitis', 'Impected Teeth', 'Dry Socket', 'Attrition', 'Erosion'],
      re: 'PAs taken', advice: 'Brush twice daily', items: [], finalize: true,
    });
    const loaded = await env.must<{ cc: string[]; oe: string[]; re: string; advice: string }>(env.adminToken, 'prescriptions.get', { id: rx.id });
    expect(loaded.cc).toHaveLength(6);
    expect(loaded.oe).toHaveLength(11);
    expect(loaded.oe).toContain('Impected Teeth'); // exact product wording preserved
    expect(loaded.re).toBe('PAs taken');
    expectFail(await env.call(env.adminToken, 'prescriptions.update', { id: rx.id, patientId: p.id, cc: [], items: [], finalize: false }), 'INVALID_STATE');
  });

  it('prescription is clinical only: model contains no money fields', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    const rx = await env.must<Record<string, unknown>>(env.adminToken, 'prescriptions.create', { patientId: p.id, cc: ['Pain On'], items: [], finalize: true });
    const full = await env.must<Record<string, unknown>>(env.adminToken, 'prescriptions.get', { id: String(rx.id) });
    for (const k of Object.keys(full)) {
      expect(k).not.toMatch(/price|amount|total|paisa|fee|cost/i);
    }
    const cols = env.db.prepare("PRAGMA table_info(prescriptions)").all() as { name: string }[];
    expect(cols.some((c) => /price|amount|paisa/i.test(c.name))).toBe(false);
  });

  it('dental chart supports adult+primary with full audit history', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    await env.must(env.adminToken, 'chart.setTooth', { patientId: p.id, dentition: 'adult', tooth: 46, state: 'caries', notes: 'initial', visitId: null });
    await env.must(env.adminToken, 'chart.setTooth', { patientId: p.id, dentition: 'adult', tooth: 46, state: 'restoration', notes: 'filled', visitId: null });
    const chart = await env.must<{ teeth: { tooth: number; state: string }[] }>(env.adminToken, 'chart.get', { patientId: p.id, dentition: 'adult' });
    expect(chart.teeth).toHaveLength(32);
    expect(chart.teeth.find((t) => t.tooth === 46)?.state).toBe('restoration');
    const history = env.db.prepare('SELECT * FROM dental_chart_history WHERE patient_id = ? ORDER BY changed_at').all(p.id) as { prev_state: string; new_state: string }[];
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ prev_state: 'caries', new_state: 'restoration' });
    const primary = await env.must<{ teeth: { tooth: number }[] }>(env.adminToken, 'chart.get', { patientId: p.id, dentition: 'primary' });
    expect(primary.teeth).toHaveLength(20);
    expectFail(await env.call(env.adminToken, 'chart.setTooth', { patientId: p.id, dentition: 'adult', tooth: 51, state: 'caries' }), 'VALIDATION');
  });

  it('treatment catalog + plans: explicit conversion, never auto-bills', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    const t = await env.must<{ id: string }>(env.adminToken, 'treatments.create', { name: 'Scaling & Polishing', category: 'Perio', pricePaisa: 150000, durationMin: 30 });
    expectFail(await env.call(env.adminToken, 'treatments.create', { name: 'scaling & polishing', category: 'Perio' }), 'DUPLICATE');
    const plan = await env.must<{ id: string }>(env.adminToken, 'plans.create', {
      patientId: p.id, title: 'Anterior rehab', items: [{ treatmentId: t.id, name: 'Scaling & Polishing', tooth: 11, qty: 1, estPricePaisa: 150000, seq: 0 }],
    });
    expectFail(await env.call(env.adminToken, 'plans.convert', { planId: plan.id, itemIds: [], visitId: null }), 'VALIDATION');
    expectFail(await env.call(env.adminToken, 'plans.convert', { planId: plan.id, itemIds: ['3b241101-e2bb-4255-8caf-4136c566a962'], visitId: null }), 'INVALID_STATE'); // draft plan
    await env.must(env.adminToken, 'plans.setStatus', { id: plan.id, status: 'proposed' });
    expectFail(await env.call(env.adminToken, 'plans.setStatus', { id: plan.id, status: 'completed' }), 'INVALID_STATE'); // proposed cannot jump to completed
    await env.must(env.adminToken, 'plans.setStatus', { id: plan.id, status: 'accepted' });
    expectFail(await env.call(env.adminToken, 'plans.setStatus', { id: plan.id, status: 'proposed' }), 'INVALID_STATE'); // no backward slide from accepted
  });

  it('plan conversion creates visit procedures but ZERO invoices', async () => {
    env = await makeTestEnv();
    const p = await seedPatient(env);
    const plan = await env.must<{ id: string }>(env.adminToken, 'plans.create', {
      patientId: p.id, title: 'Plan A', items: [{ treatmentId: null, name: 'Crown prep', tooth: 36, qty: 1, estPricePaisa: 500000, seq: 0 }],
    });
    await env.must(env.adminToken, 'plans.setStatus', { id: plan.id, status: 'proposed' });
    await env.must(env.adminToken, 'plans.setStatus', { id: plan.id, status: 'accepted' });
    const plans = await env.must<{ items: { id: string }[] }[]>(env.adminToken, 'plans.list', { patientId: p.id });
    const itemId = plans[0]!.items[0]!.id;
    const converted = await env.must<{ converted: number; visitId: string }>(env.adminToken, 'plans.convert', { planId: plan.id, itemIds: [itemId], visitId: null });
    expect(converted.converted).toBe(1);
    const visit = await env.must<{ procedures: { name: string }[] }>(env.adminToken, 'visits.get', { id: converted.visitId });
    expect(visit.procedures.map((x) => x.name)).toContain('Crown prep');
    const invoices = await env.must<{ total: number }>(env.adminToken, 'invoices.list', { patientId: p.id });
    expect(invoices.total).toBe(0); // no accidental billing
  });
});
