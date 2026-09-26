import { z } from 'zod';
import { uuid, nonEmpty, text2000, text10000, dateStr, pageQuery } from './common';
import { CC_OPTIONS, OE_OPTIONS, TOOTH_STATES, DENTITIONS, PLAN_STATUSES, ADULT_TEETH, PRIMARY_TEETH } from '../constants';

const toothAdult = z.number().int().refine((t) => ADULT_TEETH.includes(t), 'Invalid adult FDI tooth');
const toothPrimary = z.number().int().refine((t) => PRIMARY_TEETH.includes(t), 'Invalid primary FDI tooth');

export const visitInput = z.object({
  patientId: uuid,
  dentistId: uuid.nullable().default(null),
  appointmentId: uuid.nullable().default(null),
  chiefComplaint: text2000,
  reason: text2000.default(''),
  symptoms: text2000.default(''),
  findings: text2000.default(''),
  diagnosis: text2000.default(''),
  notes: text10000.default(''),
  followUpDate: dateStr.nullable().default(null),
  referral: text2000.default(''),
});
export type VisitInput = z.infer<typeof visitInput>;

export const visitUpdate = visitInput.extend({ id: uuid });

export const procedureInput = z.object({
  visitId: uuid,
  treatmentId: uuid.nullable().default(null),
  name: nonEmpty.max(200),
  tooth: z.number().int().nullable().default(null),
  surface: z.string().trim().max(20).default(''),
  qty: z.number().int().min(1).max(100).default(1),
  pricePaisa: z.number().int().min(0).default(0),
  anesthesia: z.string().trim().max(200).default(''),
  notes: text2000.default(''),
});

export const visitListQuery = pageQuery({
  patientId: uuid.optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});
export type VisitListQuery = z.infer<typeof visitListQuery>;

export const timelineQuery = z.object({
  patientId: uuid,
  cursor: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const chartSetTooth = z.object({
  patientId: uuid,
  dentition: z.enum(DENTITIONS),
  tooth: z.number().int(),
  state: z.enum(TOOTH_STATES),
  notes: text2000.default(''),
  visitId: uuid.nullable().default(null),
}).superRefine((v, ctx) => {
  const ok = v.dentition === 'adult' ? ADULT_TEETH.includes(v.tooth) : PRIMARY_TEETH.includes(v.tooth);
  if (!ok) ctx.addIssue({ code: 'custom', message: `Tooth ${v.tooth} is not valid for ${v.dentition} dentition` });
});
export const chartGet = z.object({ patientId: uuid, dentition: z.enum(DENTITIONS) });

export const rxItemInput = z.object({
  drugName: nonEmpty.max(200),
  strength: z.string().trim().max(100).default(''),
  dose: z.string().trim().max(120).default(''),
  frequency: z.string().trim().max(120).default(''),
  duration: z.string().trim().max(120).default(''),
  route: z.string().trim().max(60).default('oral'),
  instructions: z.string().trim().max(500).default(''),
});

export const prescriptionInput = z.object({
  patientId: uuid,
  visitId: uuid.nullable().default(null),
  dentistId: uuid.nullable().default(null),
  cc: z.array(z.enum(CC_OPTIONS)).max(CC_OPTIONS.length).default([]),
  oe: z.array(z.enum(OE_OPTIONS)).max(OE_OPTIONS.length).default([]),
  re: text2000.default(''),
  advice: text2000.default(''),
  items: z.array(rxItemInput).max(30).default([]),
  followUpDate: dateStr.nullable().default(null),
  finalize: z.boolean().default(false),
});
export type PrescriptionInput = z.infer<typeof prescriptionInput>;
export const prescriptionUpdate = prescriptionInput.extend({ id: uuid });

export const treatmentInput = z.object({
  name: nonEmpty.max(200),
  category: z.string().trim().max(120).default('General'),
  description: text2000.default(''),
  durationMin: z.number().int().min(0).max(600).default(30),
  pricePaisa: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
  clinicalNotes: text2000.default(''),
});
export type TreatmentInput = z.infer<typeof treatmentInput>;
export const treatmentUpdate = treatmentInput.extend({ id: uuid });

export const treatmentListQuery = pageQuery({
  q: z.string().trim().max(120).default(''),
  category: z.string().trim().max(120).default(''),
  includeInactive: z.boolean().default(false),
});

export const planItemInput = z.object({
  treatmentId: uuid.nullable().default(null),
  name: nonEmpty.max(200),
  tooth: z.number().int().nullable().default(null),
  qty: z.number().int().min(1).max(100).default(1),
  estPricePaisa: z.number().int().min(0).default(0),
  seq: z.number().int().min(0).default(0),
});

export const planInput = z.object({
  patientId: uuid,
  title: nonEmpty.max(200),
  notes: text2000.default(''),
  items: z.array(planItemInput).max(100).default([]),
});
export type PlanInput = z.infer<typeof planInput>;

export const planSetStatus = z.object({
  id: uuid,
  status: z.enum(PLAN_STATUSES),
});

export const planConvert = z.object({
  planId: uuid,
  itemIds: z.array(uuid).min(1),
  visitId: uuid.nullable().default(null),
});

export const toothCheck = { toothAdult, toothPrimary };

export type TreatmentListQuery = z.infer<typeof treatmentListQuery>;
