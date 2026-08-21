import { z } from 'zod';
import { FIELD_TYPES, FIELD_TYPE_SPECS, type FieldType } from './field-types.js';

/**
 * Configuration contracts — the shapes every admin config write travels in.
 *
 * Defined ONCE here (constraint: validation lives in packages/shared) and
 * consumed by the route handlers, the config service and the builder UIs.
 */

// ── status tags ──────────────────────────────────────────────────────────
/** Mirrors the StatusTag enum in schema.prisma. System behaviour reads the
 *  tag, never the name — names are Admin-editable. */
export const STATUS_TAGS = [
  'NEUTRAL', 'WARM', 'HOT', 'COLD', 'LOST', 'INVALID', 'CONVERTED', 'SIGNED_UP',
] as const;
export type StatusTagValue = (typeof STATUS_TAGS)[number];

/** Tags the pipelines depend on. A module that has a status carrying one of
 *  these must always keep at least one active status with that tag. */
export const SYSTEM_TAGS = ['CONVERTED', 'SIGNED_UP'] as const satisfies readonly StatusTagValue[];

// ── config change log ─────────────────────────────────────────────────────
/** Stable discriminators for ConfigChangeLog.configType. NEVER a module slug —
 *  slugs are Admin-editable data. */
export const CONFIG_TYPES = [
  'FIELD', 'SECTION', 'STATUS', 'PICKLIST_OPTION', 'LAYOUT', 'MODULE',
  /** a campaign-intake webhook source — its mapping is config, edited without a deploy */
  'WEBHOOK_SOURCE',
] as const;
export type ConfigType = (typeof CONFIG_TYPES)[number];

export const CONFIG_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'REORDER'] as const;
export type ConfigAction = (typeof CONFIG_ACTIONS)[number];

// ── field key generation ──────────────────────────────────────────────────
/**
 * Derive a storage key from a label. Keys are snake_case, JSONB-safe and
 * IMMUTABLE after creation: renaming a field changes its label only. A key
 * that changed would orphan historical JSONB values and silently break every
 * saved filter that references it — the timeline must stay readable forever.
 */
export function fieldKeyFromLabel(label: string): string {
  const key = label
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (!key) return 'field';
  return /^[0-9]/.test(key) ? `f_${key}` : key;
}

/** Collision handling: append _2, _3, … against the set of existing keys. */
export function uniqueFieldKey(label: string, existing: ReadonlySet<string>): string {
  const base = fieldKeyFromLabel(label);
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

// ── caps (spec §13) ───────────────────────────────────────────────────────
export const FIELD_CAP_SOFT = 100;
export const FIELD_CAP_HARD = 250;
export const REQUIRED_FIELDS_WARNING = 8;

// ── field payloads ────────────────────────────────────────────────────────
const validationRulesSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    regex: z.string().max(500).optional(),
  })
  .strict();

const optionInputSchema = z.object({
  label: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

/** Derived types are computed server-side; their editors are a later slice. */
const CREATABLE_TYPES = FIELD_TYPES.filter((t) => !FIELD_TYPE_SPECS[t].isDerived) as [
  FieldType,
  ...FieldType[],
];

export const fieldCreateSchema = z
  .object({
    label: z.string().trim().min(1, 'Label is required').max(100),
    type: z.enum(CREATABLE_TYPES),
    sectionId: z.string().uuid().nullish(),
    helpText: z.string().trim().max(500).nullish(),
    isRequired: z.boolean().default(false),
    isUnique: z.boolean().default(false),
    options: z.array(optionInputSchema).max(500).optional(),
    defaultValue: z.unknown().optional(),
    validation: validationRulesSchema.nullish(),
  })
  .superRefine((v, ctx) => {
    const spec = FIELD_TYPE_SPECS[v.type];
    if (v.isUnique && !spec.canBeUnique)
      ctx.addIssue({ code: 'custom', path: ['isUnique'], message: `${spec.label} fields cannot be unique` });
    if (v.options?.length && !spec.hasOptions)
      ctx.addIssue({ code: 'custom', path: ['options'], message: `${spec.label} fields do not carry options` });
    if (spec.hasOptions && !v.options?.length)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Add at least one option' });
  });
export type FieldCreateInput = z.infer<typeof fieldCreateSchema>;

/** No `type`, no `key`: a field's type and key are fixed at creation (the
 *  functional reference, Zoho, does the same). Recreate instead of retype. */
export const fieldUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    helpText: z.string().trim().max(500).nullish(),
    isRequired: z.boolean().optional(),
    sectionId: z.string().uuid().nullish(),
    defaultValue: z.unknown().optional(),
    validation: validationRulesSchema.nullish(),
    options: z.array(optionInputSchema.extend({ id: z.string().uuid().optional() })).max(500).optional(),
  })
  .strict();
