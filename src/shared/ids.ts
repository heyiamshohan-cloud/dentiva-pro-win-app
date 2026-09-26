// Dentiva Pro - identifiers. Internal ids: UUIDv4. Human codes: sequence-backed, formatted.
import { randomUUID } from 'node:crypto';

export function uuid(): string {
  return randomUUID();
}

export function patientCode(seq: number): string {
  return `P-${String(seq).padStart(6, '0')}`;
}
export function invoiceNo(seq: number): string {
  return `INV-${String(seq).padStart(6, '0')}`;
}
export function receiptNo(seq: number): string {
  return `RCP-${String(seq).padStart(6, '0')}`;
}
export function prescriptionNo(seq: number): string {
  return `RX-${String(seq).padStart(6, '0')}`;
}
export function visitNo(seq: number): string {
  return `V-${String(seq).padStart(6, '0')}`;
}
export function purchaseNo(seq: number): string {
  return `PO-${String(seq).padStart(6, '0')}`;
}
