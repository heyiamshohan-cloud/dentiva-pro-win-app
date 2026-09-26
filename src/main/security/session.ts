// Dentiva Pro - in-memory session manager (main process only). Sessions never persist to disk.
import { Role } from '../../shared/constants';
import { randomToken } from './crypto';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

interface Session extends SessionUser {
  token: string;
  createdAt: number;
  lastActivity: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private idleMs: number;

  constructor(idleMinutes = 30) {
    this.idleMs = idleMinutes * 60_000;
  }

  setIdleMinutes(min: number): void {
    this.idleMs = Math.max(5, min) * 60_000;
  }

  create(user: SessionUser): string {
    const token = randomToken();
    this.sessions.set(token, { ...user, token, createdAt: Date.now(), lastActivity: Date.now() });
    return token;
  }

  resolve(token: string | undefined | null): SessionUser | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.lastActivity > this.idleMs) {
      this.sessions.delete(token);
      return null;
    }
    s.lastActivity = Date.now();
    return { id: s.id, username: s.username, displayName: s.displayName, role: s.role };
  }

  destroy(token: string | undefined | null): void {
    if (token) this.sessions.delete(token);
  }

  destroyAll(): void {
    this.sessions.clear();
  }

  count(): number {
    return this.sessions.size;
  }
}
