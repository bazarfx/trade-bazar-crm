/**
 * The primitive set every screen composes from. Screens import from here, not
 * from the individual files, so a primitive can move without a rename sweep.
 *
 * Nothing in this folder may ever learn about a module. If a primitive needs a
 * lead, a deal or a campaign to make sense, it belongs in a screen instead.
 */
export { Button, buttonClass, cn } from './button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './button';

export { Checkbox, FieldError, FieldLabel, Input, Select, Textarea } from './input';
export type { CheckboxProps, FieldLabelProps, InputProps, SelectProps, TextareaProps } from './input';

export { Chip, StatusChip } from './chip';
export type { ChipProps, ChipTone, StatusChipProps } from './chip';

export { Panel, PanelBody, PanelHeader } from './panel';
export type { PanelBodyProps, PanelHeaderProps } from './panel';

export { Avatar } from './avatar';
export type { AvatarProps, AvatarSize } from './avatar';

/**
 * The centred pop-up the Figma file draws, at the three widths it draws it.
 * `FullScreenOverlay` (components/overlay) is NOT replaced by this — per the
 * rewritten UI rules in CLAUDE.md it still owns the record form, field
 * builder, layout editor, roles matrix and review queue.
 */
export { Popup, PopupFooter } from './popup';
export type {
  PopupFooterAction,
  PopupFooterProps,
  PopupFooterTone,
  PopupProps,
  PopupWidth,
} from './popup';

export { DataTable } from './table';
export type { DataTableColumn, DataTableProps, DataTableSelection } from './table';
