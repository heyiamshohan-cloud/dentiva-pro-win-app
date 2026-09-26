// Dentiva Pro - PDF engine: consistent layout system with multi-page tables,
// repeating headers, page numbers, and professional typography.
// Core PDF fonts (Helvetica) are used for deterministic, verifiable output;
// currency renders via the configurable ASCII label (default "Tk").
import PDFDocument from 'pdfkit';
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatPaisa } from '../../shared/money';
import { PaperSize } from '../../shared/constants';

const COLORS = {
  ink: '#1a202c', muted: '#5b6472', faint: '#9aa3af', line: '#d4d9e0',
  band: '#f2f5f8', accent: '#0f4c5c', white: '#ffffff', danger: '#b91c1c',
};

export const PAPER: Record<PaperSize, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
  LETTER: { width: 612, height: 792 },
  '80MM': { width: 226.77, height: 841.89 },
};

export interface ClinicBrand {
  clinicName: string; tagline: string; address: string; phone: string; email: string;
  website: string; registrationNo: string; dentistName: string; dentistDegrees: string;
  currencyLabel: string; taxLabel: string;
  invoiceFooter: string; receiptFooter: string; prescriptionFooter: string;
  timezone: string;
}

interface BuilderOptions {
  paper: PaperSize;
  brand: ClinicBrand;
  docTitle: string;
  docNoLabel: string;
  docNo: string;
  dateLabel: string;
  dateValue: string;
  headerFooterNote?: string;
}

export interface Column {
  label: string;
  width: number; // fraction 0..1 of available width
  align?: 'left' | 'right' | 'center';
  key: string;
}

export class PdfBuilder {
  doc: PDFKit.PDFDocument;
  readonly paper: PaperSize;
  private brand: ClinicBrand;
  private opts: BuilderOptions;
  private margin: number;
  private maxY: number;
  private narrow: boolean;

  private constructor(opts: BuilderOptions) {
    this.opts = opts;
    this.brand = opts.brand;
    this.paper = opts.paper;
    this.narrow = opts.paper === '80MM';
    this.margin = this.narrow ? 14 : 42;
    const size = PAPER[opts.paper];
    this.doc = new PDFDocument({
      size: [size.width, opts.paper === '80MM' ? 1200 : size.height],
      margins: { top: this.margin, bottom: this.margin, left: this.margin, right: this.margin },
      bufferPages: true,
      info: { Title: `${opts.docTitle} ${opts.docNo}`, Author: opts.brand.clinicName, Creator: 'Dentiva Pro' },
    });
    this.maxY = this.doc.page.height - this.margin - (this.narrow ? 24 : 34);
    this.drawHeader();
  }

  static create(opts: BuilderOptions): PdfBuilder {
    return new PdfBuilder(opts);
  }

  get width(): number {
    return this.doc.page.width - this.margin * 2;
  }

  get left(): number {
    return this.margin;
  }

  get isNarrow(): boolean {
    return this.narrow;
  }

  get y(): number {
    return this.doc.y;
  }

  setY(y: number): void {
    this.doc.y = y;
  }

  money(paisa: number): string {
    return `${this.brand.currencyLabel} ${formatPaisa(paisa)}`;
  }

  moneySigned(paisa: number): string {
    const sign = paisa < 0 ? '-' : '';
    return `${sign}${this.brand.currencyLabel} ${formatPaisa(Math.abs(paisa))}`;
  }

  private font(bold = false, size = this.narrow ? 7.5 : 9): PDFKit.PDFDocument {
    return this.doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(COLORS.ink);
  }

