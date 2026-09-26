import { describe, it, expect } from 'vitest';
import { patientInput } from '../../src/shared/validation/patients';
import { invoiceInput, paymentInput } from '../../src/shared/validation/finance';
import { prescriptionInput } from '../../src/shared/validation/clinical';
import { chartSetTooth } from '../../src/shared/validation/clinical';

const UUID = '3b241101-e2bb-4255-8caf-4136c566a962';

describe('validation: patientInput', () => {
  it('accepts a minimal patient with defaults', () => {
    const p = patientInput.parse({ name: 'Karim Uddin' });
    expect(p.tags).toEqual([]);
    expect(p.altPhone).toBe('');
  });
  it('requires a name', () => { expect(() => patientInput.parse({})).toThrow(); });
  it('rejects bad phone characters', () => { expect(() => patientInput.parse({ name: 'X', phone: 'abc123' })).toThrow(); });
  it('rejects bad dob', () => { expect(() => patientInput.parse({ name: 'X', dob: '1990/01/01' })).toThrow(); });
});

describe('validation: financial', () => {
  it('invoice requires at least one line', () => {
    expect(() => invoiceInput.parse({ patientId: UUID, lines: [] })).toThrow();
  });
  it('invoice accepts integer paisa only', () => {
    expect(() => invoiceInput.parse({ patientId: UUID, lines: [{ description: 'Consult', unitPricePaisa: 10.5 }] })).toThrow();
  });
  it('payment requires positive amount + valid method', () => {
    expect(() => paymentInput.parse({ patientId: UUID, amountPaisa: 0, method: 'cash' })).toThrow();
    expect(() => paymentInput.parse({ patientId: UUID, amountPaisa: 100, method: 'paypal' })).toThrow();
  });
});

describe('validation: prescription clinical lists', () => {
  it('accepts documented C/C and O/E options', () => {
    const p = prescriptionInput.parse({ patientId: UUID, cc: ['Pain On', 'Swelling'], oe: ['BDR', 'Dry Socket'], items: [] });
    expect(p.cc).toHaveLength(2);
  });
  it('rejects invented clinical options', () => {
    expect(() => prescriptionInput.parse({ patientId: UUID, cc: ['Toothache'] })).toThrow();
    expect(() => prescriptionInput.parse({ patientId: UUID, oe: ['Cavity'] })).toThrow();
  });
});

describe('validation: chartSetTooth FDI rules', () => {
  it('accepts valid adult and primary teeth', () => {
    expect(() => chartSetTooth.parse({ patientId: UUID, dentition: 'adult', tooth: 46, state: 'caries' })).not.toThrow();
    expect(() => chartSetTooth.parse({ patientId: UUID, dentition: 'primary', tooth: 61, state: 'restoration' })).not.toThrow();
  });
  it('rejects primary tooth in adult dentition and vice versa', () => {
    expect(() => chartSetTooth.parse({ patientId: UUID, dentition: 'adult', tooth: 51, state: 'caries' })).toThrow();
    expect(() => chartSetTooth.parse({ patientId: UUID, dentition: 'primary', tooth: 46, state: 'caries' })).toThrow();
    expect(() => chartSetTooth.parse({ patientId: UUID, dentition: 'adult', tooth: 19, state: 'caries' })).toThrow();
  });
});
