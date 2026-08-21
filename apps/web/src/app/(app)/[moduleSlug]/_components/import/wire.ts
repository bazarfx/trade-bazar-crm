import type {
  FieldType,
  ImportAction,
  ImportCharset,
  ImportMapping,
  ImportStatus,
} from '@crm/shared';

/**
 * What the import endpoints answer with, as the wizard reads it.
 *
 * REDECLARED rather than imported from `@/lib/imports/service`: that module
 * carries `import 'server-only'`, and even a type-only import puts it in the
 * bundler's resolution graph for a `'use client'` module. Same reasoning as
 * `DirectoryUser` in `../directory.ts` and the wire types on the roles
 * screens — the shapes below are the WIRE, and the server owns the truth.
 *
 * Everything that is a genuine contract — the action set, the charset set, the
 * mapping shape, the caps — is imported from `@crm/shared` instead of being
 * restated here, so the wizard and the worker cannot drift apart about what an
 * import IS. Only the response envelopes live in this file.
 */

/** A field of the target module, as `GET /api/modules/{slug}/fields` serves
 *  it. A subset of `FieldDto`: the wizard reads nothing else. */
export interface ModuleField {
  key: string;
  label: string;
  type: FieldType;
  isRequired: boolean;
  isUnique: boolean;
  /** a configured default satisfies a required field with no column feeding
   *  it — the record engine applies it, so the commit does not 422 */
  defaultValue: unknown;
}

export interface ImportBatchWire {
  id: string;
  moduleSlug: string;
  filename: string;
  charset: string;
  headers: string[];
  mapping: ImportMapping;
  action: ImportAction;
  dedupeKey: string;
  total: number;
  succeeded: number;
  failed: number;
  status: ImportStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** The upload's answer: the batch, plus everything stage 4 needs to draw
 *  itself without a second round trip. */
export interface StagedImportWire {
  batch: ImportBatchWire;
  headers: string[];
  sample: Record<string, string>[];
  suggestedMapping: ImportMapping;
  unmappedColumns: string[];
  unmappedFields: { key: string; label: string; isRequired: boolean }[];
  truncated: boolean;
  fileRows: number;
}

export interface ImportProgressWire {
  id: string;
  status: ImportStatus;
  total: number;
  succeeded: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ImportRowErrorWire {
  rowNumber: number;
  error: string;
  raw: Record<string, string>;
}

/** Human labels for the charsets the parser can actually decode. Keyed on the
 *  whole union, so adding a charset to `IMPORT_CHARSETS` becomes a compile
 *  error here rather than an option with no label. */
export const CHARSET_LABELS: Record<ImportCharset, string> = {
  'utf-8': 'UTF-8 — the safe default',
  'utf-16le': 'UTF-16 LE',
  'windows-1252': 'Windows-1252 — Western European',
  'iso-8859-1': 'ISO-8859-1 — Latin-1',
};

/** A batch that is still moving. Polling stops at every other status. */
export function isRunningStatus(status: ImportStatus): boolean {
  return status === 'PENDING' || status === 'RUNNING';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** Thousands-separated, so 40000 reads as a quantity rather than as an id. */
export function formatCount(n: number): string {
  return n.toLocaleString();
}

export function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}

/** RFC 4180 quoting. A lead's own notes field routinely contains commas,
 *  quotes and newlines, and an error report that mangles them is a report the
 *  user cannot paste back into their spreadsheet. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  // CRLF, which is what every spreadsheet on Windows writes and expects back.
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * Hand the browser a file it never fetched.
 *
 * Built in memory rather than served from a route: the rows are already on
 * screen, and a download endpoint would be a second place where the error
 * report's scope check has to be right.
 */
export function downloadCsv(filename: string, csv: string): void {
  // The BOM is not decoration: without it Excel opens a UTF-8 CSV in the local
  // codepage and every accented name in the failed rows is mangled a second
  // time — in the file whose job is to explain the first mangling.
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
