'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, buttonClass } from '@/components/ui';
import { AccountFormOverlay } from './account-form-overlay';
import { PendingOverlay } from './pending-overlay';
import { ExportIcon, ImportIcon, PlusIcon } from './icons';

/**
 * The three header actions. Every label is composed from `ModuleDefinition` —
 * "Create Lead" is what `label` happens to hold today, and the same component
 * says "Create Invoice" the day an Admin adds that module without a deploy.
 *
 * Create and Import both NAVIGATE: the file draws the sidebar and top bar
 * behind each of them, which an overlay would cover, so both are real routes
 * whose work survives a reload and can be linked to. Import's rule came from
 * CLAUDE.md's rewritten UI rules (22 Aug 2026); the record form followed once
 * `CRM _ Leads_Create Leads` was measured and turned out to draw the same
 * chrome. Only an ACCOUNT still opens over the page — it is not a record, and
 * the file draws no screen for it. — CLAUDE.md's
 * rewritten UI rules (22 Aug 2026) make import a page at
 * `/[moduleSlug]/import`, and the file agrees: all twenty-four
 * `CRM _ Leads_Import ` frames draw the sidebar and top bar behind the wizard,
 * which an overlay would cover. It is a real route, so a half-finished import
 * survives a reload and can be linked to. Export still opens a full-screen
 * stub rather than doing nothing, so the shape of the interaction (and its
 * `data-track` name) is already the real one.
 */
export interface ListActionsProps {
  slug: string;
  /** module.label — SINGULAR, the thing one of these records is. */
  label: string;
  /** module.labelPlural — what a set of these records is called. */
  labelPlural: string;
  canCreate: boolean;
  canImportExport: boolean;
  /**
   * Whether a record here can be owned at all — the module's own declaration
   * AND the storage shape's owner column, resolved on the page. The import
   * wizard's last stage asks who ends up owning the rows, and a module whose
   * rows have no owner has nothing to ask.
   */
  hasOwner: boolean;
  /**
   * Set when this module's rows are USER ACCOUNTS — decided by the page from
   * the storage shape, never a slug. Create then opens the account form
   * (password, role, groups) instead of the generic record form, because the
   * engine refuses inserts on the user table: an account is not a record.
   * `canManage` is MANAGE_USERS_ROLES or Admin, resolved server-side.
   */
  account?: { canManage: boolean } | null;
  /**
   * Why Create is disabled when the reason is not the role — a ledger table
   * the engine refuses inserts on. Overrides the default role-worded tooltip.
   */
  createBlockedReason?: string;
}

type PendingAction = 'export';

export function ListActions({
  slug,
  label,
  labelPlural,
  canCreate,
  canImportExport,
  hasOwner,
  account = null,
  createBlockedReason,
}: ListActionsProps) {
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  // Account creation is gated on MANAGE_USERS_ROLES, not on the module's
  // create scope — making an account hands out access, which is a different
  // power from making a record.
  const mayCreate = account !== null ? account.canManage : canCreate;
  const createBlocked =
    account !== null
      ? `Creating ${labelPlural.toLowerCase()} needs the "Manage users & roles" permission.`
      : (createBlockedReason ?? `Your role cannot create ${label} records.`);

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
      {/* Measured, frame "CRM _ Leads": Frame 482686 @1012,93 is 400x38 with
          row gap 12 — 122 + 12 + 122 + 12 + 132 = 400 exactly. Each button is
          padding 10/12, an 18px icon, gap 10, and a 12px label. The primary is
          #00667a with a white label; the other two are white with the same
          1px #e5e7eb border, NOT a borderless secondary.
          ORDER IS MEASURED, not conventional: the labels sit at x=1067
          "Import", 1201 "Export", 1325 "Create Lead", so the primary is the
          RIGHTMOST of the three. It read the other way round until 26 Aug. */}
      <div className="flex shrink-0 items-center gap-3">
        {/* A LINK, not a button: import is its own route now, so it must be
            openable in a new tab and reachable by the back button. Without the
            permission it stays a disabled Button — an anchor cannot be
            disabled, and one that navigates to a 404 is worse than one that
            explains itself. */}
        {canImportExport ? (
          <Link
            href={`/${slug}/import`}
            // The Button primitive's own measured recipe, so the anchor is the
            // same 38px secondary control as Export beside it.
            className={`${buttonClass('secondary')} h-[38px] w-[122px] gap-2.5 px-3 text-xs font-normal`}
            // Keeps the `module.screen.element.action` shape: the control
            // belongs to the LIST screen, and the wizard's own controls are
            // named `${slug}.import.*`. Renaming this one would break the
            // continuity of an interaction log that already holds it.
            data-track={`${slug}.list.import.open`}
          >
            <ImportIcon className="h-[18px] w-[18px]" />
            Import
          </Link>
        ) : (
          <Button
            variant="secondary"
            className="h-[38px] w-[122px] gap-2.5 px-3 text-xs font-normal"
            iconLeft={<ImportIcon className="h-[18px] w-[18px]" />}
            disabled
            title="Your role does not hold the Import / Export permission."
            data-track={`${slug}.list.import.open`}
          >
            Import
          </Button>
        )}

        <Button
          variant="secondary"
          className="h-[38px] w-[122px] gap-2.5 px-3 text-xs font-normal"
          iconLeft={<ExportIcon className="h-[18px] w-[18px]" />}
          disabled={!canImportExport}
          title={canImportExport ? undefined : 'Your role does not hold the Import / Export permission.'}
          onClick={() => setPending('export')}
          data-track={`${slug}.list.export.click`}
        >
          Export
        </Button>

        {/* A LINK, not a button, for the same reason Import is one: the form
            is its own page now (the file draws the sidebar and top bar around
            it), so it must be openable in a new tab and reachable by the back
            button. Without the permission it stays a disabled Button — an
            anchor cannot be disabled, and one that navigates to a redirect is
            worse than one that explains itself. */}
        {mayCreate && account === null ? (
          <Link
            href={`/${slug}/new`}
            className={`${buttonClass('primary')} h-[38px] w-[132px] gap-2.5 border border-border px-3 text-xs font-normal`}
            data-track={`${slug}.list.create.open`}
          >
            <PlusIcon className="h-[18px] w-[18px]" />
            Create {label}
          </Link>
        ) : (
          <Button
            variant="primary"
            className="h-[38px] w-[132px] gap-2.5 border border-border px-3 text-xs font-normal"
            iconLeft={<PlusIcon className="h-[18px] w-[18px]" />}
            disabled={!mayCreate}
            // A disabled control with no explanation reads as a broken one.
            title={mayCreate ? undefined : createBlocked}
            onClick={() => setCreating(true)}
            data-track={`${slug}.list.create.open`}
          >
            Create {label}
          </Button>
        )}
      </div>

      {/* Accounts still open over the page: an account is not a record, its
          form is not layout-driven, and the file draws no screen for it. */}
      {creating && account !== null ? (
        <AccountFormOverlay slug={slug} label={label} onClose={() => setCreating(false)} />
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
