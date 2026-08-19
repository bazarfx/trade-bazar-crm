/**
 * Seed — spec v3.0.
 *
 * Idempotent: safe to re-run. Uses upsert throughout so a second run never
 * duplicates and never clobbers Admin edits made through the UI.
 *
 * Run: npm run db:seed
 */

import { PrismaClient, type FieldType, type StatusTag } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  MODULES, LEAD_FIELDS, USER_FIELDS, DEAL_FIELDS, LEAD_SECTIONS,
  LEAD_STATUSES, DEAL_STATUSES, LANGUAGES, DEPARTMENTS, SUGGESTED_ROLES,
} from './seed-data.js';

/**
 * Guard on the CONNECTION TARGET, never on NODE_ENV — NODE_ENV is
 * "development" in exactly the accident this defends against: a .env still
 * pointing at Supabase while someone runs a routine local seed.
 */
const dbUrl = process.env['DIRECT_URL'] ?? process.env['DATABASE_URL'] ?? '';
const isLocalDb = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(dbUrl);

if (!isLocalDb) {
  const supplied = process.env['SEED_ADMIN_PASSWORD'] || '';
  if (!supplied) {
    throw new Error(
      'Refusing to seed a non-local database with the default admin password.\n' +
        'Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD.',
    );
  }
  if (supplied.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
  }
}

const prisma = new PrismaClient({ datasourceUrl: dbUrl });

const SPECIALS = [
  'REASSIGN_LEADS', 'TRANSFER_DEAL_OWNERSHIP', 'MANAGE_FIELDS_LAYOUTS',
  'MANAGE_STATUSES', 'MANAGE_USERS_ROLES', 'MANAGE_DEPARTMENTS_GROUPS',
  'MANAGE_CAMPAIGNS', 'IMPORT_EXPORT', 'BULK_OPERATIONS', 'VIEW_AUDIT_LOGS',
] as const;

