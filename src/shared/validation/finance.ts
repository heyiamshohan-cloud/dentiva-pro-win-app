import { z } from 'zod';
import { uuid, nonEmpty, text2000, dateStr, paisaNonNeg, paisaPos, paisa, idempotencyKey, pageQuery } from './common';
import { PAYMENT_METHODS, INVOICE_STATUSES } from '../constants';

export const invoiceLineInput = z.object({
  itemType: z.enum(['treatment', 'product', 'service', 'custom']).default('service'),
  refId: uuid.nullable().default(null),
  description: nonEmpty.max(300),
  tooth: z.number().int().nullable().default(null),
  qty: z.number().int().min(1).max(1000).default(1),
  unitPricePaisa: paisaNonNeg,
  discountPaisa: paisaNonNeg.default(0),
});
export type InvoiceLineInput = z.infer<typeof invoiceLineInput>;

export const invoiceInput = z.object({
  patientId: uuid,
  visitId: uuid.nullable().default(null),
  date: dateStr.optional(),
  lines: z.array(invoiceLineInput).min(1).max(200),
  discountPaisa: paisaNonNeg.default(0),
  taxBp: z.number().int().min(0).max(10000).default(0),
  notes: text2000.default(''),
  finalize: z.boolean().default(true),
});
export type InvoiceInput = z.infer<typeof invoiceInput>;
export const invoiceUpdate = invoiceInput.extend({ id: uuid });

export const invoiceListQuery = pageQuery({
  patientId: uuid.optional(),
  status: z.enum([...INVOICE_STATUSES, 'unpaid', 'part_paid', 'paid'] as const).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  q: z.string().trim().max(120).default(''),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuery>;

export const paymentInput = z.object({
  patientId: uuid,
  invoiceId: uuid.nullable().default(null),
  amountPaisa: paisaPos,
  method: z.enum(PAYMENT_METHODS),
  date: dateStr.optional(),
  reference: z.string().trim().max(200).default(''),
  notes: text2000.default(''),
  idempotencyKey: idempotencyKey.optional(),
});
export type PaymentInput = z.infer<typeof paymentInput>;

export const refundInput = z.object({
  patientId: uuid,
  originalPaymentId: uuid,
  amountPaisa: paisaPos,
  reason: nonEmpty.max(500),
  method: z.enum(PAYMENT_METHODS),
});

export const voidInvoiceInput = z.object({ id: uuid, reason: nonEmpty.max(500) });

export const paymentListQuery = pageQuery({
  patientId: uuid.optional(),
  invoiceId: uuid.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  direction: z.enum(['payment', 'refund']).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});
export type PaymentListQuery = z.infer<typeof paymentListQuery>;

export const statementQuery = z.object({
  patientId: uuid,
  from: dateStr.optional(),
  to: dateStr.optional(),
});

export const expenseInput = z.object({
  date: dateStr.optional(),
  category: nonEmpty.max(120),
  amountPaisa: paisaPos,
  method: z.enum(PAYMENT_METHODS).default('cash'),
  vendor: z.string().trim().max(200).default(''),
  notes: text2000.default(''),
});
export type ExpenseInput = z.infer<typeof expenseInput>;
export const expenseUpdate = expenseInput.extend({ id: uuid });

export const expenseListQuery = pageQuery({ from: dateStr.optional(), to: dateStr.optional(), category: z.string().trim().max(120).default('') });

export const ledgerQuery = pageQuery({ from: dateStr.optional(), to: dateStr.optional(), kind: z.enum(['income', 'expense', 'refund', 'adjustment']).optional() });

export const adjustmentInput = z.object({
  patientId: uuid,
  invoiceId: uuid.nullable().default(null),
  amountPaisa: paisa.refine((v) => v !== 0, 'Adjustment cannot be zero'),
  reason: nonEmpty.max(500),
});

export type ExpenseListQuery = z.infer<typeof expenseListQuery>;
export type LedgerQuery = z.infer<typeof ledgerQuery>;
export type RefundInput = z.infer<typeof refundInput>;
