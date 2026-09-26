// Dentiva Pro - preload: the ONLY bridge between renderer and main.
// contextIsolation + sandbox are ON; the renderer receives a minimal, validated API.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

let token: string | null = null;

const api = {
  async invoke(channel: string, payload: unknown): Promise<unknown> {
    // The gateway returns IpcResult; unwrap here so renderer code stays lean.
    const result = await ipcRenderer.invoke('dentiva:invoke', { channel, payload, token });
    return result;
  },
  setToken(t: string | null): void {
    token = t;
  },
  /** Persisted session token across a soft reload is NOT supported by design;
      renderer keeps it in memory and re-authenticates after reload. */
  getToken(): string | null {
    return token;
  },
  onDbRestored(cb: () => void): void {
    ipcRenderer.on('app:db-restored', () => cb());
  },
  /** Resolve a dropped/selected File to its real path in the sandboxed world (webUtils). */
  pathForFile(file: File): string {
    try {
      return webUtils ? webUtils.getPathForFile(file) : '';
    } catch {
      return '';
    }
  },
  platform: process.platform,
  versions: { electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '' },
};

export type DentivaBridge = typeof api;
contextBridge.exposeInMainWorld('dentiva', api);
