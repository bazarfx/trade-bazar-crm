/**
 * Stage 1 of the wizard: bytes → a header row and a list of text rows.
 *
 * Parsing runs INSIDE the request, and that is deliberate rather than a
 * shortcut. CLAUDE.md forbids background work in a route handler and names a
 * multi-megabyte import as the example — but what it forbids is ROW
 * PROCESSING: forty thousand records, each one a transaction, an assignment
 * and an audit row. Reading a file into rows is the opposite kind of work. It
 * has to happen before the user can be shown a preview, a charset choice or a
 * column mapping at all, and none of stages 2–5 exist until it has.
 *
 * Two things in here decide whether an import is correct or quietly wrong:
 *
 *  1. **The charset.** A Windows-1252 export decoded as UTF-8 turns every
 *     accented name into mojibake. On a lead list that is not cosmetic — the
 *     name is what an agent reads out on the call — and it is invisible until
 *     someone complains. So the decode is explicit, a BOM overrides the
 *     choice, and the decoded rows go straight back to the wizard as the
 *     preview the user confirms.
 *  2. **What we refuse.** The Figma's file list shows VCF and XLS. We read CSV
 *     and XLSX. Anything else is refused BY NAME here, at upload, rather than
 *     accepted and reported later as a file full of failed rows.
 */
import 'server-only';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  IMPORT_SUPPORTED_EXTENSIONS,
  type ImportCharset,
  type ImportFormat,
} from '@crm/shared';
import { ConfigError } from '@/lib/config/service';

export interface ParsedFile {
  format: ImportFormat;
  /** what the bytes were ACTUALLY decoded with — a BOM overrides the choice */
  charset: ImportCharset;
  /** the header row, in file order, exactly as it reads in the file */
  headers: string[];
  /** one entry per data row, keyed by header text */
  rows: Record<string, string>[];
  /** true when the file held more rows than `IMPORT_MAX_ROWS` and the tail was
   *  dropped. The caller must say so — a silently short import is a lie. */
  truncated: boolean;
  /** rows the file actually held, before the cap */
  fileRows: number;
}

const unsupported = (what: string): ConfigError =>
  new ConfigError(
    `${what}. Supported formats are ${IMPORT_SUPPORTED_EXTENSIONS.join(' and ')}.`,
    422,
    'VALIDATION',
  );

// ── what kind of file is this ─────────────────────────────────────────────

/** Leading bytes, as a hex string, for sniffing. */
function magic(bytes: Uint8Array, length: number): string {
  return [...bytes.slice(0, length)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Decide the format from the CONTENT first and the extension second.
 *
 * A user renaming `export.xls` to `export.csv` is routine, and so is a browser
 * handing us a generic content-type. The bytes cannot be renamed, so they win;
 * the extension only breaks the tie for text, which has no magic number.
 */
function detectFormat(filename: string, bytes: Uint8Array): ImportFormat {
  const head = magic(bytes, 8);

  // PK\x03\x04 — a zip container, which is what an .xlsx is.
  if (head.startsWith('504b0304')) return 'xlsx';

  // OLE2 compound document: the pre-2007 .xls binary (and .doc, and .ppt).
  // A different format from .xlsx, not an older dialect of it.
  if (head.startsWith('d0cf11e0a1b11ae1')) {
    throw unsupported('That is a legacy .xls workbook. Save it as .xlsx or .csv and upload again');
  }

  // Cheap text sniff for the two formats a contact list arrives as.
  const start = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, 64))
    .replace(/^﻿/, '')
    .trimStart()
    .toUpperCase();
  if (start.startsWith('BEGIN:VCARD')) {
    throw unsupported('That is a vCard (.vcf) contact file, which has no columns to map');
  }
  if (start.startsWith('%PDF') || head.startsWith('25504446')) {
    throw unsupported('That is a PDF');
  }

  const lowered = filename.toLowerCase();
  if (lowered.endsWith('.csv') || lowered.endsWith('.tsv') || lowered.endsWith('.txt')) return 'csv';
  if (lowered.endsWith('.xlsx')) {
    // Named .xlsx but not a zip — truncated upload, or renamed something else.
    throw unsupported('That file is named .xlsx but is not a readable workbook');
  }

  throw unsupported(`"${filename}" is not a format this import can read`);
}

// ── bytes → text ──────────────────────────────────────────────────────────

/**
 * Decode with the chosen charset, unless the file states its own.
 *
 * A BOM is the file telling us what it is, and it beats a dropdown every time:
 * Excel's "CSV UTF-8" export always writes one, and a user who leaves the
 * selector on its default would otherwise read every accented name wrong.
 * UTF-16 BE is refused rather than guessed — the charset list the wizard
 * offers does not contain it, and recording a batch as decoded with something
 * it was not makes a re-parse irreproducible.
 */
