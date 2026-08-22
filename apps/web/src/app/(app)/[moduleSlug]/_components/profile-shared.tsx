'use client';

import type { ReactNode } from 'react';
import { ApiClientError } from '@/lib/client-api';
import { Button, FieldError, cn } from '@/components/ui';

/**
 * What the Groups and Departments screens share: the pop-up form controls,
 * the notice banners and the error-to-words helpers.
 *
 * The controls are the file's `Input Base` as `saved-view-popups.tsx` measured
 * it — 463x41, pad 10/12, `bg #ffffff`, `border #e5e7eb`, `r:4`, Regular 14px
 * — restated here rather than imported because that file keeps its constants
 * private to its three pop-ups. NOT the shared `Input` primitive, for the
 * reason documented there: `Input` is traced from the 36px search box, and
 * overriding its background with a second utility resolves by stylesheet
 * order, not attribute order.
 */
export const POPUP_INPUT =
  'h-[41px] w-full rounded border border-border bg-surface px-3 text-sm text-heading ' +
  'placeholder:text-body ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/** The file's `Label` row: Regular 14px `#111827`, 8px above the control. */
export const POPUP_LABEL = 'mb-2 block text-sm text-heading';

/** An error, in the user's words. Never the raw message of a non-Error. */
export function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}

/** The API's per-field message for `field`, else its top-level one. */
export function fieldMessage(err: unknown, field: string, fallback: string): string {
  if (!(err instanceof ApiClientError)) return messageOf(err, fallback);
  return err.fields?.[field]?.[0] ?? err.message;
}

export interface PopupTextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  track: string;
  error?: ReactNode;
  placeholder?: string;
  /** The shared schema's cap, so the control and the server agree. */
  maxLength: number;
  autoFocus?: boolean;
  /**
   * Enter submits. The pop-up's footer buttons are plain buttons outside any
   * form, so without this a keyboard user types a name and nothing happens.
   */
  onSubmit?: () => void;
}

/** The file's `Text Area` column — label over control, `flex-col gap:8`. */
export function PopupTextField({
  id,
  label,
  value,
  onChange,
  track,
  error,
  placeholder = 'Enter...',
  maxLength,
  autoFocus = false,
  onSubmit,
}: PopupTextFieldProps) {
  return (
    <div>
      <label htmlFor={id} className={POPUP_LABEL}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        maxLength={maxLength}
        required
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || onSubmit === undefined) return;
          e.preventDefault();
          onSubmit();
        }}
        data-track={track}
        className={POPUP_INPUT}
      />
      <FieldError>{error}</FieldError>
    </div>
  );
}

export type NoticeTone = 'warning' | 'error' | 'info';

const NOTICE_TONE: Record<NoticeTone, string> = {
  warning: 'border border-warning bg-warning/10 text-heading',
  error: 'bg-error/10 text-error',
  info: 'border border-border bg-background text-heading',
};

export interface NoticeProps {
  tone: NoticeTone;
  children: ReactNode;
  onDismiss: () => void;
  /** `module.screen.element.action` for the dismiss button. */
  track: string;
}

/**
 * The field builder's banner, shared by the two Profile screens. `role=alert`
 * only for the error tone — a warning about language overlap is information,
 * and announcing it as an alert would interrupt whatever the reader was on.
 */
export function Notice({ tone, children, onDismiss, track }: NoticeProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start justify-between gap-4 rounded px-3 py-2 text-sm',
        NOTICE_TONE[tone],
      )}
    >
      <div className="min-w-0">{children}</div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDismiss}
        aria-label="Dismiss"
        data-track={track}
        className={tone === 'error' ? 'text-error hover:bg-error/10' : undefined}
      >
        Dismiss
      </Button>
    </div>
  );
}
