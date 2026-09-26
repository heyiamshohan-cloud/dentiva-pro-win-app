import { z } from 'zod';
import { uuid, text2000, phone, email, dateStr, pageQuery } from './common';
import { GENDERS, MEDICAL_KINDS } from '../constants';

const phoneField = z.string().trim().max(32).regex(/^[0-9+\-() ]*$/, 'Invalid phone format').default('');
const short = (n: number) => z.string().trim().max(n).default('');

export const patientInput = z.object({
  name: z.string().trim().min(1).max(160),
  title: short(40),
  gender: z.enum(GENDERS).nullable().default(null),
  dob: dateStr.nullable().default(null),
  phone: phone,
  altPhone: phoneField,
  email,
  address: text2000,
  emergencyContactName: short(160),
  emergencyContactPhone: phoneField,
  occupation: short(120),
  referralSource: short(160),
  bloodGroup: z.string().trim().max(20).default(''),
  notes: text2000,
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  customFields: z.record(z.string().max(60), z.string().max(500)).default({}),
});
export type PatientInput = z.infer<typeof patientInput>;

export const patientUpdate = patientInput.extend({ id: uuid });

export const medicalItemInput = z.object({
  kind: z.enum(MEDICAL_KINDS),
  value: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(1000).default(''),
  active: z.boolean().default(true),
});
export type MedicalItemInput = z.infer<typeof medicalItemInput>;

export const medicalItemUpdate = medicalItemInput.extend({ id: uuid });

export const patientListQuery = pageQuery({
  q: z.string().trim().max(120).default(''),
  archived: z.boolean().default(false),
  tag: z.string().trim().max(60).default(''),
  sortBy: z.enum(['name', 'code', 'created_at', 'phone']).default('created_at'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});
export type PatientListQuery = z.infer<typeof patientListQuery>;

export const patientMergeInput = z.object({
  keepId: uuid,
  removeId: uuid,
});
