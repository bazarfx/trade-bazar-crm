'use client';

import { Button } from '@/components/ui';

/**
 * The one segmented picker in the config builders — layout target, section
 * column count, field column span. It is a row of `Button`s rather than a
 * hand-styled div so the pressed segment is the same teal as every other
 * primary action, and so the disabled and focus states come from one place.
 *
 * Values are opaque: this knows nothing about what it is picking between, only
 * how to render a label for each option.
 */
interface SegmentedProps<T extends string | number> {
  /** Labels the group for assistive tech — there is no visible legend. */
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** `module.screen.element.action`, shared by every segment. */
  dataTrack: string;
  /** Defaults to the value itself, which is right for a column count. */
  renderLabel?: (value: T) => string;
  disabled?: boolean;
}

export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  dataTrack,
  renderLabel,
  disabled = false,
}: SegmentedProps<T>) {
  return (
    // The group owns the border and the radius; the segments are square and
    // separated by `divide-x`, so they read as one control at any option count.
    <div
      role="group"
      aria-label={label}
      className="inline-flex divide-x divide-border overflow-hidden rounded border border-border"
    >
      {options.map((option) => (
        <Button
          key={String(option)}
          variant={option === value ? 'primary' : 'secondary'}
          size="sm"
          aria-pressed={option === value}
          disabled={disabled}
          onClick={() => onChange(option)}
          data-track={dataTrack}
          className="rounded-none border-0"
        >
          {renderLabel ? renderLabel(option) : String(option)}
        </Button>
      ))}
    </div>
  );
}
