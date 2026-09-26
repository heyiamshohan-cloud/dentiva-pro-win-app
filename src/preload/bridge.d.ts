import type { DentivaBridge } from './index';

declare global {
  interface Window {
    dentiva: DentivaBridge;
  }
}

export {};

