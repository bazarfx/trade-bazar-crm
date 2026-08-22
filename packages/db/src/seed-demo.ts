/**
 * DEMO DATA — ~200 leads, written through the real engine.
 *
 * Run:  npm run db:seed:demo
 *       npm run db:seed:demo -- --count=500
 *       npm run db:seed:demo -- --wipe
 *
 * This is NOT `seed.ts`. That one seeds CONFIGURATION — modules, fields,
 * statuses, roles — and is idempotent because every write is an upsert. This
 * one creates RECORDS, so it is a separate command, it refuses to run twice
 * without a wipe, and everything it makes carries a marker.
 *
 * ── WHY IT GOES THROUGH `createRecord` ──────────────────────────────────
 *
 * The obvious implementation is `prisma.lead.createMany`. It would be a tenth
 * of this file and it would produce a database that lies:
 *
 *   - every lead needs an owner (invariant 1) and `Lead.ownerId` is NOT NULL,
 *     so a direct insert has to pick one — which means reimplementing the
 *     assignment engine, badly, and the round-robin cursor never advances;
 *   - every mutation is logged (invariant 2) and the timeline IS that log, so
 *     a directly inserted lead opens on an empty timeline. Not "sparse" —
 *     EMPTY. The record detail screen's centre column would be blank on all
 *     200 rows, which is precisely the screen a demo is for;
 *   - phones would not be normalised, so the ARK webhook and the duplicate
 *     scan (both of which match on the normalised number) would miss them;
 *   - no duplicate flag would ever be raised, so the review queue would be
 *     empty however many collisions the data contains.
 *
 * That is four of the five invariants broken by a convenience. So this calls
 * the same `createRecord` the form, the import worker and the campaign intake
 * webhook call. `@crm/records` is runtime-agnostic for exactly this reason
 * (CLAUDE.md, "Runtime-agnostic: web AND worker both import it") — the worker
 * already imports it, and so does this.
 *
 * The cost is honest: ~6 round trips per lead and a row lock on the rota that
 * makes the writes serial. Measured at 200 leads — about 2.5s against a local
 * Postgres, and proportionally longer against a pooled database in another
 * region, where the round trips dominate. It is a demo seed. Correct is worth
 * more than fast.
 *
 * ── WHY THIS FILE IS EXCLUDED FROM `packages/db/tsconfig.json` ───────────
 *
 * `packages/records` references `packages/db`. A project reference back the
 * other way is a cycle, which TypeScript rejects outright. So the composite
 * build skips this file and `packages/db/tsconfig.seed-demo.json` — a plain,
 * non-composite project — typechecks it instead, wired into `npm run
 * typecheck` so it is not silently unchecked. This file is a SCRIPT: nothing
 * imports it, so it is never part of the db package's public surface and the
 * exclusion costs nothing.
 */
import { prisma } from './index.js';
import { FIELD_TYPE_SPECS, type FieldType } from '@crm/shared';
import { createRecord, storageFor, systemPrincipal } from '@crm/records';

/* ── what marks a demo lead ───────────────────────────────────────────── */

/**
 * Every lead this script creates carries EXACTLY this string in
 * `Lead.referralCode`, and `--wipe` deletes exactly the rows that match it.
 *
 * An exact equality, not a prefix: a prefix match is a scan whose blast radius
 * grows with anything anyone types, and this value decides what gets deleted.
 * `referralCode` was chosen over a `custom` JSONB key because it is a real
 * indexed-ish column an operator can also SEE in the UI — the client can tell
 * demo rows from real ones without opening a database console, which is the
 * property that makes a reset safe to offer at all.
 */
const DEMO_MARKER = 'DEMO-SEED';

/**
 * Seed data names a module, exactly as `seed.ts` does. That is not the
 * module-specific code CLAUDE.md forbids: the prime directive is about
 * ENGINES and UI components, and nothing below is either. The engine call
 * takes this slug as an argument and branches on nothing.
 */
const DEMO_MODULE_SLUG = 'leads';

/** ~200 unless `--count=N` says otherwise. */
const DEFAULT_COUNT = 200;
/** A ceiling, so a fat-fingered `--count` cannot start a six-hour job. */
const MAX_COUNT = 5_000;

/**
 * The audit identity every row is written under.
 *
 * `ActorType` has four system members and none of them is "demo seed". Adding
 * one is a migration on an enum, for a development tool — churn on the schema
 * that invariant 3 exists to prevent. `SYSTEM_IMPORT` is the honest fit of the
 * four: a demo seed IS a bulk load of records from outside, which is what the
 * import path means. The timeline renders "System (Import)" on every demo
 * lead, which is true.
 */
const DEMO_ACTOR = 'SYSTEM_IMPORT' as const;

