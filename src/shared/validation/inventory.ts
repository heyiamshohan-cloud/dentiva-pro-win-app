import { z } from 'zod';
import { uuid, nonEmpty, text2000, dateStr, paisaNonNeg, pageQuery } from './common';
import { STOCK_MOVE_KINDS } from '../constants';

export const itemInput = z.object({
  sku: nonEmpty.max(60),
  name: nonEmpty.max(200),
  category: z.string().trim().max(120).default('General'),
  unit: z.string().trim().max(40).default('pcs'),
  supplierId: uuid.nullable().default(null),
  purchasePricePaisa: paisaNonNeg.default(0),
  salePricePaisa: paisaNonNeg.default(0),
  reorderLevel: z.number().int().min(0).default(0),
  notes: text2000.default(''),
  active: z.boolean().default(true),
});
export type ItemInput = z.infer<typeof itemInput>;
export const itemUpdate = itemInput.extend({ id: uuid });

export const itemListQuery = pageQuery({
  q: z.string().trim().max(120).default(''),
  category: z.string().trim().max(120).default(''),
  lowStock: z.boolean().default(false),
  includeInactive: z.boolean().default(false),
});

export const supplierInput = z.object({
  name: nonEmpty.max(200),
  phone: z.string().trim().max(32).default(''),
  email: z.string().trim().max(120).default(''),
  address: text2000.default(''),
  notes: text2000.default(''),
});
export type SupplierInput = z.infer<typeof supplierInput>;
export const supplierUpdate = supplierInput.extend({ id: uuid });

export const purchaseLineInput = z.object({
  itemId: uuid,
  qty: z.number().int().min(1).max(100000),
  unitCostPaisa: paisaNonNeg,
  batchNo: z.string().trim().max(80).default(''),
  expiryDate: dateStr.nullable().default(null),
});

export const purchaseInput = z.object({
  supplierId: uuid.nullable().default(null),
  date: dateStr.optional(),
  lines: z.array(purchaseLineInput).min(1).max(200),
  notes: text2000.default(''),
  receive: z.boolean().default(true),
});
export type PurchaseInput = z.infer<typeof purchaseInput>;

export const stockAdjustInput = z.object({
  itemId: uuid,
  kind: z.enum(['use', 'adjust', 'waste', 'return', 'sale'] as const),
  qtyDelta: z.number().int().refine((v) => v !== 0, 'Quantity change cannot be zero'),
  reason: nonEmpty.max(300),
  batchNo: z.string().trim().max(80).default(''),
  expiryDate: dateStr.nullable().default(null),
});

export const movementListQuery = pageQuery({
  itemId: uuid.optional(),
  kind: z.enum(STOCK_MOVE_KINDS).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});

export const purchasePayInput = z.object({
  purchaseId: uuid,
  amountPaisa: z.number().int().min(1),
  method: z.enum(['cash', 'bank', 'card', 'bkash', 'nagad', 'rocket', 'upay'] as const).default('cash'),
  reference: z.string().trim().max(200).default(''),
});

export type ItemListQuery = z.infer<typeof itemListQuery>;
export type StockAdjustInput = z.infer<typeof stockAdjustInput>;
export type MovementListQuery = z.infer<typeof movementListQuery>;
export type PurchasePayInput = z.infer<typeof purchasePayInput>;
export type PurchaseLineInput = z.infer<typeof purchaseLineInput>;
