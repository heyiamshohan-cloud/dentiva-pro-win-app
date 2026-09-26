import { z } from 'zod';
import { DATE_FMT } from '../constants';

export const uuid = z.string().uuid();
export const nonEmpty = z.string().trim().min(1).max(500);
export const text500 = z.string().trim().max(500).default('');
export const text2000 = z.string().trim().max(2000).default('');
export const text10000 = z.string().trim().max(10000).default('');
export const phone = z.string().trim().max(32).regex(/^[0-9+\-() ]*$/, 'Invalid phone format').default('');
export const email = z.string().trim().toLowerCase().email().max(120).or(z.literal('')).default('');
export const dateStr = z.string().regex(DATE_FMT, 'Expected YYYY-MM-DD');
export const isoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid timestamp');
export const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');
export const paisa = z.number().int().safe();
export const paisaNonNeg = paisa.min(0);
export const paisaPos = paisa.min(1);
export const idempotencyKey = z.string().trim().min(4).max(80);

export const sortDir = z.enum(['asc', 'desc']).default('asc');

export function pageQuery<T extends z.ZodRawShape>(extra: T) {
  return z.object({
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(200).default(25),
    ...extra,
  });
}
export const pagination = pageQuery({});

export const emptyPayload = z.object({}).strict();

export function idPayload() {
  return z.object({ id: uuid }).strict();
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function makePage<T>(rows: T[], total: number, page: number, pageSize: number): Page<T> {
  return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