function decodeText(bytes: Uint8Array, chosen: ImportCharset): { text: string; charset: ImportCharset } {
  const head = magic(bytes, 3);

  if (head.startsWith('efbbbf')) {
    return { text: new TextDecoder('utf-8').decode(bytes.slice(3)), charset: 'utf-8' };
  }
  if (head.startsWith('fffe')) {
    return { text: new TextDecoder('utf-16le').decode(bytes.slice(2)), charset: 'utf-16le' };
  }
  if (head.startsWith('feff')) {
    throw new ConfigError(
      'This file is UTF-16 big-endian, which this import cannot read. Re-save it as UTF-8.',
      422,
      'VALIDATION',
    );
  }

  try {
    return { text: new TextDecoder(chosen).decode(bytes), charset: chosen };
  } catch {
    // An unknown label can only come from a hand-made request; the schema
    // bounds what the wizard can send.
    throw new ConfigError(`"${chosen}" is not a character set this import can read`, 422, 'VALIDATION');
  }
}

// ── shared row assembly ───────────────────────────────────────────────────

/**
 * Turn a header row and a grid of cells into keyed rows.
 *
 * Two rules that both exist to stop a silent mismapping:
 *
 *  - **A duplicate header is refused.** The mapping is keyed by header TEXT so
 *    that it can be reused as a preset (see `importMappingSchema`), and two
 *    columns called "Email" make that key ambiguous. Renaming one silently
 *    would put the wrong column's values into the field.
 *  - **A blank header is dropped only when its column is empty.** Trailing
 *    empty columns are what every spreadsheet export produces; a blank header
 *    with data underneath is a real column nobody can map, so it is named.
 */
function assemble(headerCells: string[], dataRows: string[][]): { headers: string[]; rows: Record<string, string>[] } {
  const width = headerCells.length;
  const keep: number[] = [];
  const headers: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < width; i += 1) {
    const raw = (headerCells[i] ?? '').trim();

    if (raw === '') {
      const hasData = dataRows.some((r) => (r[i] ?? '').trim() !== '');
      if (!hasData) continue;
      throw new ConfigError(
        `Column ${i + 1} has no heading. Give every column a heading and upload again.`,
        422,
        'VALIDATION',
      );
    }

    if (seen.has(raw)) {
      throw new ConfigError(
        `Two columns are both headed "${raw}". Column headings must be unique — rename one and upload again.`,
        422,
        'VALIDATION',
      );
    }
    seen.add(raw);
    keep.push(i);
    headers.push(raw);
  }

  if (headers.length === 0) {
    throw new ConfigError('That file has no column headings in its first row', 422, 'VALIDATION');
  }
  if (headers.length > IMPORT_MAX_COLUMNS) {
    throw new ConfigError(
      `That file has ${headers.length} columns; the limit is ${IMPORT_MAX_COLUMNS}.`,
      422,
      'VALIDATION',
    );
  }

  const rows: Record<string, string>[] = [];
  for (const cells of dataRows) {
    const row: Record<string, string> = {};
    let hasValue = false;
    keep.forEach((index, position) => {
      // Trimmed: a trailing space in a spreadsheet is invisible, and " Rahul"
      // stored as a name is a defect nobody can see to fix.
      const value = (cells[index] ?? '').trim();
      const header = headers[position];
      if (header !== undefined) row[header] = value;
      if (value !== '') hasValue = true;
    });
    // A row of nothing is a spreadsheet artefact, not a record. Importing it
    // would fail every required field and fill the error report with noise.
    if (hasValue) rows.push(row);
  }

  return { headers, rows };
}

// ── CSV ───────────────────────────────────────────────────────────────────

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[]; fileRows: number; truncated: boolean } {
  // `header: false` deliberately: papaparse's header mode silently overwrites
  // a duplicate column, which is exactly the failure `assemble` refuses to let
  // happen. The delimiter is auto-detected, which covers the tab-separated
  // exports that arrive named .csv.
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });

  const grid = parsed.data;
  const headerCells = grid[0];
  if (!headerCells) throw new ConfigError('That file is empty', 422, 'VALIDATION');

  const body = grid.slice(1);
  const truncated = body.length > IMPORT_MAX_ROWS;
  const { headers, rows } = assemble(headerCells, truncated ? body.slice(0, IMPORT_MAX_ROWS) : body);
  return { headers, rows, fileRows: body.length, truncated };
}

// ── XLSX ──────────────────────────────────────────────────────────────────

