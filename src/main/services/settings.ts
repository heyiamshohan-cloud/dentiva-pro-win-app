// Dentiva Pro - settings service. Persistence verified before returning success.
import { err } from '../../shared/errors';
import { ClinicProfileInput } from '../../shared/validation/system';
import { Ctx, tx, DEFAULT_CLINIC } from './context';
import { setSetting } from '../db/connection';

export function getSettings(ctx: Ctx): ClinicProfileInput {
  return { ...DEFAULT_CLINIC, ...ctx.clinic() };
}

export function updateSettings(ctx: Ctx, input: ClinicProfileInput): ClinicProfileInput {
  tx(ctx.db, () => {
    const merged: ClinicProfileInput = { ...DEFAULT_CLINIC, ...ctx.clinic(), ...input, clinicName: input.clinicName };
    setSetting(ctx.db, 'clinic_profile', merged);
    ctx.audit('settings.update', 'settings', 'clinic_profile', { clinicName: input.clinicName });
  });
  // Read-back verification: never report success unless persistence actually occurred.
  const saved = ctx.clinic();
  if (saved.clinicName !== input.clinicName) throw err.io('Settings could not be saved. Your changes were not applied.');
  return getSettings(ctx);
}