/* ── the connection guard ─────────────────────────────────────────────── */

/**
 * Mirrors `tools/guard-local-db.js`, for the same reason and with the same
 * bias: the check is on the CONNECTION TARGET, never on `NODE_ENV`. NODE_ENV
 * is "development" in exactly the accident this defends against — a .env still
 * pointing at Supabase while someone runs what they think is a local command.
 *
 * The stakes differ from that guard's, and are not smaller. `migrate dev` can
 * reset a database; this writes 200 fabricated leads into one and, with
 * `--wipe`, deletes rows. Neither belongs in a production CRM by accident.
 *
 * `ALLOW_DEMO_SEED_REMOTE=1` is the deliberate override — a staging box being
 * loaded for a client walkthrough is a real use — and it must be typed out in
 * full every time. It is never read from a file this repo ships.
 */
const REMOTE_OVERRIDE = 'ALLOW_DEMO_SEED_REMOTE';

/** Host, port and database name — never the credentials in front of them. */
function describeTarget(raw: string): string {
  try {
    const u = new URL(raw);
    const db = u.pathname.replace(/^\//, '') || '(default)';
    return `${u.hostname}${u.port ? `:${u.port}` : ''}/${db}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

function isLocal(raw: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1', ''].includes(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * Which database this is about to write to, and whether that is allowed.
 *
 * `DATABASE_URL` and not `DIRECT_URL`, deliberately: every write below goes
 * through `createRecord`, which uses the shared client in `@crm/db`, and that
 * client reads `DATABASE_URL`. Guarding a URL nothing connects on would be a
 * guard in name only. `DIRECT_URL` is checked too when it is set, because a
 * repo configured with a remote direct URL and a local pooled one is a
 * misconfiguration worth stopping on either way.
 */
function assertTargetAllowed(): string {
  const primary = process.env['DATABASE_URL'] ?? '';
  if (primary === '') {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }
  const direct = process.env['DIRECT_URL'] ?? '';

  const checked = [
    { label: 'target database ', url: primary },
    // Checked even though nothing here connects on it: a repo with one URL
    // local and the other hosted is a misconfiguration, and letting the run
    // proceed would mean the operator's mental model of "where am I pointed"
    // is wrong in a session that ends in a delete.
    ...(direct === '' ? [] : [{ label: 'prisma CLI url  ', url: direct }]),
  ].map((e) => ({ ...e, target: describeTarget(e.url), local: isLocal(e.url) }));

  // Printed BEFORE the decision, and whichever way it goes: the one thing a
  // destructive tool must never do is act on a database the operator did not
  // realise it was pointed at. Each line says what it IS, so a refusal below
  // can be traced to the line that caused it.
  for (const e of checked) {
    console.log(`  ${e.label}   ${e.target}${e.local ? '  (local)' : '  (NOT localhost)'}`);
  }

  const remote = checked.filter((e) => !e.local);
  if (remote.length > 0 && process.env[REMOTE_OVERRIDE] !== '1') {
    throw new Error(
      `Refusing to run: ${remote.map((e) => `${e.label.trim()} → ${e.target}`).join(', ')}\n\n` +
        '  This command writes fabricated records, and --wipe deletes rows.\n' +
        '  Neither belongs in a hosted database by accident.\n\n' +
        `  If you really mean it:  ${REMOTE_OVERRIDE}=1 npm run db:seed:demo\n`,
    );
  }
  if (remote.length > 0) {
    console.log(`  ${REMOTE_OVERRIDE}  set — proceeding against a non-local database`);
  }
  // The one this actually writes through — `@crm/db`'s client reads it.
  return checked[0]?.target ?? '(unknown)';
}

/* ── a deterministic generator ────────────────────────────────────────── */

/**
 * mulberry32, seeded from a constant.
 *
 * Deterministic on purpose: the same command produces the same 200 people
 * every time, so a screenshot in a bug report matches what the next person
 * sees, and the deliberate duplicates land in the same places rather than
 * appearing and vanishing between runs. `Math.random()` would make the review
 * queue's contents different on every reset.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_SEED_VALUE = 0x7bcf12;

/**
 * One element, or a throw. `noUncheckedIndexedAccess` makes the undefined case
 * explicit and it is a real one — a picklist an Admin emptied reaches here as
 * an empty array, and generating from nothing silently would produce leads
 * with a missing field rather than a message saying which field is empty.
 */
function pick<T>(random: () => number, from: readonly T[], what: string): T {
  const item = from[Math.floor(random() * from.length)];
  if (item === undefined) throw new Error(`Nothing to pick from for "${what}"`);
  return item;
}

function intBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/* ── the people ───────────────────────────────────────────────────────── */

/**
 * Names and cities grouped by the language a lead speaks, so a Tamil-speaking
 * lead is called Subramanian and lives in Coimbatore rather than being three
 * unrelated dice rolls. Assignment routes on language, so a demo where the
 * language means something is a demo where the round-robin is readable.
 *
 * Keyed by the SEEDED language strings, which is safe here for the same reason
 * naming a module is: this is seed data, not application code. And it never
 * assumes — a language with no entry (an Admin added "Bengali" this morning)
 * falls through to `PAN_INDIA` below rather than failing.
 */
interface Region {
  given: readonly string[];
  family: readonly string[];
  cities: readonly string[];
}

const PAN_INDIA: Region = {
  given: ['Aarav', 'Ananya', 'Rohan', 'Priya', 'Vikram', 'Neha', 'Karan', 'Sneha', 'Aditya', 'Isha'],
  family: ['Sharma', 'Nair', 'Reddy', 'Patel', 'Khan', 'Das', 'Bose', 'Joshi'],
  cities: ['Mumbai', 'Bengaluru', 'Pune', 'Kolkata', 'Noida', 'Gurugram'],
};

const REGIONS: Record<string, Region> = {
  English: PAN_INDIA,
  Hindi: {
    given: ['Rajesh', 'Sunita', 'Amit', 'Pooja', 'Manish', 'Kavita', 'Deepak', 'Ritu', 'Sanjay', 'Meena'],
    family: ['Sharma', 'Verma', 'Gupta', 'Yadav', 'Singh', 'Mishra', 'Tiwari', 'Chauhan'],
    cities: ['Delhi', 'Jaipur', 'Lucknow', 'Kanpur', 'Bhopal', 'Patna', 'Indore'],
  },
  Tamil: {
    given: ['Karthik', 'Divya', 'Senthil', 'Lakshmi', 'Arun', 'Revathi', 'Prabhu', 'Janani', 'Vignesh', 'Kavya'],
    family: ['Subramanian', 'Iyer', 'Murugan', 'Selvam', 'Rajan', 'Krishnan', 'Balaji', 'Sundaram'],
    cities: ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem', 'Erode'],
  },
  Telugu: {
    given: ['Srinivas', 'Padma', 'Ravi', 'Swathi', 'Naveen', 'Anitha', 'Kiran', 'Sirisha', 'Mahesh', 'Bhavana'],
    family: ['Reddy', 'Naidu', 'Rao', 'Chowdary', 'Varma', 'Prasad', 'Sastry', 'Gupta'],
    cities: ['Hyderabad', 'Visakhapatnam', 'Vijayawada', 'Guntur', 'Warangal', 'Tirupati'],
  },
  Urdu: {
    given: ['Imran', 'Ayesha', 'Faisal', 'Zoya', 'Salman', 'Nazia', 'Tariq', 'Rukhsar', 'Adnan', 'Sadia'],
    family: ['Khan', 'Ansari', 'Siddiqui', 'Qureshi', 'Sheikh', 'Rizvi', 'Farooqui', 'Hussain'],
    cities: ['Hyderabad', 'Lucknow', 'Bhopal', 'Aligarh', 'Malegaon', 'Moradabad'],
  },
  Malayalam: {
    given: ['Arjun', 'Anjali', 'Vishnu', 'Meera', 'Sreejith', 'Lekha', 'Nikhil', 'Parvathy', 'Rahul', 'Gayathri'],
    family: ['Nair', 'Menon', 'Pillai', 'Kurup', 'Varghese', 'Thomas', 'Warrier', 'Panicker'],
    cities: ['Kochi', 'Thiruvananthapuram', 'Kozhikode', 'Thrissur', 'Kollam', 'Kannur'],
  },
  Gujarati: {
    given: ['Jignesh', 'Hetal', 'Bhavesh', 'Krupa', 'Nilesh', 'Foram', 'Chirag', 'Bhoomi', 'Hardik', 'Nidhi'],
    family: ['Patel', 'Shah', 'Desai', 'Mehta', 'Trivedi', 'Joshi', 'Parekh', 'Bhatt'],
    cities: ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Bhavnagar', 'Jamnagar'],
  },
};

function regionFor(language: string): Region {
  return REGIONS[language] ?? PAN_INDIA;
}

/** Indexing under `noUncheckedIndexedAccess`, where the modulo already
 *  guarantees the index is in range. */
function at<T>(from: readonly T[], i: number, what: string): T {
  const item = from[i];
  if (item === undefined) throw new Error(`No ${what} at index ${i}`);
  return item;
}

/**
 * The next unused given+family pair for a language.
 *
 * ENUMERATED, not sampled, and that is a correction to a measured mistake.
 * Picking both names at random gave 200 leads roughly 28 per language out of
 * 80 possible pairs — a birthday-paradox collision rate that flagged 41
 * duplicates where 13 were designed. Since the duplicate scan matches on name
 * PLUS language, accidental twins looked exactly like the deliberate ones and
 * the review queue stopped demonstrating anything.
 *
 * Walking a per-language cursor over the cross product visits all
 * given × family pairs before repeating any, so within a language every name
 * is distinct until the pool is exhausted. At the default 200 it never is. At
 * a large `--count` it wraps, which is honest: the extra collisions are then
 * real duplicates in a dataset big enough to have them.
 *
 * Two languages that share a region (English and anything an Admin adds, both
 * of which fall through to PAN_INDIA) keep SEPARATE cursors and may therefore
 * produce the same name — harmless, because the match needs the language to
 * agree too.
 */
function nextName(
  cursors: Map<string, number>,
  language: string,
  region: Region,
): { given: string; family: string } {
  const k = cursors.get(language) ?? 0;
  cursors.set(language, k + 1);
  return {
    given: at(region.given, k % region.given.length, 'given name'),
    family: at(
      region.family,
      Math.floor(k / region.given.length) % region.family.length,
      'family name',
    ),
  };
}

/**
 * `example.com` is IANA's reserved documentation domain (RFC 2606). Every
 * address below is therefore guaranteed unroutable — a demo dataset that
 * cannot, even by accident, be exported into a mail merge that reaches a real
 * person.
 */
function emailFor(given: string, family: string, n: number): string {
  return `${given}.${family}${n}`.toLowerCase().replace(/[^a-z0-9.]/g, '') + '@example.com';
}

/** An Indian mobile number in the real 6–9 leading-digit band; the engine
 *  normalises it to E.164 on the way in, which is half the point of using it. */
function phoneFor(random: () => number): string {
  return String(intBetween(random, 6, 9)) + String(intBetween(random, 0, 999999999)).padStart(9, '0');
}

/* ── module config, read live ─────────────────────────────────────────── */

/** A live field of the module, as the generator needs it. */
interface LiveField {
  key: string;
  label: string;
  type: FieldType;
  isRequired: boolean;
  systemColumn: string | null;
  /** live picklist values, for the types that have them */
  options: string[];
}

/**
 * The physical column a status field points at — the same name on the core
 * tables and on the generic `records` table. Keyed on the COLUMN rather than a
 * field key, a label or a module slug, exactly as the list screen and the cell
 * renderer key the status chip.
 */
const STATUS_COLUMN = 'statusId';

/** The `ModuleDefinition` row, or a message saying to run the config seed. */
async function moduleRow() {
  const module = await prisma.moduleDefinition.findFirst({
    where: { slug: DEMO_MODULE_SLUG, isEnabled: true },
    select: { id: true, slug: true, isCore: true },
  });
  if (!module) {
    throw new Error(
      `Module "${DEMO_MODULE_SLUG}" is missing or disabled. Run \`npm run db:seed\` first.`,
    );
  }
  return module;
}