export type FieldUpdateInput = z.infer<typeof fieldUpdateSchema>;

// ── section payloads ──────────────────────────────────────────────────────
export const sectionCreateSchema = z.object({
  label: z.string().trim().min(1).max(100),
  columns: z.number().int().min(1).max(3).default(3),
  isCollapsible: z.boolean().default(false),
});
export const sectionUpdateSchema = sectionCreateSchema.partial().strict();
export type SectionCreateInput = z.infer<typeof sectionCreateSchema>;
export type SectionUpdateInput = z.infer<typeof sectionUpdateSchema>;

// ── status payloads ───────────────────────────────────────────────────────
export const statusCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  tag: z.enum(STATUS_TAGS),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
});
export const statusUpdateSchema = statusCreateSchema.partial().strict();
export type StatusCreateInput = z.infer<typeof statusCreateSchema>;
export type StatusUpdateInput = z.infer<typeof statusUpdateSchema>;

/** Deleting a status in use requires a replacement for existing records. */
export const statusDeleteSchema = z.object({
  replacementStatusId: z.string().uuid().optional(),
});

// ── reorder payload (fields, sections, statuses, options) ────────────────
export const reorderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(500),
});
export type ReorderInput = z.infer<typeof reorderSchema>;

// ── layout spec ───────────────────────────────────────────────────────────
export const LAYOUT_TARGETS = ['FORM', 'DETAIL'] as const;
export type LayoutTargetValue = (typeof LAYOUT_TARGETS)[number];

/** What Layout.layout holds. A layout is a HINT over the field list, never
 *  the truth: fields absent from it still render (appended to their section)
 *  and soft-deleted fields never render, reconciled at read time. */
export const layoutFieldRefSchema = z.object({
  fieldId: z.string().uuid(),
  /** grid columns this field spans inside its section (section grid is 1-3) */
  colSpan: z.number().int().min(1).max(3).optional(),
});
export const layoutSectionRefSchema = z.object({
  sectionId: z.string().uuid(),
  fields: z.array(layoutFieldRefSchema).max(500),
});
export const layoutSpecSchema = z.object({
  sections: z.array(layoutSectionRefSchema).max(100),
});
export type LayoutSpec = z.infer<typeof layoutSpecSchema>;

export const layoutSaveSchema = z.object({
  target: z.enum(LAYOUT_TARGETS),
  roleId: z.string().uuid().nullish(),
  layout: layoutSpecSchema,
});
export type LayoutSaveInput = z.infer<typeof layoutSaveSchema>;

// ── uniform API error shape ───────────────────────────────────────────────
/** Every config route returns this on failure. `dependencies` carries the
 *  guardrail scan (spec §13) so the UI can show what breaks before confirm. */
export interface ApiError {
  error: string;
  code?:
    | 'VALIDATION' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT'
    | 'DEPENDENCIES' | 'GUARDRAIL' | 'CAP_EXCEEDED';
  fields?: Record<string, string[]>;
  dependencies?: DependencyReport;
}

/** What would break if this config object were deleted. */
export interface DependencyReport {
  views: { id: string; name: string }[];
  layouts: { id: string; target: string }[];
  imports: { id: string; filename: string }[];
}
