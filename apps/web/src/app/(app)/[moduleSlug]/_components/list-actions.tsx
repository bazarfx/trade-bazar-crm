'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { PendingOverlay } from './pending-overlay';
import { RecordFormOverlay } from './record-form-overlay';
import { ImportWizard } from './import/import-wizard';
import { ExportIcon, ImportIcon, PlusIcon } from './icons';

/**
 * The three header actions. Every label is composed from `ModuleDefinition` —
 * "Create Lead" is what `label` happens to hold today, and the same component
 * says "Create Invoice" the day an Admin adds that module without a deploy.
 *
 * Create opens the generated record form and Import opens the five-stage
 * wizard. Export still opens a full-screen stub rather than doing nothing, so
 * the shape of the interaction (and its `data-track` name) is already the real
 * one.
 */
export interface ListActionsProps {
  slug: string;
  /** module.label — SINGULAR, the thing one of these records is. */
  label: string;
  /** module.labelPlural — what a set of these records is called. */
  labelPlural: string;
  /**
   * Field key → `FieldDefinition.systemColumn`, for the record form. It has to
   * come from the server: the fields API does not serialise the column, and
   * the form needs it to know which field IS the status and which IS the owner
   * without naming either — see `RecordFormOverlay`.
   */
  systemColumns: Record<string, string | null>;
  canCreate: boolean;
  canImportExport: boolean;
  /**
   * Whether a record here can be owned at all — the module's own declaration
   * AND the storage shape's owner column, resolved on the page. The import
   * wizard's last stage asks who ends up owning the rows, and a module whose
   * rows have no owner has nothing to ask.
   */
  hasOwner: boolean;
}

type PendingAction = 'export';

export function ListActions({
  slug,
  label,
  labelPlural,
  systemColumns,
  canCreate,
  canImportExport,
  hasOwner,
}: ListActionsProps) {
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const COPY: Record<PendingAction, { title: string; message: string }> = {
    export: {
      title: `Export ${label} records`,
      message:
        'Export runs as a background job and mails a link when the file is ready — a synchronous ' +
        'download cannot survive a large module. It arrives with the import/export slice.',
    },
  };

  const copy = pending ? COPY[pending] : null;

  return (
    <>
      <div className="flex shrink-0 items-center gap-3">
        <Button
          variant="primary"
          iconLeft={<PlusIcon className="h-4 w-4" />}
          disabled={!canCreate}
          // A disabled control with no explanation reads as a broken one.
          title={canCreate ? undefined : `Your role cannot create ${label} records.`}
          onClick={() => setCreating(true)}
          data-track={`${slug}.list.create.open`}
        >
          Create {label}
        </Button>

        <Button
          variant="secondary"
          iconLeft={<ExportIcon className="h-4 w-4" />}
          disabled={!canImportExport}
          title={canImportExport ? undefined : 'Your role does not hold the Import / Export permission.'}
          onClick={() => setPending('export')}
          data-track={`${slug}.list.export.click`}
        >
          Export
        </Button>

        <Button
          variant="secondary"
          iconLeft={<ImportIcon className="h-4 w-4" />}
          disabled={!canImportExport}
          title={canImportExport ? undefined : 'Your role does not hold the Import / Export permission.'}
          onClick={() => setImporting(true)}
          // Keeps the `module.screen.element.action` shape: the button belongs
          // to the LIST screen, and the wizard's own controls are named
          // `${slug}.import.*`. Renaming this one would break the continuity of
          // an interaction log that already holds it.
          data-track={`${slug}.list.import.open`}
        >
          Import
        </Button>
      </div>

      {creating ? (
        <RecordFormOverlay
          slug={slug}
          label={label}
          systemColumns={systemColumns}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {importing ? (
        <ImportWizard
          slug={slug}
          labelPlural={labelPlural}
          systemColumns={systemColumns}
          hasOwner={hasOwner}
          onClose={() => setImporting(false)}
        />
      ) : null}

      {copy ? (
        <PendingOverlay
          title={copy.title}
          message={copy.message}
          trackPrefix={`${slug}.list`}
          onClose={() => setPending(null)}
        />
      ) : null}
    </>
  );
}