/**
 * The `AuditLog.entityType` discriminator for this module's rows, asked of the
 * storage resolver.
 *
 * NEVER the literal 'Lead'. That string is the PRISMA MODEL NAME and only the
 * storage layer is allowed to know it (see `DelegateShape.entityType`); a
 * literal here would silently stop matching if the model were renamed, and
 * both the wipe and the summary below would then report success while doing
 * nothing. `isCore` is read off the row rather than assumed, for the same
 * reason `coreModuleStorages` does.
 */
async function entityTypeOf(): Promise<string> {
  const module = await moduleRow();
  return storageFor({ slug: module.slug, isCore: module.isCore }, []).shape.entityType;
}

/**
 * The module's fields and its usable statuses, read from the database rather
 * than assumed from `seed-data.ts`.
 *
 * The difference matters: an Admin may have retired a picklist option or
 * deleted a field since the config seed ran, and generating a value the field
 * no longer accepts turns into 200 validation failures with an unhelpful
 * message. Reading live means the generator produces what the module actually
 * takes today.
 */
async function readModule() {
  const module = await moduleRow();

  const rows = await prisma.fieldDefinition.findMany({
    where: { moduleId: module.id, isDeleted: false },
    select: {
      key: true,
      label: true,
      type: true,
      isRequired: true,
      systemColumn: true,
      options: { where: { isDeleted: false }, select: { value: true } },
    },
  });
  const fields = new Map<string, LiveField>(
    rows.map((f) => [
      f.key,
      {
        key: f.key,
        label: f.label,
        type: f.type as FieldType,
        isRequired: f.isRequired,
        systemColumn: f.systemColumn,
        options: f.options.map((o) => o.value),
      },
    ]),
  );

  assertPicklistsUsable(fields);

  /**
   * The statuses a demo lead may hold.
   *
   * `isSystem` is the flag meaning "the platform sets this, not a person" —
   * on the seeded set that is `SIGNED_UP` and `CONVERTED`, both written by the
   * ARK webhook at the conversion moment. A demo lead parked in one of those
   * with no Deal and no deposit behind it would be a lie the screens then
   * repeat, so they are excluded — by the FLAG, never by the name. (CLAUDE.md:
   * "Nothing in application code may reference a seeded status by name.")
   */
  const statuses = await prisma.status.findMany({
    where: { moduleId: module.id, isDeleted: false, isSystem: false },
    orderBy: { displayOrder: 'asc' },
    select: { id: true, name: true },
  });
  if (statuses.length === 0) {
    throw new Error(
      `Module "${DEMO_MODULE_SLUG}" has no non-system statuses. Run \`npm run db:seed\` first.`,
    );
  }

  return { module, fields, statuses };
}

