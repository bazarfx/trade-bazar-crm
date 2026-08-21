/**
 * `@crm/records` — the record engine, runtime-agnostic.
 *
 * WHY THIS PACKAGE EXISTS. CLAUDE.md: "Background work never runs in a route
 * handler", and names a multi-megabyte import as the example. But every file
 * in here used to live under `apps/web/src/lib` behind `import 'server-only'`,
 * a package that THROWS the moment it is imported outside a Next server
 * bundle — so the worker could not create a record, and an import job would
 * have had to reimplement the write path. A second write path is how the five
 * invariants get broken quietly: an imported lead that skips `assignOwner` is
 * unassigned, one that skips `auditWithin` has no timeline, one that skips
 * `buildRecordSchema` accepts what the form rejects.
 *
 * The coupling turned out to be shallow. The only Next-specific dependency in
 * the whole write path was a TYPE-ONLY import of `Principal`, which now lives
 * in `./principal.js`. Nothing else in these files knows what a request is.
 *
 * WHAT STAYED IN `apps/web`, because it genuinely is Next-bound:
 *   - `requestMeta(req)` — reads ip and user agent off an HTTP `Request`. The
 *     worker has none, so those arrive as an optional `AuditMeta` argument.
 *   - `cookies()`, `getPrincipal()`, route handlers, everything under `app/`.
 *
 * `loadPrincipal(userId)` came with the shape rather than staying behind: the
 * import worker has to run AS the user who uploaded the file, and building a
 * Principal is the only way it can. See `./principal.ts`.
 *
 * The old paths under `apps/web/src/lib` are now one-line shims that keep
 * `import 'server-only'` in place. That guard still matters on the Next side —
 * none of this may reach a client bundle — but it is a property of the
 * IMPORTER, not of the engine, which is why it lives there and not here.
 */
export * from './principal.js';

export * from './audit.js';

export * from './config/service.js';
export * from './config/settings.js';
export * from './config/access.js';

export * from './assignment/index.js';
export * from './assignment/ports.js';

export * from './records/serialise.js';
export * from './records/list.js';
export * from './records/service.js';
