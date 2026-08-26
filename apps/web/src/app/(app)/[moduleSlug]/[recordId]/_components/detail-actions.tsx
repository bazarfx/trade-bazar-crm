'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AccountFormOverlay } from '@/app/(app)/[moduleSlug]/_components/account-form-overlay';
import { ResetPasswordPopup } from '@/app/(app)/[moduleSlug]/_components/reset-password-popup';
import { Button, buttonClass } from '@/components/ui';

/**
 * The header action on a record: Edit.
 *
 * A record is written from exactly one place — the generated form screen at
 * `/[moduleSlug]/[recordId]/edit` — so this navigates there rather than
 * growing an inline editor beside it. Two write surfaces would mean two
 * validation paths, and the one that drifts is always the one nobody is
 * looking at. It is a page rather than an overlay because the file draws the
 * sidebar and top bar around the form; see `record-form-screen.tsx`.
 *
 * There is deliberately no Convert action here, or anywhere: conversion is
 * webhook-driven only (spec §7). A lead becomes a deal when ARK reports a
 * deposit, and at no other moment.
 */
export interface DetailActionsProps {
  slug: string;
  /** module.label — SINGULAR, the thing this record is. */
  label: string;
  recordId: string;
  canEdit: boolean;
  /**
   * Set when this record IS a USER ACCOUNT — decided by the page from the
   * storage shape, never a slug. Edit then opens the account form (role,
   * groups, password) and a Reset password action appears beside it.
   * `canManage` is MANAGE_USERS_ROLES or Admin; `name` puts the account's
   * name in the reset dialog so the wrong row is caught on sight.
   */
  account?: { canManage: boolean; name: string } | null;
}

export function DetailActions({
  slug,
  label,
  recordId,
  canEdit,
  account = null,
}: DetailActionsProps) {
  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Account edits are gated on MANAGE_USERS_ROLES, not the module's edit
  // scope — editing an account hands out access, a different power from
  // editing a record.
  const mayEdit = account !== null ? account.canManage : canEdit;
  const editBlocked =
    account !== null
      ? 'Editing accounts needs the "Manage users & roles" permission.'
      : `Your role cannot edit ${label} records.`;

  return (
    <>
      <div className="flex shrink-0 items-center gap-3">
        {account !== null ? (
          <Button
            variant="secondary"
            disabled={!account.canManage}
            title={
              account.canManage
                ? undefined
                : 'Resetting a password needs the "Manage users & roles" permission.'
            }
            onClick={() => setResetting(true)}
            data-track={`${slug}.detail.resetpassword.open`}
          >
            Reset password
          </Button>
        ) : null}
        {/* A LINK for a record, because the form is its own page now — the
            file draws the sidebar and top bar around it. An ACCOUNT keeps its
            overlay: it is not a record, and the file draws no screen for it. */}
        {mayEdit && account === null ? (
          <Link
            href={`/${slug}/${recordId}/edit`}
            className={buttonClass('primary')}
            data-track={`${slug}.detail.edit.open`}
          >
            Edit
          </Link>
        ) : (
          <Button
            variant="primary"
            disabled={!mayEdit}
            title={mayEdit ? undefined : editBlocked}
            onClick={() => setEditing(true)}
            data-track={`${slug}.detail.edit.open`}
          >
            Edit
          </Button>
        )}
      </div>

      {editing && account !== null ? (
        <AccountFormOverlay
          slug={slug}
          label={label}
          userId={recordId}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {account !== null && resetting ? (
        <ResetPasswordPopup
          slug={slug}
          userId={recordId}
          userName={account.name}
          onClose={() => setResetting(false)}
        />
      ) : null}
    </>
  );
}
