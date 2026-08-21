'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  IMPORT_DEDUPE_NONE,
  IMPORT_MAX_BYTES,
  IMPORT_SUPPORTED_EXTENSIONS,
  mappedColumns,
  type ImportAction,
  type ImportAssignment,
  type ImportCharset,
  type ImportMapping,
  type ImportPatchInput,
} from '@crm/shared';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button } from '@/components/ui';
import { api } from '@/lib/client-api';
import { requiredGaps } from './mapping';
import { ImportRun } from './import-run';
import { StageActions } from './stage-actions';
import { StageAssign } from './stage-assign';
import { StageFieldMapping } from './stage-field-mapping';
import { StageModuleFile } from './stage-module-file';
import { StageStrip } from './stage-strip';
import { StageUpload } from './stage-upload';
import {
  formatBytes,
  messageOf,
  type ImportBatchWire,
  type ImportProgressWire,
  type ModuleField,
  type StagedImportWire,
} from './wire';

/**
 * THE import wizard — the last of the six designed screens, and the only one
 * whose work outlives the window it was started in.
 *
 * One overlay serves every module. Nothing in this folder knows what a lead
 * is: the module comes from the URL, its label from `ModuleDefinition`, the
 * fields in the mapping picker from `FieldDefinition`, the match keys from the
 * field-type operator registry, and the routing from the Admin's nominated
 * pointers. "Import Invoices" is this same component the day somebody creates
 * that module without calling anyone.
 *
 * WHERE THE WORK HAPPENS. Parsing and staging run while the upload request is
 * open, which CLAUDE.md allows. ROW PROCESSING does not: the commit enqueues
 * and returns, and the worker writes every row through `createRecord` — same
 * validation, same assignment engine, same audit rows. That is why the last
 * screen here is a progress view and not a spinner, and why closing it is
 * harmless.
 *
 * WHAT THIS FILE MAY NOT DECIDE. Every gate below is a mirror of one the
 * commit enforces. The server is the authority and answers 422; this is only
 * the difference between finding out now and finding out after five stages.
 */

/**
 * The stage strip, verbatim from the file except for one word: it reads
 * "Fileld Mapping" there, alongside "peocessed" and "Brouse Files". A design
 * file's typo is not a specification.
 */
const STAGES = [
  'Upload',
  'Actions',
  'Module-File Mapping',
  'Field Mapping',
  'Assign',
] as const;

const UPLOAD = 0;
const ACTIONS = 1;
const MODULE_FILE = 2;
const FIELD_MAPPING = 3;
const ASSIGN = 4;

const EMPTY_MAPPING: ImportMapping = { columns: [] };

export interface ImportWizardProps {
  slug: string;
  /** module.labelPlural — what a set of these records is called. */
  labelPlural: string;
  /**
   * Field key → `FieldDefinition.systemColumn`, from the page. `FieldDto` does
   * not serialise the column and stage 4 needs it: a required field the ENGINE
   * fills (the owner, the opening status) needs no column in the file, and
   * demanding one would make every import impossible. Read as a column, never
   * as a field key or a label — see `mapping.ts`.
   */
  systemColumns: Record<string, string | null>;
  /** this module's rows carry an owner at all — decides whether stage 5 has
   *  anything to ask */
  hasOwner: boolean;
  onClose: () => void;
}

