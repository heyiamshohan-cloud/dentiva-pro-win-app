// Dentiva Pro - typed domain errors. Raw errors never cross the IPC boundary.

export type ErrorCode =
  | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'UNAUTHENTICATED'
  | 'DUPLICATE' | 'INVALID_STATE' | 'FINANCIAL' | 'INTEGRITY' | 'IO'
  | 'BACKUP' | 'RESTORE' | 'INTERNAL';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export const err = {
  validation: (msg: string, details?: unknown) => new DomainError('VALIDATION', msg, details),
  notFound: (what: string) => new DomainError('NOT_FOUND', `${what} was not found.`),
  conflict: (msg: string, details?: unknown) => new DomainError('CONFLICT', msg, details),
  forbidden: (msg = 'You do not have permission to perform this action.') => new DomainError('FORBIDDEN', msg),
  unauthenticated: () => new DomainError('UNAUTHENTICATED', 'Please sign in to continue.'),
  duplicate: (msg: string, details?: unknown) => new DomainError('DUPLICATE', msg, details),
  invalidState: (msg: string) => new DomainError('INVALID_STATE', msg),
  financial: (msg: string) => new DomainError('FINANCIAL', msg),
  integrity: (msg: string) => new DomainError('INTEGRITY', msg),
  io: (msg: string) => new DomainError('IO', msg),
  backup: (msg: string) => new DomainError('BACKUP', msg),
  restore: (msg: string) => new DomainError('RESTORE', msg),
  internal: (msg = 'An unexpected error occurred. No changes were made.') => new DomainError('INTERNAL', msg),
};

export interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: { code: ErrorCode; message: string; details?: unknown };
}

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

export function fail(e: unknown): IpcResult<never> {
  if (e instanceof DomainError) return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
  return { ok: false, error: { code: 'INTERNAL', message: 'An unexpected error occurred. The operation was not completed and your data has not been changed.' } };
}