  private drawHeader(): void {
    const { brand, opts } = { brand: this.brand, opts: this.opts };
    const d = this.doc;
    if (this.narrow) {
      d.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.ink).text(brand.clinicName, this.margin, this.margin, { width: this.width, align: 'center' });
      const meta = [brand.address, brand.phone && `Tel: ${brand.phone}`, brand.registrationNo && `Reg: ${brand.registrationNo}`].filter(Boolean).join(' | ');
      d.font('Helvetica').fontSize(6.5).fillColor(COLORS.muted).text(meta, this.margin, d.y + 1, { width: this.width, align: 'center' });
      d.moveDown(0.4);
      this.rule();
      d.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.ink)
        .text(`${opts.docTitle}`, this.margin, d.y + 2, { width: this.width, align: 'center', continued: false });
      d.font('Helvetica').fontSize(7).text(`${opts.docNoLabel}: ${opts.docNo}   ${opts.dateLabel}: ${opts.dateValue}`, { width: this.width, align: 'center' });
      d.moveDown(0.3);
      this.rule();
      d.moveDown(0.3);
      return;
    }
    const x = this.margin;
    const top = this.margin - 4;
    d.font('Helvetica-Bold').fontSize(17).fillColor(COLORS.accent).text(brand.clinicName, x, top, { width: this.width * 0.62 });
    d.font('Helvetica').fontSize(8).fillColor(COLORS.muted);
    const leftLines = [brand.tagline, brand.address, [brand.phone && `Tel: ${brand.phone}`, brand.email].filter(Boolean).join('  ·  '), [brand.website, brand.registrationNo && `Reg. No: ${brand.registrationNo}`].filter(Boolean).join('  ·  ')].filter(Boolean);
    let ly = d.y + 1;
    for (const line of leftLines) { d.text(line, x, ly, { width: this.width * 0.62 }); ly = d.y; }
    const rx = this.margin + this.width * 0.64;
    d.font('Helvetica-Bold').fontSize(14).fillColor(COLORS.ink).text(opts.docTitle, rx, top, { width: this.width * 0.36, align: 'right' });
    d.font('Helvetica').fontSize(9).fillColor(COLORS.ink)
      .text(`${opts.docNoLabel}: `, rx, d.y + 4, { width: this.width * 0.36, align: 'right', continued: true })
      .font('Helvetica-Bold').text(opts.docNo);
    d.font('Helvetica').fontSize(9).fillColor(COLORS.muted).text(`${opts.dateLabel}: ${opts.dateValue}`, rx, d.y + 2, { width: this.width * 0.36, align: 'right' });
    d.y = Math.max(ly, d.y) + 6;
    this.rule(1.4, COLORS.accent);
    d.moveDown(0.5);
  }

  rule(weight = 0.6, color = COLORS.line): void {
    const d = this.doc;
    d.save().lineWidth(weight).strokeColor(color)
      .moveTo(this.margin, d.y).lineTo(this.margin + this.width, d.y).stroke().restore();
  }

  /** Reserve vertical space; page-break (with repeated header) when needed. */
  ensure(height: number, repeat?: () => void): void {
    if (this.doc.y + height > this.maxY) {
      this.doc.addPage();
      this.drawHeader();
      repeat?.();
    }
  }

  section(title: string): void {
    this.ensure(this.narrow ? 16 : 22);
    this.doc.moveDown(0.35);
    this.font(true, this.narrow ? 8 : 10).fillColor(COLORS.accent).text(title, this.margin, this.doc.y );
    this.rule(0.8, COLORS.accent);
    this.doc.moveDown(0.25);
  }

  kvGrid(pairs: [string, string][], cols = 2): void {
    const d = this.doc;
    const colW = this.width / cols;
    for (let i = 0; i < pairs.length; i += cols) {
      const slice = pairs.slice(i, i + cols);
      let maxH = 0;
      const x0 = this.margin;
      const y0 = d.y;
      slice.forEach(([k, v], j) => {
        const hK = d.heightOfString(k, { width: colW - 8 });
        const hV = d.font('Helvetica').heightOfString(v || '—', { width: colW - 8 });
        maxH = Math.max(maxH, hK + hV + 3);
      });
      this.ensure(maxH + 3);
      const y = d.y;
      slice.forEach(([k, v], j) => {
        d.font('Helvetica').fontSize(this.narrow ? 6 : 7).fillColor(COLORS.faint).text(k.toUpperCase(), x0 + j * colW, y, { width: colW - 8 });
        this.font(false).text(v || '—', x0 + j * colW, d.y + 0.5, { width: colW - 8 });
      });
      d.y = y + maxH + 2;
      d.x = this.margin;
    }
  }

  /** Multi-page table with repeating header. Cells are rendered with real height measurement. */
  table(columns: Column[], rows: Record<string, string>[], opts: { rowPadding?: number; fontSize?: number } = {}): void {
    const d = this.doc;
    const pad = opts.rowPadding ?? (this.narrow ? 2 : 3.5);
    const fontSize = opts.fontSize ?? (this.narrow ? 7 : 8.5);
    const widths = columns.map((c) => c.width * this.width);
    const headerH = fontSize + pad * 2 + 4;

    const drawHeaderRow = (): void => {
      const y = d.y;
      d.save().rect(this.margin, y, this.width, headerH).fill(COLORS.accent).restore();
      let x = this.margin;
      columns.forEach((c, i) => {
        d.font('Helvetica-Bold').fontSize(fontSize - 0.5).fillColor(COLORS.white)
          .text(c.label, x + 4, y + pad + 1, { width: widths[i]! - 8, align: c.align ?? 'left', lineBreak: false });
        x += widths[i]!;
      });
      d.y = y + headerH;
      d.x = this.margin;
    };

    this.ensure(headerH + fontSize + pad * 2);
    drawHeaderRow();
    let zebra = false;
    for (const row of rows) {
      d.font('Helvetica').fontSize(fontSize);
      const heights = columns.map((c, i) => d.heightOfString(String(row[c.key] ?? ''), { width: widths[i]! - 8 }));
      const rowH = Math.max(...heights, fontSize) + pad * 2;
      this.ensure(rowH, drawHeaderRow);
      const y = d.y;
      if (zebra) d.save().rect(this.margin, y, this.width, rowH).fill(COLORS.band).restore();
      let x = this.margin;
      columns.forEach((c, i) => {
        d.font('Helvetica').fontSize(fontSize).fillColor(COLORS.ink)
          .text(String(row[c.key] ?? ''), x + 4, y + pad, { width: widths[i]! - 8, align: c.align ?? 'left' });
        x += widths[i]!;
      });
      d.y = y + rowH;
      d.save().lineWidth(0.4).strokeColor(COLORS.line).moveTo(this.margin, d.y).lineTo(this.margin + this.width, d.y).stroke().restore();
      d.x = this.margin;
      zebra = !zebra;
    }
    d.moveDown(0.3);
  }

  totals(rows: [string, string, boolean?][]): void {
    const d = this.doc;
    const w = this.narrow ? this.width : Math.min(230, this.width * 0.45);
    const x = this.narrow ? this.margin : this.margin + this.width - w;
    const rowH = this.narrow ? 12 : 15;
    const needed = rows.length * rowH + 8;
    this.ensure(needed);
    let y = d.y;
    this.rule();
    y += 3;
    for (const [label, value, strong] of rows) {
      d.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? (this.narrow ? 8.5 : 10) : (this.narrow ? 7.5 : 9))
        .fillColor(strong ? COLORS.accent : COLORS.ink)
        .text(label, x, y, { width: w * 0.55 })
        .text(value, x, y, { width: w, align: 'right' });
      y += rowH;
      if (strong) { d.save().lineWidth(0.8).strokeColor(COLORS.accent).moveTo(x, y - 3).lineTo(x + w, y - 3).stroke().restore(); }
    }
    d.y = y + 2;
    d.x = this.margin;
  }

  para(text: string, opts: { italic?: boolean; size?: number } = {}): void {
    const d = this.doc;
    d.font(opts.italic ? 'Helvetica-Oblique' : 'Helvetica').fontSize(opts.size ?? (this.narrow ? 7.5 : 9));
    const h = d.heightOfString(text, { width: this.width });
    this.ensure(h + 3);
    d.fillColor(COLORS.ink).text(text, this.margin, d.y, { width: this.width });
    d.moveDown(0.2);
  }

  space(n = 0.5): void {
    this.doc.moveDown(n);
  }

  /** Finalize: paint footers with page numbers on every page, then resolve the file path. */
  async save(outDir: string, fileName: string, footerNote: string): Promise<{ path: string; pageCount: number }> {
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, fileName);
    const stream = createWriteStream(path);
    this.doc.pipe(stream);
    const range = this.doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i);
      const pageH = this.doc.page.height;
      const footerY = pageH - this.margin - (this.narrow ? 12 : 16);
      this.doc.save().lineWidth(0.5).strokeColor(COLORS.line)
        .moveTo(this.margin, footerY - 6).lineTo(this.margin + this.width, footerY - 6).stroke().restore();
      this.doc.font('Helvetica').fontSize(this.narrow ? 6 : 7.5).fillColor(COLORS.muted)
        .text(footerNote, this.margin, footerY, { width: this.width * 0.7, lineBreak: false })
        .text(`Page ${i + 1} of ${range.count}`, this.margin + this.width * 0.7, footerY, { width: this.width * 0.3, align: 'right', lineBreak: false });
    }
    this.doc.end();
    await new Promise<void>((resolve, reject) => {
      stream.on('finish', () => resolve());
      stream.on('error', reject);
    });
    return { path, pageCount: range.count };
  }
}

export const pdfColors = COLORS;
