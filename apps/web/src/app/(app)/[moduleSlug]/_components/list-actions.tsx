'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { PendingOverlay } from './pending-overlay';
import { ExportIcon, ImportIcon, PlusIcon } from './icons';

/**
 * The three header actions. Every label is composed from `ModuleDefinition` —
 * "Create Lead" is what `label` happens to hold today, and the same component
 * says "Create Invoice" the day an Admin adds that module without a deploy.
 *
 * The actions open a full-screen stub rather than doing nothing, so the shape
 * of the interaction (and its `data-track` name) is already the real one.
 */
export interface ListActionsProps {
  slug: string;
  /** module.label — SINGULAR, the thing one of these records is. */
  label: string;
  canCreate: boolean;
  canImportExport: boolean;
}

type PendingAction = 'create' | 'export' | 'import';

export function ListActions({ slug, label, canCreate, canImportExport }: ListActionsProps) {
  const [pending, setPending] = useState<PendingAction | null>(null);

  const COPY: Record<PendingAction, { title: string; message: string }> = {
    create: {
      title: `Create ${label}`,
      message:
        `The ${label} form is generated from this module's fields, sections and layout, ` +
        'and arrives with the record engine slice. It will open right here, full screen.',
    },
    export: {
      title: `Export ${label} records`,
      message:
        'Export runs as a background job and mails a link when the file is ready — a synchronous ' +
        'download cannot survive a large module. It arrives with the import/export slice.',
    },
    import: {
      title: `Import ${label} records`,
      message:
        'Import is column mapping, a dry-run preview and a duplicate review queue, all driven by ' +
        "this module's fields. It arrives with the import/export slice.",
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
          onClick={() => setPending('create')}
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
          onClick={() => setPending('import')}
          data-track={`${slug}.list.import.open`}
        >
          Import
        </Button>
      </div>

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
