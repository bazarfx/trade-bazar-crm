/**
 * `prisma migrate dev` and `prisma db push` are LOCAL-ONLY commands.
 *
 * `migrate dev` creates and drops a shadow database and will offer to RESET the
 * target when it detects drift. `db push` drops columns to converge on the
 * schema. Either one pointed at Supabase — or later at Vultr — is a data-loss
 * event triggered by a typo in .env.
 *
 * Hosted databases get `npm run db:deploy`, which only applies committed
 * migrations and never resets anything.
 */
const url = process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

let host;
try {
  host = new URL(url).hostname;
} catch {
  console.error(`DATABASE_URL is not a valid URL: ${url}`);
  process.exit(1);
}

const LOCAL = ['localhost', '127.0.0.1', '::1', ''];

if (!LOCAL.includes(host)) {
  console.error(
    `\nRefusing to run: DATABASE_URL points at "${host}".\n\n` +
      `  migrate dev  creates/drops a shadow database and can RESET the target\n` +
      `  db push      drops columns to converge on the schema\n\n` +
      `Neither may touch a hosted database. Use:\n\n` +
      `  npm run db:deploy    apply committed migrations (safe)\n` +
      `  npm run db:status    show applied vs pending (read-only)\n`,
  );
  process.exit(1);
}
