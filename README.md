# Trade Bazar CRM Platform

A configurable CRM platform for a brokerage — lead capture through to funded
trading account. Fields, forms, layouts, statuses, roles, permissions and whole
modules are **data**, created and edited by the Admin from the UI.

**Read [`CLAUDE.md`](./CLAUDE.md) before writing code.** Full spec in
[`docs/CRM-MASTER-SPEC-v3.md`](./docs/CRM-MASTER-SPEC-v3.md).

## Stack

Next.js 15 (self-hosted) · Postgres + Prisma · BullMQ worker · TypeScript strict

Postgres runs on Supabase today (17.6) and moves to self-managed Vultr later.
Local development uses Postgres 15. Nothing depends on a specific major.

## Getting started

Postgres and Redis must be running first:

```bash
createuser crm --createdb --pwprompt   # password: crm
createdb trade_bazar_crm -O crm
brew services start postgresql@15 redis
```

Then:

```bash
cp .env.example .env          # set DATABASE_URL, REDIS_URL and the JWT secrets
npm install
npm run db:migrate
npm run db:seed               # local default: admin@tradebazar.local / ChangeMe123!
npm run dev                   # web      → http://localhost:3000
npm run dev:worker            # background jobs (separate terminal)
```

Against any non-local database the seed **refuses** that default and requires
`SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` (12+ chars). It never rotates an
existing admin's password and never prints one.

### Database commands

| Command | Target | Notes |
|---|---|---|
| `npm run db:migrate` | **local only** | Authors migration SQL. Builds a shadow DB, can offer to RESET |
| `npm run db:push` | **local only** | No migration history; drops columns to converge |
| `npm run db:deploy` | hosted | Applies committed migrations only. Never resets |
| `npm run db:status` | any | Read-only: applied vs pending |

The first two are blocked by `tools/guard-local-db.js` when `DATABASE_URL`
points anywhere but localhost. Hosted setup: [`docs/SUPABASE-MIGRATION.md`](./docs/SUPABASE-MIGRATION.md).

`apps/web/.env` is a symlink to the repo-root `.env` — Next loads env from the
app directory, the worker loads the root file directly.

## Layout

| Path | Purpose |
|---|---|
| `apps/web` | Next.js — UI and route handlers (thin adapters) |
| `apps/worker` | BullMQ — ARK webhook, campaign intake, log batching, imports |
| `packages/core` | The six engines. Framework-agnostic |
| `packages/db` | Prisma schema, client, seed |
| `packages/shared` | Field types, operators, Zod validation — used by web *and* worker |
| `tools/figma` | `.fig` decoder → design tokens |

## Status

| | |
|---|---|
| ✅ | Monorepo, Prisma schema (29 models), shared validation, core engines, seed, tokens |
| ✅ | **Days 1–2** — Next.js + worker shells, JWT auth, login, session rotation, route guard, principal resolution, audit log wired |
| ✅ | Live on **Supabase** (ap-southeast-1, PG 17.6) via a dedicated `crm_app` role — see [`docs/SUPABASE-MIGRATION.md`](./docs/SUPABASE-MIGRATION.md). Vultr is the eventual destination |
| ⬜ | Field builder, layout editor, record engine, permissions UI, Leads, filters, ARK pipeline, Deals |

Build order: `docs/CRM-MASTER-SPEC-v3.md` §16 — 30 working days.

### Auth notes

- Access token (15m) and refresh token (30d) are both httpOnly cookies. The
  refresh cookie is scoped to `/api/auth`.
- Refresh tokens rotate on every use; the presented token is revoked in the
  same request, so a replay fails with 401.
- Role, scope, groups and department are **never** carried in the token — they
  are resolved from the database per request, so revoking a permission takes
  effect on the next request rather than on token expiry.
- `isAdmin` keys off `Role.isLocked`, not the role name. The roles UI must
  never expose that flag for editing.
- Middleware performs a signature check only. Every authorisation decision
  belongs to the permission engine in the repository layer.