async function main() {
  console.log('▸ seeding Trade Bazar CRM\n');

  // ── modules ──────────────────────────────────────────────────────
  const modules = new Map<string, string>();
  for (const m of MODULES) {
    const row = await prisma.moduleDefinition.upsert({
      where: { slug: m.slug },
      update: {},
      create: {
        slug: m.slug, label: m.label, labelPlural: m.labelPlural,
        isCore: m.isCore, isSystem: m.isSystem, navOrder: m.navOrder,
        recordTitleField: m.recordTitleField, icon: m.icon,
      },
    });
    modules.set(m.slug, row.id);
  }
  console.log(`  modules            ${modules.size}`);

  // ── Admin role — every permission, LOCKED ────────────────────────
  const admin = await prisma.role.upsert({
    where: { name: 'Admin' },
    update: { isLocked: true },
    create: { name: 'Admin', isLocked: true },
  });

  for (const [slug, moduleId] of modules) {
    await prisma.rolePermission.upsert({
      where: { roleId_moduleId: { roleId: admin.id, moduleId } },
      update: {},
      create: { roleId: admin.id, moduleId, viewScope: 'ALL', canCreate: true, canEdit: true, canDelete: true },
    });
    void slug;
  }
  for (const permission of SPECIALS) {
    await prisma.roleSpecialPermission.upsert({
      where: { roleId_permission: { roleId: admin.id, permission } },
      update: {},
      create: { roleId: admin.id, permission },
    });
  }
  console.log('  Admin role         locked, all permissions');

  // ── suggested roles (Admin-editable, NOT locked) ─────────────────
  for (const name of SUGGESTED_ROLES) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name, isLocked: false } });
  }
  console.log(`  suggested roles    ${SUGGESTED_ROLES.length}`);

  // ── departments & language groups ────────────────────────────────
  for (const name of DEPARTMENTS) {
    await prisma.department.upsert({ where: { name }, update: {}, create: { name } });
  }
  for (const language of LANGUAGES) {
    await prisma.group.upsert({
      where: { name: `${language} Team` },
      update: {},
      create: { name: `${language} Team`, language },
    });
  }
  console.log(`  departments        ${DEPARTMENTS.length}`);
  console.log(`  language groups    ${LANGUAGES.length}`);

  // ── statuses ─────────────────────────────────────────────────────
  const leadModuleId = modules.get('leads')!;
  const dealModuleId = modules.get('deals')!;

  for (const [i, s] of LEAD_STATUSES.entries()) {
    await prisma.status.upsert({
      where: { moduleId_name: { moduleId: leadModuleId, name: s.name } },
      update: {},
      create: {
        moduleId: leadModuleId, name: s.name, tag: s.tag as StatusTag,
        color: s.color, displayOrder: i, isSystem: s.isSystem,
      },
    });
  }
  for (const [i, s] of DEAL_STATUSES.entries()) {
    await prisma.status.upsert({
      where: { moduleId_name: { moduleId: dealModuleId, name: s.name } },
      update: {},
      create: {
        moduleId: dealModuleId, name: s.name, tag: s.tag as StatusTag,
        color: s.color, displayOrder: i, isSystem: s.isSystem,
      },
    });
  }
  console.log(`  lead statuses      ${LEAD_STATUSES.length}`);
  console.log(`  deal statuses      ${DEAL_STATUSES.length}`);

  // ── sections + fields ────────────────────────────────────────────
  async function seedFields(slug: string, fields: typeof LEAD_FIELDS, sections: readonly string[]) {
    const moduleId = modules.get(slug)!;
    const sectionIds = new Map<string, string>();

    for (const [i, label] of sections.entries()) {
      const existing = await prisma.formSection.findFirst({ where: { moduleId, label } });
      const row = existing ?? (await prisma.formSection.create({
        data: { moduleId, label, displayOrder: i, columns: 3 },
      }));
      sectionIds.set(label, row.id);
    }

    for (const [i, f] of fields.entries()) {
      const field = await prisma.fieldDefinition.upsert({
        where: { moduleId_key: { moduleId, key: f.key } },
        update: {},
        create: {
          moduleId, key: f.key, label: f.label, type: f.type as FieldType,
          systemColumn: f.systemColumn ?? null,
          isSystem: f.isSystem ?? false,
          isRequired: f.isRequired ?? false,
          isUnique: f.isUnique ?? false,
          isIndexed: f.isIndexed ?? false,
          sectionId: sectionIds.get(f.section) ?? null,
          displayOrder: i,
        },
      });

      if (f.options) {
        for (const [j, label] of f.options.entries()) {
          await prisma.picklistOption.upsert({
            where: { fieldDefinitionId_value: { fieldDefinitionId: field.id, value: label } },
            update: {},
            create: { fieldDefinitionId: field.id, label, value: label, displayOrder: j },
          });
        }
      }
    }
    console.log(`  ${slug.padEnd(18)} ${fields.length} fields`);
  }

  await seedFields('leads', LEAD_FIELDS, LEAD_SECTIONS);
  await seedFields('users', USER_FIELDS, ['User Information']);
  await seedFields('deals', DEAL_FIELDS, ['Deal Information']);

  // ── first Admin user ─────────────────────────────────────────────
  // `??` would let an empty string through — .env.example ships these blank.
  const email = process.env['SEED_ADMIN_EMAIL'] || 'admin@tradebazar.local';
  const password = process.env['SEED_ADMIN_PASSWORD'] || 'ChangeMe123!';

  const existingAdmin = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      fullName: 'System Administrator',
      email,
      passwordHash: await bcrypt.hash(password, 12),
      roleId: admin.id,
      languages: [...LANGUAGES],
      isActive: true,
    },
  });

  console.log(`\n  admin login        ${email}`);
  console.log(
    existingAdmin
      ? '  admin password     unchanged — this seed never rotates an existing password'
      : '  admin password     set from SEED_ADMIN_PASSWORD (not printed)',
  );
  console.log('\n✓ seed complete\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