/**
 * A REQUIRED picklist with no live options accepts nothing, so every create
 * would fail — 200 times, with a Zod blob naming a field the operator has to
 * go and find. `buildRecordSchema` is explicit about it: a picklist with no
 * options compiles to `z.never()`, deliberately, "because falling back to a
 * free string is how an unconstrained value reaches the database".
 *
 * So it is checked ONCE, up front, and the message says which field and what
 * to do. Caught in practice on a local database seeded before the `source`
 * options existed: without this the run reported "failed 200" and pasted a
 * JSON error.
 *
 * `statusId` is excluded, and not as a special case: its choices come from the
 * `Status` table rather than from `PicklistOption` (the engine passes them in
 * as `referenceOptions`), so having none of the latter is normal. The test is
 * on the physical COLUMN, which is how every other screen asks this question.
 *
 * `FIELD_TYPE_SPECS[...].hasOptions` is the operator registry answering "does
 * this type have a picklist" — never a hand-written list of type names, so a
 * type added later is covered without touching this file.
 */
function assertPicklistsUsable(fields: Map<string, LiveField>): void {
  const empty = [...fields.values()].filter(
    (f) =>
      f.isRequired &&
      FIELD_TYPE_SPECS[f.type].hasOptions &&
      f.systemColumn !== STATUS_COLUMN &&
      f.options.length === 0,
  );
  if (empty.length === 0) return;

  throw new Error(
    `These required fields have no options configured, so nothing can be created:\n` +
      empty.map((f) => `    · ${f.label} (${f.key})`).join('\n') +
      '\n\n  Run `npm run db:seed` — it upserts the seeded picklist options and\n' +
      '  never clobbers anything an Admin has edited.\n',
  );
}

