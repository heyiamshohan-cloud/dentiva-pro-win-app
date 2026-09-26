// Dentiva Pro - money core. ALL money is integer paisa (BDT smallest unit).
// No float arithmetic is ever used for money.

/** Parse a user-entered amount ("1,234.50", "1234", "12.3") into paisa. Throws on invalid input. */
export function parsePaisa(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Invalid amount');
    // Numbers coming over IPC are major-unit floats from the UI; convert deterministically.
    return Math.round(input * 100);
  }
  const cleaned = input.replace(/[,৳$\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error(`Invalid amount: "${input}"`);
  const neg = cleaned.startsWith('-');
  const [whole, frac = ''] = cleaned.replace('-', '').split('.');
  let paisa = parseInt(whole!, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  if (neg) paisa = -paisa;
  if (!Number.isSafeInteger(paisa)) throw new Error('Amount out of range');
  return paisa;
}

export function paisaToMajor(paisa: number): number {
  return paisa / 100;
}

/** Format paisa as human string, e.g. 1,234.50 (symbol optional, added by caller/settings). */
export function formatPaisa(paisa: number, symbol = ''): string {
  const neg = paisa < 0;
  const abs = Math.abs(paisa);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${symbol}${grouped}.${frac}`;
}

/** Deterministic half-up rounding of numerator*percentBp/10000 to integer paisa. percentBp: basis points (1500 = 15.00%). */
export function percentOf(amountPaisa: number, percentBp: number): number {
  const n = BigInt(amountPaisa) * BigInt(percentBp);
  const d = 10000n;
  const q = n / d;
  const r = n % d;
  return Number(r * 2n >= d ? q + 1n : q);
}

export function assertPaisa(v: number, field: string): void {
  if (!Number.isSafeInteger(v)) throw new Error(`${field} must be an integer paisa amount`);
}

export interface InvoiceMathInput {
  lines: { qty: number; unitPricePaisa: number; discountPaisa?: number }[];
  discountPaisa?: number;   // overall invoice discount (absolute paisa)
  taxBp?: number;           // tax as basis points of (subtotal - discount)
  taxPaisa?: number;        // or absolute tax paisa (overrides taxBp)
}

export interface InvoiceMathResult {
  lineTotals: number[];
  subtotalPaisa: number;
  discountPaisa: number;
  taxPaisa: number;
  totalPaisa: number;
}

/** The single invoice calculation function used everywhere (service, UI preview, tests, PDF assertions). */
export function computeInvoice(input: InvoiceMathInput): InvoiceMathResult {
  const lineTotals = input.lines.map((l) => {
    if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new Error('Line quantity must be a positive integer');
    assertPaisa(l.unitPricePaisa, 'unit price');
    const d = l.discountPaisa ?? 0;
    if (d < 0) throw new Error('Line discount cannot be negative');
    const total = l.qty * l.unitPricePaisa - d;
    if (total < 0) throw new Error('Line discount exceeds line amount');
    return total;
  });
  const subtotalPaisa = lineTotals.reduce((a, b) => a + b, 0);
  const discountPaisa = input.discountPaisa ?? 0;
  if (discountPaisa < 0) throw new Error('Discount cannot be negative');
  if (discountPaisa > subtotalPaisa) throw new Error('Discount cannot exceed subtotal');
  const taxable = subtotalPaisa - discountPaisa;
  const taxPaisa = input.taxPaisa ?? (input.taxBp ? percentOf(taxable, input.taxBp) : 0);
  if (taxPaisa < 0) throw new Error('Tax cannot be negative');
  const totalPaisa = taxable + taxPaisa;
  return { lineTotals, subtotalPaisa, discountPaisa, taxPaisa, totalPaisa };
}