export function ImportWizard({
  slug,
  labelPlural,
  systemColumns,
  hasOwner,
  onClose,
}: ImportWizardProps) {
  const router = useRouter();
  const trackPrefix = `${slug}.import`;

  const [stage, setStage] = useState<number>(UPLOAD);
  const [charset, setCharset] = useState<ImportCharset>('utf-8');
  // The File itself, not just its name: changing the charset after seeing a
  // mangled preview has to re-read the same bytes, and a File handle is the
  // only way back to them without asking the user to find the file again.
  const [file, setFile] = useState<File | null>(null);
  const [staged, setStaged] = useState<StagedImportWire | null>(null);
  const [fields, setFields] = useState<ModuleField[]>([]);
  const [fieldsLoading, setFieldsLoading] = useState(true);
  const [fieldsFailed, setFieldsFailed] = useState(false);
  const [mapping, setMapping] = useState<ImportMapping>(EMPTY_MAPPING);
  const [action, setAction] = useState<ImportAction>('ADD_NEW');
  const [dedupeKey, setDedupeKey] = useState<string>(IMPORT_DEDUPE_NONE);
  const [assignment, setAssignment] = useState<ImportAssignment>({ mode: 'RULES' });
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** set once the batch is with the worker; the wizard becomes a viewer */
  const [run, setRun] = useState<ImportBatchWire | null>(null);

  // The module's fields, for the mapping picker's labels and types. Fetched
  // once on open rather than when stage 4 is reached: the user will be there
  // in seconds and a select that arrives empty reads as a broken screen.
  useEffect(() => {
    let cancelled = false;
    api<{ fields: ModuleField[] }>(`/api/modules/${slug}/fields`)
      .then((res) => {
        if (cancelled) return;
        setFields(res.fields);
        setFieldsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Recorded as a FAILURE rather than as "this module has no fields":
        // an empty catalogue would quietly switch off the required-field
        // warning, which is the one check standing between the user and a
        // commit that 422s on every row.
        setFields([]);
        setFieldsLoading(false);
        setFieldsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  /**
   * The fields this import may write, exactly as the SERVER decided.
   *
   * Not re-derived from the field list: the server drops hidden fields,
   * read-only fields and types no spreadsheet cell can feed, and a picker that
   * offered one of those would offer a mapping that fails on every row. The
   * upload's answer already carries that set — the fields it auto-mapped, plus
   * the ones it reported as unmapped — so the catalogue is the join of the two
   * against the labels and types from `GET /fields`.
   */
  const catalogue = useMemo<ModuleField[]>(() => {
    if (staged === null) return [];
    const allowed = new Set(staged.unmappedFields.map((f) => f.key));
    for (const column of staged.suggestedMapping.columns) {
      if (column.field !== null) allowed.add(column.field);
    }
    return fields.filter((f) => allowed.has(f.key));
  }, [staged, fields]);

  /**
   * Why the user cannot leave this stage yet, or null.
   *
   * Each branch names the commit check it shadows. Being STRICTER here than
   * the server is safe; being looser is not, because it would walk somebody
   * through five stages to a refusal.
   */
  function blockerFor(index: number): string | null {
    if (staged === null) {
      return index === UPLOAD ? 'Upload a file to continue.' : 'Upload a file first.';
    }

    if (index === ACTIONS) {
      if (dedupeKey === IMPORT_DEDUPE_NONE && action !== 'ADD_NEW') {
        return 'With no match key nothing can match, so this combination would import nothing. Choose a field to match on, or switch to “Add new only”.';
      }
      return null;
    }

    if (index === FIELD_MAPPING) {
      // Without the field list there is no catalogue, and with no catalogue
      // `requiredGaps` cannot find a gap — the check would pass by being
      // blind. Blocking is the only safe reading of "we do not know yet".
      if (fieldsLoading) return 'Still reading this module’s fields.';
      if (fieldsFailed) {
        return 'This module’s fields could not be read, so the mapping cannot be checked. Close the wizard and try again.';
      }
      if (mappedColumns(mapping).length === 0) {
        return 'Map at least one column to a field before importing.';
      }
      const gaps = requiredGaps(catalogue, mapping, systemColumns);
      if (gaps.length > 0) {
        return `These fields are required and no column feeds them: ${gaps.map((f) => f.label).join(', ')}.`;
      }
      if (dedupeKey !== IMPORT_DEDUPE_NONE) {
        const fed = mappedColumns(mapping).some((c) => c.field === dedupeKey);
        if (!fed) {
          const label = catalogue.find((f) => f.key === dedupeKey)?.label ?? dedupeKey;
          return `Map a column to “${label}” — it is what existing records are matched on.`;
        }
      }
      return null;
    }

    if (index === ASSIGN) {
      if (hasOwner && assignment.mode === 'OWNER' && assignment.ownerId === '') {
        return 'Choose the user these records should belong to.';
      }
      return null;
    }

    return null;
  }

  /**
   * How far the answers so far allow the strip to jump: up to and including
   * the first stage that is not satisfied.
   *
   * Recomputed every render rather than memoised — it reads eight pieces of
   * state, and a dependency list that fell out of step with `blockerFor` would
   * unlock a stage the commit then refuses.
   */
  let furthest = STAGES.length - 1;
  for (let i = 0; i < STAGES.length; i += 1) {
    if (blockerFor(i) !== null) {
      furthest = i;
      break;
    }
  }

  /** `advance` is false for a re-read: the user changed the charset to LOOK at
   *  the preview again, and moving them off the stage that draws it would
   *  answer a question by hiding it. */
  async function upload(picked: File, advance = true): Promise<void> {
    const lower = picked.name.toLowerCase();
    // Refused by name rather than accepted and failed later: a .vcf has no
    // columns and .xls is a different binary format from .xlsx. The server
    // refuses both too — this only saves a 20 MB round trip to hear it.
    if (!IMPORT_SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      setError(
        `“${picked.name}” is not a format this import can read. Supported: ${IMPORT_SUPPORTED_EXTENSIONS.join(', ')}.`,
      );
      return;
    }
    if (picked.size === 0) {
      setError('That file is empty.');
      return;
    }
    if (picked.size > IMPORT_MAX_BYTES) {
      setError(
        `That file is ${formatBytes(picked.size)} and the limit is ${formatBytes(IMPORT_MAX_BYTES)}. Split it and import the halves.`,
      );
      return;
    }

    setError(null);
    setNotice(
      staged === null
        ? null
        : 'That upload replaced the previous one. The earlier batch was never submitted, so nothing was written by it.',
    );
    setUploading(true);
    setFile(picked);

    const body = new FormData();
    body.append('file', picked);
    body.append('filename', picked.name);
    body.append('charset', charset);
    body.append('action', action);
    body.append('dedupeKey', dedupeKey);

    try {
      // Raw fetch, not the shared `api()` helper: that helper stamps
      // `content-type: application/json` on any request with a body, which
      // would strip the multipart boundary and leave the route with a form it
      // cannot read. The browser must set this header itself.
      const res = await fetch(`/api/modules/${slug}/imports`, { method: 'POST', body });
      const text = await res.text();
      const parsed: unknown = text.trim() === '' ? null : JSON.parse(text);

      if (!res.ok) {
        const message =
          parsed !== null && typeof parsed === 'object' && 'error' in parsed
            ? String((parsed as { error: unknown }).error)
            : `The file could not be read (${res.status}).`;
        throw new Error(message);
      }

      const result = parsed as StagedImportWire;
      setStaged(result);
      setMapping(result.suggestedMapping);
      if (advance) setStage(ACTIONS);
    } catch (err) {
      setStaged(null);
      setMapping(EMPTY_MAPPING);
      setError(messageOf(err, 'The file could not be read.'));
    } finally {
      setUploading(false);
    }
  }

  /** Save the wizard's answers as it goes, so Previous and a reload rebuild
   *  the same screen. The commit re-sends all of it, so this is resumability
   *  rather than the authority on what runs. */
  async function patch(input: ImportPatchInput): Promise<void> {
    if (staged === null) return;
    await api<{ batch: ImportBatchWire }>(`/api/modules/${slug}/imports/${staged.batch.id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  async function commit(): Promise<void> {
    if (staged === null) return;
    const res = await api<{ progress: ImportProgressWire }>(
      `/api/modules/${slug}/imports/${staged.batch.id}/commit`,
      {
        method: 'POST',
        body: JSON.stringify({ mapping, action, dedupeKey, assignment }),
      },
    );
    // From here the batch belongs to the worker: the wizard stops being an
    // editor and becomes a viewer of something it can no longer change.
    setRun({
      ...staged.batch,
      mapping,
      action,
      dedupeKey,
      status: res.progress.status,
      succeeded: res.progress.succeeded,
      failed: res.progress.failed,
      startedAt: res.progress.startedAt,
      finishedAt: res.progress.finishedAt,
    });
  }

  async function goNext(): Promise<void> {
    const why = blockerFor(stage);
    if (why !== null) {
      setError(why);
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (stage === ACTIONS) await patch({ action, dedupeKey });
      if (stage === FIELD_MAPPING) await patch({ mapping });
      if (stage === ASSIGN) {
        await commit();
        return;
      }
      setStage(stage + 1);
    } catch (err) {
      setError(messageOf(err, 'That could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  function goTo(index: number): void {
    // Backwards is always allowed; forwards only as far as the answers reach.
    if (index > stage && index > furthest) return;
    setError(null);
    setStage(index);
  }

  const isLast = stage === ASSIGN;

  return (
    <FullScreenOverlay
      title={`Import ${labelPlural}`}
      onClose={onClose}
      trackPrefix={trackPrefix}
    >
      <div className="flex min-h-full flex-col">
        <StageStrip
          stages={STAGES}
          current={run === null ? stage : ASSIGN}
          furthest={furthest}
          onSelect={goTo}
          trackPrefix={trackPrefix}
          frozen={run !== null}
        />

        {run !== null ? (
          <ImportRun
            slug={slug}
            labelPlural={labelPlural}
            batch={run}
            // Refreshed on the way out as well as on completion: someone who
            // closes mid-run should still see the rows that have landed so
            // far, rather than the list as it was before the import started.
            onClose={() => {
              router.refresh();
              onClose();
            }}
            // The list behind this overlay is now stale — it was rendered on
            // the server before these records existed.
            onImported={() => router.refresh()}
            trackPrefix={trackPrefix}
          />
        ) : (
          <>
            <div className="flex-1 px-8 py-6">
              <div className="mx-auto max-w-6xl">
                {error !== null ? (
                  <p
                    role="alert"
                    className="mb-6 rounded border border-error bg-surface px-4 py-3 text-sm text-heading"
                  >
                    {error}
                  </p>
                ) : null}
                {notice !== null ? (
                  <p role="status" className="mb-6 text-xs text-body">
                    {notice}
                  </p>
                ) : null}

                {stage === UPLOAD ? (
                  <StageUpload
                    slug={slug}
                    labelPlural={labelPlural}
                    charset={charset}
                    onCharset={setCharset}
                    staged={staged}
                    file={file}
                    uploading={uploading}
                    onFile={(picked) => void upload(picked)}
                    onReread={() => {
                      if (file !== null) void upload(file, false);
                    }}
                    onResume={(batch) => setRun(batch)}
                    trackPrefix={trackPrefix}
                  />
                ) : null}

                {stage === ACTIONS ? (
                  <StageActions
                    labelPlural={labelPlural}
                    action={action}
                    onAction={setAction}
                    dedupeKey={dedupeKey}
                    onDedupeKey={setDedupeKey}
                    catalogue={catalogue}
                    catalogueLoading={fieldsLoading}
                    trackPrefix={trackPrefix}
                  />
                ) : null}

                {stage === MODULE_FILE && staged !== null ? (
                  <StageModuleFile
                    labelPlural={labelPlural}
                    staged={staged}
                    trackPrefix={trackPrefix}
                  />
                ) : null}

                {stage === FIELD_MAPPING && staged !== null ? (
                  <StageFieldMapping
                    labelPlural={labelPlural}
                    staged={staged}
                    catalogue={catalogue}
                    mapping={mapping}
                    onMapping={setMapping}
                    dedupeKey={dedupeKey}
                    systemColumns={systemColumns}
                    fieldsLoading={fieldsLoading}
                    trackPrefix={trackPrefix}
                  />
                ) : null}

                {stage === ASSIGN ? (
                  <StageAssign
                    labelPlural={labelPlural}
                    assignment={assignment}
                    onAssignment={setAssignment}
                    hasOwner={hasOwner}
                    trackPrefix={trackPrefix}
                  />
                ) : null}
              </div>
            </div>

            {/* Previous · Next · Cancel, on every stage, as the file draws it.
                Sticky rather than pinned to the viewport: the overlay body is
                the scroll container, so the footer stays put while a
                250-column mapping table scrolls past it. */}
            <footer className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-surface px-8 py-4">
              <span className="mr-auto text-xs text-body">
                {isLast
                  ? 'Nothing is written until you press Import. From then on the work runs in the background.'
                  : `Stage ${stage + 1} of ${STAGES.length} · nothing has been written yet.`}
              </span>
              <Button
                variant="secondary"
                disabled={stage === UPLOAD || busy}
                onClick={() => goTo(stage - 1)}
                data-track={`${trackPrefix}.previous`}
              >
                Previous
              </Button>
              <Button
                variant="primary"
                loading={busy}
                disabled={blockerFor(stage) !== null}
                // A disabled control with no explanation reads as a broken one.
                title={blockerFor(stage) ?? undefined}
                onClick={() => void goNext()}
                data-track={isLast ? `${trackPrefix}.commit.click` : `${trackPrefix}.next`}
              >
                {isLast ? `Import ${labelPlural}` : 'Next'}
              </Button>
              <Button variant="ghost" onClick={onClose} data-track={`${trackPrefix}.cancel`}>
                Cancel
              </Button>
            </footer>
          </>
        )}
      </div>
    </FullScreenOverlay>
  );
}
