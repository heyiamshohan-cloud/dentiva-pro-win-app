import { z } from 'zod';
import { uuid, text2000, dateStr, timeStr, pageQuery } from './common';
import { APPOINTMENT_STATUSES, QUEUE_STATUSES } from '../constants';

export const appointmentInput = z.object({
  patientId: uuid,
  dentistId: uuid.nullable().default(null),
  chair: z.string().trim().max(60).default(''),
  date: dateStr,
  startTime: timeStr,
  durationMin: z.number().int().min(5).max(480).default(30),
  type: z.string().trim().max(120).default('Consultation'),
  reason: text2000.default(''),
  notes: text2000.default(''),
});
export type AppointmentInput = z.infer<typeof appointmentInput>;
export const appointmentUpdate = appointmentInput.extend({ id: uuid });

export const appointmentSetStatus = z.object({
  id: uuid,
  status: z.enum(APPOINTMENT_STATUSES),
});

export const appointmentListQuery = pageQuery({
  from: dateStr.optional(),
  to: dateStr.optional(),
  dentistId: uuid.optional(),
  patientId: uuid.optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
});
export type AppointmentListQuery = z.infer<typeof appointmentListQuery>;

export const calendarQuery = z.object({ from: dateStr, to: dateStr, dentistId: uuid.optional() });

export const queueAdd = z.object({
  patientId: uuid,
  appointmentId: uuid.nullable().default(null),
  dentistId: uuid.nullable().default(null),
  date: dateStr.optional(),
});
export const queueSetStatus = z.object({ id: uuid, status: z.enum(QUEUE_STATUSES) });
export const queueListQuery = z.object({ date: dateStr.optional() });

export type CalendarQuery = z.infer<typeof calendarQuery>;