/** Anything exceljs can hand back for a cell, narrowed to what we read. */
interface RichCell {
  richText?: { text?: string }[];
  text?: string;
  result?: unknown;
  error?: string;
  hyperlink?: string;
  formula?: string;
}

/**
 * One cell as text.
 *
 * A workbook cell is not a string: it can be a number, a date, a formula with
 * a cached result, rich text in three fonts, or a hyperlink. Every one of them
 * has to become the same kind of text a CSV would have given, because the
 * mapping and the type coercion downstream are written against exactly one
 * input shape. An error cell keeps its `#REF!` rather than becoming empty — a
 * row that fails loudly is better than a field that silently arrives blank.
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (typeof value === 'object') {
    const cell = value as RichCell;
    if (Array.isArray(cell.richText)) return cell.richText.map((r) => r?.text ?? '').join('');
    if (cell.error !== undefined) return String(cell.error);
    if (cell.result !== undefined) return cellText(cell.result);
    // A hyperlink's TEXT is what the user sees and meant; the href is not data
    // the record engine has any field for.
    if (cell.text !== undefined) return String(cell.text);
    if (cell.formula !== undefined) return '';
  }

  return String(value);
}

async function parseXlsx(
  bytes: Uint8Array,
): Promise<{ headers: string[]; rows: Record<string, string>[]; fileRows: number; truncated: boolean }> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs wants a Node Buffer. `Buffer.from(view)` copies, which is what we
    // want: the underlying ArrayBuffer is released with the request.
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  } catch {
    throw unsupported('That workbook could not be read — it may be password-protected or corrupt');
  }

  // The first VISIBLE sheet. A hidden first sheet is usually a lookup table
  // some template left behind, and importing it would import nothing useful.
  const sheet =
    workbook.worksheets.find((w) => w.state !== 'hidden' && w.state !== 'veryHidden') ??
    workbook.worksheets[0];
  if (!sheet) throw unsupported('That workbook has no sheets');

  const width = Math.max(sheet.actualColumnCount, sheet.columnCount, 0);
  if (width === 0) throw new ConfigError('That sheet is empty', 422, 'VALIDATION');

  const readRow = (rowNumber: number): string[] => {
    const row = sheet.getRow(rowNumber);
    const cells: string[] = [];
    for (let c = 1; c <= width; c += 1) cells.push(cellText(row.getCell(c).value));
    return cells;
  };

  const headerCells = readRow(1);
  const body: string[][] = [];
  let fileRows = 0;
  let truncated = false;

  // `sheet.rowCount` counts to the last row that carries any formatting, so a
  // sheet styled to row 5000 iterates 5000 times for 40 records. That is
  // bounded by the file size cap and the blank rows are dropped by `assemble`.
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    fileRows += 1;
    if (body.length >= IMPORT_MAX_ROWS) {
      truncated = true;
      continue;
    }
    body.push(readRow(r));
  }

  const { headers, rows } = assemble(headerCells, body);
  return { headers, rows, fileRows, truncated };
}

// ── the one entry point ───────────────────────────────────────────────────

export interface ParseInput {
  filename: string;
  bytes: ArrayBuffer;
  charset: ImportCharset;
}

/**
 * The size gate, callable BEFORE the bytes are copied out of the upload.
 *
 * Stated once here rather than in the route as well: the parser owns the cap
 * because the parser is what the cap is about, and a second copy of the number
 * would drift the moment one of them is tuned.
 */
export function assertUploadSize(byteLength: number): void {
  if (byteLength === 0) throw new ConfigError('That file is empty', 422, 'VALIDATION');
  if (byteLength > IMPORT_MAX_BYTES) {
    throw new ConfigError(
      `That file is ${(byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${IMPORT_MAX_BYTES / 1024 / 1024} MB. Split it and import the parts.`,
      413,
      'VALIDATION',
    );
  }
}

export async function parseImportFile({ filename, bytes, charset }: ParseInput): Promise<ParsedFile> {
  assertUploadSize(bytes.byteLength);

  const view = new Uint8Array(bytes);
  const format = detectFormat(filename, view);

  if (format === 'xlsx') {
    // A workbook carries its own encoding (it is XML inside a zip), so the
    // charset selector does not apply. Recording utf-8 keeps the batch honest
    // about what was actually used.
    const { headers, rows, fileRows, truncated } = await parseXlsx(view);
    return { format, charset: 'utf-8', headers, rows, truncated, fileRows };
  }

  const decoded = decodeText(view, charset);
  const { headers, rows, fileRows, truncated } = parseCsv(decoded.text);
  return { format, charset: decoded.charset, headers, rows, truncated, fileRows };
}
