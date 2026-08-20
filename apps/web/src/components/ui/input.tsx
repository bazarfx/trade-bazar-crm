'use client';

import {
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from './button';

/**
 * Measured off the Leads header search box: 36 high, `bg #f6f8fa`, border
 * `#e5e7eb`, radius 4, 12px placeholder in `#6b7280`.
 *
 * The focus ring is deliberately more than a border recolour: a 1px hue change
 * is not a visible focus indicator for anyone with reduced colour vision, and
 * every field in this product is reachable only by keyboard in the full-screen
 * form overlays.
 */
const FIELD_BASE =
  'w-full rounded border border-border bg-background px-3 text-xs text-heading ' +
  'placeholder:text-body ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/** See ButtonProps['data-track'] — required for the same reason. */
interface Tracked {
  'data-track': string;
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, Tracked {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = 'text', ...rest },
  ref,
) {
  return <input ref={ref} type={type} className={cn(FIELD_BASE, 'h-9', className)} {...rest} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, Tracked {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, rows = 3, ...rest },
  ref,
) {
  return (
    // Height comes from `rows`, never a fixed class: a long-text field that
    // cannot grow is the reason people paste notes into the wrong field.
    <textarea
      ref={ref}
      rows={rows}
      className={cn(FIELD_BASE, 'resize-y py-2 leading-5', className)}
      {...rest}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, Tracked {}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    // A styled NATIVE select, not a custom listbox. Picklists here are
    // Admin-defined and can run to hundreds of options; the native control
    // brings type-ahead, mobile pickers and screen-reader support for free,
    // and none of that would survive a hand-rolled popup.
    <select ref={ref} className={cn(FIELD_BASE, 'h-9', className)} {...rest}>
      {children}
    </select>
  );
});

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>,
    Tracked {
  label: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, ...rest },
  ref,
) {
  return (
    // The label WRAPS the control instead of pointing at it by id: there is no
    // id to generate, no id to collide, and the association cannot drift when
    // a builder renders the same field twice on one screen.
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-heading">
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          'h-5 w-5 shrink-0 cursor-pointer rounded accent-primary',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
            'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        {...rest}
      />
      <span>{label}</span>
    </label>
  );
});

export interface FieldLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

export function FieldLabel({ required = false, className, children, ...rest }: FieldLabelProps) {
  return (
    <label className={cn('mb-1.5 block text-sm font-medium text-heading', className)} {...rest}>
      {children}
      {/* Hidden from assistive tech: the control itself carries `required`,
          and announcing "star" on top of that is noise, not information. */}
      {required ? (
        <span className="text-error" aria-hidden="true">
          {' *'}
        </span>
      ) : null}
    </label>
  );
}

export function FieldError({ children, className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  // Render nothing when there is no message so callers can drop this in
  // unconditionally beside every field without guarding each one.
  if (children === null || children === undefined || children === false || children === '') {
    return null;
  }
  return (
    // role="alert" so a validation failure is announced when it appears —
    // a long form scrolled past the offending field otherwise says nothing.
    <p role="alert" className={cn('mt-1 text-xs text-error', className)} {...rest}>
      {children}
    </p>
  );
}
