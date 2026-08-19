import { z } from 'zod';
import { FIELD_TYPE_SPECS, type FieldType } from './field-types.js';

/**
 * Validation is generated from field definitions, ONCE, and consumed by both
 * the web app and the worker. Never write a validation rule twice.
 */

export interface FieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  regex?: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  isRequired: boolean;
  isUnique?: boolean;
  validation?: FieldValidation | null;
  options?: { value: string }[];
}

const E164 = /^\+?[1-9]\d{7,14}$/;

/**
 * What a FILE or IMAGE field stores on a record.
 *
 * `name`, `size` and `contentType` are denormalised so a list view, an export
 * and a timeline entry can render without joining Attachment. The bytes are
 * reached only through `attachmentId`.
 */
export const attachmentRefSchema = z.object({
  attachmentId: z.string().uuid(),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

function baseSchema(f: FieldDef): z.ZodTypeAny {
  const v = f.validation ?? {};

  switch (f.type) {
    case 'EMAIL':
      return z.string().email(`${f.label} must be a valid email`);

    case 'PHONE':
      return z.string().regex(E164, `${f.label} must be a valid phone number`);

    case 'URL':
      return z.string().url(`${f.label} must be a valid URL`);

    case 'SINGLE_LINE':
    case 'MULTI_LINE':
    case 'FORMULA':
    case 'AUTONUMBER': {
      let s = z.string();
      if (v.minLength !== undefined) s = s.min(v.minLength, `${f.label} must be at least ${v.minLength} characters`);
      if (v.maxLength !== undefined) s = s.max(v.maxLength, `${f.label} must be at most ${v.maxLength} characters`);
      if (v.regex) s = s.regex(new RegExp(v.regex), `${f.label} is not in the expected format`);
      return s;
    }

    case 'NUMBER':
    case 'DECIMAL':
    case 'CURRENCY':
    case 'PERCENT': {
      let n = z.coerce.number();
      if (v.min !== undefined) n = n.min(v.min, `${f.label} must be at least ${v.min}`);
      if (v.max !== undefined) n = n.max(v.max, `${f.label} must be at most ${v.max}`);
      if (f.type === 'NUMBER') n = n.int(`${f.label} must be a whole number`);
      if (f.type === 'PERCENT') n = n.min(0).max(100);
      return n;
    }

    case 'DATE':
    case 'DATE_TIME':
      return z.coerce.date();

    case 'CHECKBOX':
    case 'TOGGLE':
      return z.boolean();

    case 'DROPDOWN': {
      const vals = (f.options ?? []).map((o) => o.value);
      return vals.length ? z.enum(vals as [string, ...string[]]) : z.string();
    }

    case 'MULTI_SELECT':
    case 'LANGUAGE_PICKER': {
      const vals = (f.options ?? []).map((o) => o.value);
      const item = vals.length ? z.enum(vals as [string, ...string[]]) : z.string();
      return z.array(item);
    }

    case 'USER_LOOKUP':
    case 'RECORD_LINK':
      return z.string().uuid(`${f.label} must reference a valid record`);

    case 'FILE':
    case 'IMAGE':
      // An OPAQUE id, never a URL. Field values land in `AuditLog.changes`
      // via AuditLogger.diff(), and that log is append-only — a stored URL
      // could never be corrected when the bucket, CDN or provider changes.
      // See `Attachment` in schema.prisma.
      return attachmentRefSchema;

    default: {
      const _exhaustive: never = f.type;
      return z.unknown();
    }
  }
}

/** Build a Zod object schema for a whole module from its field definitions. */
export function buildRecordSchema(fields: FieldDef[]): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};

  for (const f of fields) {
    // derived fields are computed server-side, never submitted
    if (FIELD_TYPE_SPECS[f.type].isDerived) continue;

    const s = baseSchema(f);
    shape[f.key] = f.isRequired ? s : s.optional().nullable();
  }

  return z.object(shape);
}

/** Normalise a phone number to the form used as the webhook/dedupe matching key. */
export function normalisePhone(input: string, defaultCountry = '91'): string {
  const digits = input.replace(/\D/g, '');
  if (!digits) return '';
  if (input.trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length > 10 && digits.startsWith(defaultCountry)) return `+${digits}`;
  return `+${digits}`;
}
