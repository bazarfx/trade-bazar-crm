/**
 * Layer A on the Next side.
 *
 * THE SPLIT: the sink — `audit`, `auditWithin` and the one `AuditEntry` → row
 * mapping — moved to `@crm/records` so the worker writes the same rows the
 * same way. An imported lead gets its RECORD_CREATED and ASSIGNED entries from
 * the same logger a hand-typed one does, because the import goes THROUGH the
 * engine rather than around it.
 *
 * `requestMeta` stayed because it is genuinely Next-bound: it reads headers
 * off an HTTP `Request`, and a background job has none. Callers that have a
 * request pass the result in as `AuditMeta`; the worker passes nothing, and
 * the entry simply carries no ip or user agent.
 */
import 'server-only';

export { audit, auditWithin } from '@crm/records';

/** Client IP and user agent, for audit entries. */
export function requestMeta(req: Request): { ipAddress: string | null; userAgent: string | null } {
  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? null;
  return { ipAddress, userAgent: req.headers.get('user-agent') };
}
