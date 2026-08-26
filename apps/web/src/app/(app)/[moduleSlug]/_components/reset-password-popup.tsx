'use client';

import { useState } from 'react';
import { generatePassword, passwordSchema } from '@crm/shared';
import { api } from '@/lib/client-api';
import { FieldError, FieldLabel, Input, Popup, PopupFooter } from '@/components/ui';
import { copyText } from './copy-text';

/**
 * Admin password reset (spec §5.5) — a 511-wide pop-up, the size the file
 * gives a single-field dialog (Save Filter, Edit Name).
 *
 * Two states on purpose:
 *  1. choose or generate the new password and confirm;
 *  2. the receipt — the ONE moment the value can still be read, because the
 *     server stores only the hash. Closing this popup is the last time anyone
 *     sees it, and the copy says so plainly.
 *
 * The reset also signs the user out of every device (the server revokes all
 * sessions), which the first state warns about — an Admin resetting a
 * password mid-shift needs to know the rep's screen is about to bounce to
 * the login page.
 */

export interface ResetPasswordPopupProps {
  /** the Profile module's slug — the data-track namespace only */
  slug: string;
  userId: string;
  /** whose password — named in the copy so the wrong row is caught on sight */
  userName: string;
  onClose: () => void;
}

export function ResetPasswordPopup({ slug, userId, userName, onClose }: ResetPasswordPopupProps) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set once the server has committed — the receipt state. */
  const [done, setDone] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // While the reset is in flight the pop-up refuses to close — Escape and the
  // scrim included. Closing mid-request would commit the reset server-side and
  // throw away the ONE display of the new password, locking the user out until
  // somebody resets it again.
  const guardedClose = () => {
    if (!saving) onClose();
  };

  async function save() {
    // The same rule the server enforces, run here so a typo is caught on the
    // field instead of round-tripping.
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Enter a stronger password');
      return;
    }
    setFieldError(null);
    setError(null);
    setSaving(true);
    try {
      const res = await api<{ password: string }>(`/api/users/${userId}/password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setDone(res.password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  function copy(value: string) {
    void copyText(value).then((ok) => {
      // A failure STAYS on screen — this button guards the only view of the
      // new password there will ever be.
      setCopyState(ok ? 'copied' : 'failed');
      if (ok) setTimeout(() => setCopyState('idle'), 1500);
    });
  }

  if (done !== null) {
    return (
      <Popup
        title="Password reset"
        width={511}
        open
        onClose={onClose}
        trackPrefix={`${slug}.account.resetdone`}
        footer={
          <PopupFooter
            trackPrefix={`${slug}.account.resetdone`}
            next={{ label: 'Done', onClick: onClose }}
          />
        }
      >
        <p className="text-sm text-body">
          <span className="font-medium text-heading">{userName}</span> has been signed out
          everywhere and can now sign in with this password. It is shown only this once — copy it
          now and share it securely.
        </p>
        <div className="flex items-center gap-3 rounded border border-border bg-background px-3 py-2">
          <code className="min-w-0 flex-1 truncate text-sm text-heading" title={done}>
            {done}
          </code>
          <button
            type="button"
            className={
              copyState === 'failed'
                ? 'shrink-0 text-xs font-medium text-error'
                : 'shrink-0 text-xs font-medium text-body hover:text-heading'
            }
            onClick={() => copy(done)}
            data-track={`${slug}.account.resetdone.copy`}
          >
            {copyState === 'copied'
              ? 'Copied'
              : copyState === 'failed'
                ? 'Copy failed — select it by hand'
                : 'Copy'}
          </button>
        </div>
      </Popup>
    );
  }

  return (
    <Popup
      title={`Reset password — ${userName}`}
      width={511}
      open
      onClose={guardedClose}
      trackPrefix={`${slug}.account.reset`}
      footer={
        <PopupFooter
          trackPrefix={`${slug}.account.reset`}
          cancel={{ label: 'Cancel', onClick: guardedClose, disabled: saving }}
          next={{ label: saving ? 'Saving…' : 'Reset password', onClick: () => void save(), disabled: saving }}
        />
      }
    >
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <FieldLabel htmlFor="reset-password" required>
            New password
          </FieldLabel>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => {
                setPassword(generatePassword());
                setShow(true);
                setFieldError(null);
              }}
              data-track={`${slug}.account.reset.generate`}
            >
              Generate
            </button>
            <button
              type="button"
              className="text-xs font-medium text-body hover:text-heading"
              onClick={() => setShow((v) => !v)}
              data-track={`${slug}.account.reset.toggle`}
            >
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <Input
          id="reset-password"
          type={show ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 10 characters"
          autoComplete="new-password"
          aria-invalid={fieldError !== null}
          data-track={`${slug}.account.reset.input`}
        />
        <p className="mt-1 text-xs text-muted">
          At least 10 characters, with an upper and a lower case letter and a number.
        </p>
        <FieldError>{fieldError}</FieldError>
      </div>

      <p className="rounded bg-background px-3 py-2 text-xs text-body">
        Resetting signs {userName} out of every device immediately. The current password stops
        working the moment you confirm.
      </p>

      {error !== null ? (
        <p role="alert" className="rounded border border-error bg-surface px-3 py-2 text-xs text-error">
          {error}
        </p>
      ) : null}
    </Popup>
  );
}
