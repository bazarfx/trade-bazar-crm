/**
 * Stage 4, "Auto Map": source columns → the module's own fields.
 *
 * The mapping is GENERATED FROM `FieldDefinition`, always. There is no table
 * in this file that knows what a lead is, and there must never be one — the
 * client can add a field called "Referral Partner" this afternoon and a file
 * with that heading has to map itself with no deploy. What the file does hold
 * is a small set of generic English synonyms (e-mail → email, mobile → phone)
 * which describe how humans head a spreadsheet column, not what this CRM
 * stores.
 *
 * Deliberately PURE — no database, no imports beyond types. Stage 4 has an
 * "Auto Map" button that re-runs it after the user has hand-edited, and the
 * answer must be identical whether it is computed in the request or in the
 * browser.
 *
 * Every match is EXACT-FIRST and ambiguity-averse. A wrong auto-mapping is
 * worse than an unmapped column: unmapped is visible in the "Unmapped Columns"
 * tab and takes one click to fix, while a plausible wrong guess imports 40,000
 * phone numbers into the WhatsApp field and nobody notices for a week.
 */
import { FIELD_TYPE_SPECS, type FieldType, type ImportMapping } from '@crm/shared';

export interface AutoMapField {
  key: string;
  label: string;
  type: FieldType;
  isRequired: boolean;
}

export interface AutoMapResult {
  mapping: ImportMapping;
  /** columns in the file that fed nothing — the "Unmapped Columns" tab */
  unmappedColumns: string[];
  /** fields nothing feeds — the other half of the same screen */
  unmappedFields: { key: string; label: string; isRequired: boolean }[];
}

/**
 * Generic column-heading synonyms, folded on BOTH sides.
 *
 * Both the file's heading and the Admin's field label go through the same
 * fold, so this is a statement about English, not about the data model:
 * "Mobile No." and "Phone Number" are the same word to a person, and a field
 * an Admin names either way must be reachable from a file that says the other.
 *
 * Kept small on purpose. Anything that folds two DISTINCT fields together —
 * whatsapp → phone, say, when Leads carries both — turns a helpful guess into
 * a silent mismapping, so the fold covers only words that are true synonyms.
 */
const SYNONYMS: Record<string, string> = {
  'e mail': 'email',
  mail: 'email',
  emailid: 'email',
  mobile: 'phone',
  cell: 'phone',
  cellphone: 'phone',
  telephone: 'phone',
  tel: 'phone',
  msisdn: 'phone',
  contact: 'phone',
  surname: 'lastname',
  town: 'city',
  state: 'region',
  province: 'region',
  comments: 'notes',
  remarks: 'notes',
  description: 'notes',
};

/** Words that carry no meaning in a column heading. Dropped from both sides so
 *  "Phone No." and "Phone Number" and "Phone" are one heading. */
const NOISE = new Set(['no', 'nos', 'number', 'num', 'nbr', 'id', 'of', 'the', 'a', 'an', 'and', 'or']);

/** Lower-case, punctuation to spaces, runs collapsed. `lead_status` and
 *  "Lead Status" and "LEAD-STATUS" all land on the same string. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The synonym-folded, noise-stripped token set, sorted so word order does not
 *  matter: "Primary Phone" and "Phone (Primary)" are the same heading. */
function canonical(text: string): string {
  const normalised = normalise(text);
  const folded = SYNONYMS[normalised] ?? normalised;
  const tokens = folded
    .split(' ')
    .map((t) => SYNONYMS[t] ?? t)
    .filter((t) => t !== '' && !NOISE.has(t));
  // Every token was noise ("No.", "ID") — nothing left to match on, and
  // matching on emptiness would pair every such column with every such field.
  if (tokens.length === 0) return '';
  return [...new Set(tokens)].sort().join(' ');
}

function tokensOf(text: string): string[] {
  const c = canonical(text);
  return c === '' ? [] : c.split(' ');
}

const contains = (outer: string[], inner: string[]): boolean =>
  inner.length > 0 && inner.every((t) => outer.includes(t));

/**
 * A field a spreadsheet cell can actually feed.
 *
 * Derived types are computed server-side and FILE/IMAGE hold an attachment
 * reference to bytes a file has none of, so auto-mapping either would offer
 * the user a mapping that can only fail — once per row, 40,000 times.
 */
export function isImportableType(type: FieldType): boolean {
  return !FIELD_TYPE_SPECS[type].isDerived && type !== 'FILE' && type !== 'IMAGE';
}

export function autoMap(headers: string[], fields: AutoMapField[]): AutoMapResult {
  const candidates = fields.filter((f) => isImportableType(f.type));

  const takenFields = new Set<string>();
  const matched = new Map<string, string>();

  /** Run one matching rule over every still-unmatched column, in file order.
   *  A field already claimed is out of the running — `importMappingSchema`
   *  refuses two columns feeding one field, and there is no honest answer to
   *  which of them should win. */
  const pass = (pick: (header: string, pool: AutoMapField[]) => AutoMapField | null): void => {
    for (const header of headers) {
      if (matched.has(header)) continue;
      const pool = candidates.filter((f) => !takenFields.has(f.key));
      const hit = pick(header, pool);
      if (!hit) continue;
      matched.set(header, hit.key);
      takenFields.add(hit.key);
    }
  };

  // 1. the field KEY, as an export from this system would write it
  pass((header, pool) => {
    const n = normalise(header);
    return pool.find((f) => normalise(f.key) === n) ?? null;
  });

  // 2. the field LABEL exactly as the Admin wrote it
  pass((header, pool) => {
    const n = normalise(header);
    return pool.find((f) => normalise(f.label) === n) ?? null;
  });

  // 3. the same heading in different words — synonyms folded, noise dropped
  pass((header, pool) => {
    const c = canonical(header);
    if (c === '') return null;
    const hits = pool.filter((f) => canonical(f.label) === c || canonical(f.key) === c);
    // Two fields answering to one heading is the ambiguous case; leaving the
    // column unmapped puts the choice in front of the user, where it belongs.
    return hits.length === 1 ? (hits[0] ?? null) : null;
  });

  // 4. one heading contained in the other ("Phone" ⊂ "Phone (Primary)"), and
  //    ONLY when exactly one field can be read that way.
  pass((header, pool) => {
    const h = tokensOf(header);
    if (h.length === 0) return null;
    const hits = pool.filter((f) => {
      const l = tokensOf(f.label);
      const k = tokensOf(f.key);
      return contains(h, l) || contains(l, h) || contains(h, k) || contains(k, h);
    });
    return hits.length === 1 ? (hits[0] ?? null) : null;
  });

  const mapping: ImportMapping = {
    // Every column is listed, mapped or not: stage 4's tabs are counts over
    // this array, and a column missing from it would vanish from the screen
    // rather than appear under "Unmapped Columns".
    columns: headers.map((header) => ({
      column: header,
      field: matched.get(header) ?? null,
      skip: false,
      defaultValue: null,
    })),
  };

  return {
    mapping,
    unmappedColumns: headers.filter((h) => !matched.has(h)),
    unmappedFields: candidates
      .filter((f) => !takenFields.has(f.key))
      .map((f) => ({ key: f.key, label: f.label, isRequired: f.isRequired })),
  };
}