/**
 * Live option values for a picklist field, or null when the module has no such
 * field or the Admin has retired every option on it. The generator then simply
 * does not send that key, which is what keeps this script working against a
 * module somebody has pruned.
 *
 * LIVE VALUES ONLY — there is deliberately no fallback to the constants in
 * `seed-data.ts`. A fallback looks helpful and is not: the engine builds its
 * schema from the same `PicklistOption` rows read here, so a seeded value the
 * database no longer holds is a value the engine rejects. It would turn a
 * clear "this field has no options" into 200 opaque validation failures, which
 * is exactly what it did before `assertPicklistsUsable` existed.
 */
function optionsOf(fields: Map<string, LiveField>, key: string): string[] | null {
  const field = fields.get(key);
  if (!field) return null;
  return field.options.length > 0 ? field.options : null;
}

/**
 * A validation failure in words rather than as a JSON dump.
 *
 * `buildRecordSchema` throws a ZodError, whose `.message` is the serialised
 * issue array — twelve lines of JSON per lead, repeated for every row. This
 * reads the issues structurally (no zod import needed in this package: the
 * shape is `{ issues: [{ path, message }] }`) and falls back to the message
 * for anything that is not one, so a `ConfigError` still reads normally.
 */
function readableError(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'issues' in err) {
    const issues = (err as { issues?: unknown }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .map((raw) => {
          const issue = raw as { path?: unknown; message?: unknown };
          const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
          const message = String(issue.message ?? 'invalid');
          return path === '' ? message : `${path}: ${message}`;
        })
        .join('; ');
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/* ── the generator ────────────────────────────────────────────────────── */

interface DemoLead {
  values: Record<string, unknown>;
  /** for the summary only — what this row was built to collide with, if any */
  duplicateOf: 'phone' | 'name_language' | null;
}

/**
 * Build the whole batch up front, so the deliberate duplicates can point at
 * rows that are guaranteed to exist and the summary can be checked against the
 * intent before a single write happens.
 *
 * Every optional key is set only when the module still HAS that field and that
 * field still has options — see `optionsOf`. The five required ones (name,
 * phone, language, source, status) are asserted by `readModule`.
 */
function generate(
  count: number,
  fields: Map<string, LiveField>,
  statusIds: string[],
): DemoLead[] {
  const random = rng(DEMO_SEED_VALUE);

  // Every picklist read LIVE — see `optionsOf` for why there is no fallback to
  // the constants in seed-data.ts. `language` and `source` are required, so
  // `assertPicklistsUsable` has already guaranteed they are non-empty; the
  // rest may legitimately be absent and are simply not sent.
  const languages = optionsOf(fields, 'language');
  const sources = optionsOf(fields, 'source');
  const categories = optionsOf(fields, 'leadCategory');
  const genders = optionsOf(fields, 'gender');
  const contactMethods = optionsOf(fields, 'contactMethod');
  const salutations = optionsOf(fields, 'salutation');
  const markets = optionsOf(fields, 'preferredMarket');

  const out: DemoLead[] = [];

  /**
   * The deliberate collisions, so the review queue has something in it.
   *
   * BOTH match reasons the duplicate scan knows are covered — `phone` and
   * `name_language` (see `flagDuplicates` in the record engine) — because a
   * queue containing only one kind would not exercise the screen. They are
   * placed at fixed positions rather than sprinkled randomly so the count is
   * exact and predictable: every 23rd row repeats an earlier row's phone,
   * every 37th repeats an earlier row's name and language.
   */
  const PHONE_TWIN_EVERY = 23;
  const NAME_TWIN_EVERY = 37;

  // Belt and braces on top of `assertPicklistsUsable`: if either of the two
  // REQUIRED picklists is somehow empty here, say so rather than generate 200
  // rows the engine will refuse.
  if (languages === null || sources === null) {
    throw new Error(
      'The Language or Source field has no options. Run `npm run db:seed` first.',
    );
  }

  /** language → how many names have been handed out for it. See `nextName`. */
  const nameCursors = new Map<string, number>();

  for (let i = 0; i < count; i += 1) {
    const language = pick(random, languages, 'language');
    const region = regionFor(language);
    const { given, family } = nextName(nameCursors, language, region);

    // The row this one is built to collide with. `i - 5` rather than `i - 1`
    // so the pair is not adjacent in the list — a duplicate you can only find
    // by scrolling is the case the review queue exists for.
    const twinAt = i - 5;
    const twin = twinAt >= 0 ? out[twinAt] : undefined;
    const phoneTwin = twin !== undefined && i > 0 && i % PHONE_TWIN_EVERY === 0;
    const nameTwin = !phoneTwin && twin !== undefined && i > 0 && i % NAME_TWIN_EVERY === 0;

    const fullName = nameTwin
      ? String(twin.values['fullName'])
      : `${given} ${family}`;
    const leadLanguage = nameTwin ? String(twin.values['language']) : language;
    const phone = phoneTwin ? String(twin.values['phone']) : phoneFor(random);

    const values: Record<string, unknown> = {
      fullName,
      phone,
      language: leadLanguage,
      source: pick(random, sources, 'source'),
      statusId: pick(random, statusIds, 'status'),
      // THE MARKER. Every demo row carries it; --wipe deletes exactly these.
      referralCode: DEMO_MARKER,
    };

    // Optional colour, each guarded on the field still existing. `email` and
    // the free-text columns need no option list; the picklists do.
    if (fields.has('email')) values['email'] = emailFor(given, family, i + 1);
    if (fields.has('location')) values['location'] = pick(random, region.cities, 'city');
    if (fields.has('country')) values['country'] = `${pick(random, region.cities, 'city')}, India`;
    if (fields.has('amount')) {
      // Deposit-sized figures in INR, on round thousands — the Amount column
      // is scanned, and 47,213 reads as noise where 45,000 reads as a number
      // somebody chose.
      values['amount'] = intBetween(random, 5, 250) * 1_000;
    }
    if (categories !== null) values['leadCategory'] = pick(random, categories, 'lead category');
    if (genders !== null) values['gender'] = pick(random, genders, 'gender');
    if (contactMethods !== null) {
      values['contactMethod'] = pick(random, contactMethods, 'contact method');
    }
    if (salutations !== null) values['salutation'] = pick(random, salutations, 'salutation');
    if (markets !== null) {
      // MULTI_SELECT takes an array; one or two markets each.
      const first = pick(random, markets, 'preferred market');
      const second = pick(random, markets, 'preferred market');
      values['preferredMarket'] = first === second ? [first] : [first, second];
    }
    if (fields.has('whatsapp') && random() < 0.6) values['whatsapp'] = phone;
    if (fields.has('notes') && random() < 0.35) {
      values['notes'] = pick(
        random,
        [
          'Asked to be called back after 6pm.',
          'Interested in commodities, wants a demo of the terminal.',
          'Already trades elsewhere — comparing brokerage.',
          'Number reached voicemail twice.',
          'Wants the account opened in a spouse’s name too.',
        ],
        'note',
      );
    }

    out.push({
      values,
      duplicateOf: phoneTwin ? 'phone' : nameTwin ? 'name_language' : null,
    });
  }

  return out;
}

/* ── wipe ─────────────────────────────────────────────────────────────── */

/**
 * Delete every demo lead and the rows that exist only because of it.
 *
 * THIS IS THE ONE PLACE IN THE PRODUCT THAT HARD-DELETES A RECORD AND ITS
 * AUDIT ROWS, and it is worth being explicit about why that is not a breach of
 * invariants 2 and 4 rather than quietly hoping nobody notices:
 *
 *   - Invariant 4 ("soft delete, always") protects CUSTOMER data — a field an
 *     Admin removes must leave 40,000 leads readable. These 200 leads are not
 *     customer data. They are fabricated rows this same script wrote minutes
 *     ago, and "reset the demo" is meaningless if they only go grey.
 *   - Invariant 2 ("never DELETE from the audit log") protects the timeline of
 *     records that EXIST. The rows removed here are the timeline of records
 *     being removed in the same breath; leaving them would leave a log that
 *     narrates the history of nothing, which is not an audit trail, it is
 *     litter that no code path can ever read or clean.
 *
 * What keeps it safe is the scope, not the intent:
 *
 *   1. it only ever matches `referralCode = DEMO-SEED`, an exact equality;
 *   2. the audit delete is keyed on THOSE lead ids and nothing else;
 *   3. the connection guard has already refused a non-local database;
 *   4. it prints what it found before it deletes it.
 *
 * It cannot touch a row it did not create unless somebody deliberately types
 * the marker into a real lead's Referral Code — and it says how many rows it
 * is about to remove before it removes them.
 */
async function wipe(): Promise<void> {
  const leads = await prisma.lead.findMany({
    where: { referralCode: DEMO_MARKER },
    select: { id: true },
  });
  const ids = leads.map((l) => l.id);

  if (ids.length === 0) {
    console.log('\n  nothing to wipe    no lead carries the demo marker\n');
    return;
  }

  console.log(`\n  found              ${ids.length} demo leads (referralCode = "${DEMO_MARKER}")`);

  const entityType = await entityTypeOf();

  // Flags first. `DuplicateFlag` cascades from `Lead`, so this is not strictly
  // required — it is done explicitly so the summary can report a real number
  // rather than "and some unknown quantity of flags went too".
  const flags = await prisma.duplicateFlag.deleteMany({
    where: {
      OR: [{ primaryLeadId: { in: ids } }, { candidateLeadId: { in: ids } }],
    },
  });

  // The audit rows OF THESE LEADS. Scoped by both columns of the log's own
  // index, so this can never widen to another module's history.
  const audits = await prisma.auditLog.deleteMany({
    where: { entityType, entityId: { in: ids } },
  });

  const removed = await prisma.lead.deleteMany({ where: { id: { in: ids } } });

  console.log(`  duplicate flags    ${flags.count} removed`);
  console.log(`  audit rows         ${audits.count} removed (entityType "${entityType}")`);
  console.log(`  leads              ${removed.count} removed`);
  console.log('\n✓ demo data wiped\n');
}

/* ── seed ─────────────────────────────────────────────────────────────── */

async function seed(count: number): Promise<void> {
  const existing = await prisma.lead.count({ where: { referralCode: DEMO_MARKER } });
  if (existing > 0) {
    // Refuse rather than add. Running this twice would double the dataset and
    // there would be no way to tell the two runs apart afterwards — every row
    // carries the same marker. A wipe is one command away.
    throw new Error(
      `${existing} demo leads already exist.\n\n` +
        '  This command creates records, so running it twice doubles the data.\n' +
        '  Reset first:  npm run db:seed:demo -- --wipe\n',
    );
  }

  const { fields, statuses } = await readModule();
  const statusIds = statuses.map((s) => s.id);

  console.log(`  module             ${DEMO_MODULE_SLUG}`);
  console.log(`  usable statuses    ${statuses.length} (system-set ones excluded)`);
  console.log(`  live fields        ${fields.size}`);

  const batch = generate(count, fields, statusIds);
  const intendedDuplicates = batch.filter((b) => b.duplicateOf !== null).length;
  console.log(`  to create          ${batch.length} leads, ${intendedDuplicates} deliberate duplicates\n`);

  /**
   * ONE principal for the whole run. `systemPrincipal` gives the engine an
   * identity with platform-wide scope and no user behind it: audit rows are
   * written as `actorType: SYSTEM_IMPORT, actorId: null`, `createdById` stays
   * NULL, and the timeline says "System (Import)" rather than naming somebody
   * who was not there.
   */
  const principal = systemPrincipal(DEMO_ACTOR);

  const owners = new Map<string, number>();
  let created = 0;
  const failures: string[] = [];

  // SEQUENTIAL, and that is a decision rather than an oversight. `assignOwner`
  // advances the round-robin with a row lock on the rota key that is held until
  // the create commits, so parallel creates against the same language group
  // serialise anyway — they just do it while holding connections and burning
  // the transaction timeout. See the note on `{ timeout: 30_000 }` in
  // `createRecord`.
  for (const [i, lead] of batch.entries()) {
    try {
      const row = await createRecord(principal, DEMO_MODULE_SLUG, lead.values);
      created += 1;
      const ownerId = row['ownerId'];
      if (typeof ownerId === 'string') owners.set(ownerId, (owners.get(ownerId) ?? 0) + 1);
    } catch (err) {
      // Collected, not thrown: one field an Admin has made required since the
      // config seed ran should not abandon 199 good rows, and the summary
      // below names the problem once instead of 200 times.
      failures.push(readableError(err));
    }
    // A progress line every 25, because a silent two-minute command reads as a
    // hung one.
    if ((i + 1) % 25 === 0) console.log(`  …${i + 1}/${batch.length}`);
  }

  // What the engine actually did, read back rather than assumed — the point of
  // going through `createRecord` is that these numbers are produced by the real
  // machinery, so they are worth printing.
  const ids = (
    await prisma.lead.findMany({ where: { referralCode: DEMO_MARKER }, select: { id: true } })
  ).map((l) => l.id);
  const entityType = await entityTypeOf();
  const [flagged, auditRows, ownerRows] = await Promise.all([
    prisma.duplicateFlag.count({ where: { primaryLeadId: { in: ids }, status: 'PENDING' } }),
    prisma.auditLog.count({ where: { entityType, entityId: { in: ids } } }),
    prisma.user.findMany({ where: { id: { in: [...owners.keys()] } }, select: { id: true, fullName: true } }),
  ]);

  console.log(`\n  leads created      ${created}`);
  if (failures.length > 0) {
    const unique = [...new Set(failures)];
    console.log(`  failed             ${failures.length}`);
    for (const message of unique.slice(0, 5)) console.log(`    · ${message}`);
    if (unique.length > 5) console.log(`    · …and ${unique.length - 5} other reasons`);
  }
  console.log(`  audit rows         ${auditRows} (every lead has a timeline)`);
  console.log(`  duplicates flagged ${flagged} PENDING — the review queue has work in it`);

  console.log('\n  owners, per the assignment engine:');
  const nameById = new Map(ownerRows.map((u) => [u.id, u.fullName]));
  for (const [id, n] of [...owners].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${nameById.get(id) ?? id}`);
  }
  if (owners.size === 1) {
    // Not a failure — the strategy's last tier IS the Admin (invariant 1), and
    // with one user there is nobody else for it to choose. Worth saying,
    // because a demo where every lead has one owner looks like a broken rota.
    console.log(
      '\n  Only one owner: the round-robin falls through to the Admin when there is\n' +
        '  nobody in a language group. Add users under Settings → Roles, wipe and\n' +
        '  re-run to see the rota spread the leads.',
    );
  }

  // A tick over an empty database is the kind of lie that costs an afternoon.
  // Nothing created is a FAILED run and exits non-zero, so a CI step or a
  // shell `&&` chain notices.
  if (created === 0) {
    throw new Error('No leads were created — see the reasons above.');
  }
  console.log(`\n✓ demo data seeded${failures.length > 0 ? ' (with failures — see above)' : ''}\n`);
}

/* ── entry point ──────────────────────────────────────────────────────── */

function parseCount(args: string[]): number {
  const flag = args.find((a) => a.startsWith('--count='));
  if (flag === undefined) return DEFAULT_COUNT;
  const n = Number(flag.slice('--count='.length));
  if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) {
    throw new Error(`--count must be a whole number between 1 and ${MAX_COUNT}`);
  }
  return n;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wiping = args.includes('--wipe');

  console.log(`\n▸ Trade Bazar CRM — demo data (${wiping ? 'wipe' : 'seed'})\n`);
  assertTargetAllowed();

  // `--wipe` deletes and STOPS. Re-seeding as a side effect of a delete would
  // make the destructive command the convenient one, and the two-command reset
  // is short enough that nothing is gained by fusing them.
  if (wiping) {
    await wipe();
    return;
  }
  await seed(parseCount(args));
}

main()
  .catch((e: unknown) => {
    console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
