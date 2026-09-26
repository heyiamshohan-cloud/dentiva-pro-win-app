// Dentiva Pro renderer — typed IPC client. No business logic here: validation + RBAC live in main.
import type { IpcResult } from '../../shared/errors';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'dentist' | 'staff';
}

let session: SessionUser | null = null;

export function setSession(user: SessionUser | null, token: string | null): void {
  session = user;
  window.dentiva.setToken(token);
}
export function currentUser(): SessionUser | null { return session; }
export function hasRole(...roles: SessionUser['role'][]): boolean {
  return !!session && roles.includes(session.role);
}

export class ApiError extends Error {
  code: string;
  details?: unknown;
  constructor(e: { code: string; message: string; details?: unknown }) {
    super(e.message);
    this.code = e.code;
    this.details = e.details;
  }
}

/** Invoke a channel; throws ApiError on failure (callers surface via toast/inline). */
export async function api<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const r = (await window.dentiva.invoke(channel, payload ?? {})) as IpcResult<T>;
  if (!r.ok) throw new ApiError(r.error!);
  return r.data as T;
}

/** Invoke without throwing: returns the raw result for fine-grained handling. */
export async function apiRaw<T = unknown>(channel: string, payload?: unknown): Promise<IpcResult<T>> {
  return (await window.dentiva.invoke(channel, payload)) as IpcResult<T>;
}

/** Global commands a screen can register with the palette. */
export interface GlobalAction {
  id: string;
  label: string;
  keywords: string;
  shortcut?: string;
  run(): void;
}
