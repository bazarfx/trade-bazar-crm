/**
 * Layer A — the append-only audit log.
 *
 * This log IS the timeline rendered on every record. Nothing is stored twice,
 * nothing can drift out of sync, nothing can be edited away.
 *
 * Never UPDATE. Never DELETE. There is no code path that should do either.
 */

export type ActorType =
  | 'USER'
  | 'SYSTEM_ARK_WEBHOOK'
  | 'SYSTEM_ROUND_ROBIN'
  | 'SYSTEM_IMPORT'
  | 'SYSTEM_CAMPAIGN_INTAKE';

export type AuditAction =
  | 'RECORD_CREATED' | 'RECORD_UPDATED' | 'RECORD_DELETED' | 'RECORD_RESTORED'
  | 'FIELD_CHANGED' | 'STATUS_CHANGED' | 'ASSIGNED' | 'REASSIGNED'
  | 'OWNERSHIP_TRANSFERRED' | 'DEPOSIT_RECEIVED' | 'CONVERTED'
  | 'NOTE_ADDED' | 'CALL_LOGGED' | 'IMPORTED' | 'WEBHOOK_RECEIVED'
  | 'DUPLICATE_FLAGGED' | 'DUPLICATE_RESOLVED'
  | 'USER_LOGIN' | 'USER_LOGOUT' | 'CONFIG_CHANGED';

export interface FieldDiff { from: unknown; to: unknown }

export interface AuditEntry {
  entityType: string;
  entityId: string;
  action: AuditAction;
  actorType: ActorType;
  actorId?: string | null;
  changes?: Record<string, FieldDiff> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditSink {
  write(entries: AuditEntry[]): Promise<void>;
}

export class AuditLogger {
  constructor(private readonly sink: AuditSink) {}

  log(entry: AuditEntry): Promise<void> {
    return this.sink.write([entry]);
  }

  logMany(entries: AuditEntry[]): Promise<void> {
    return entries.length ? this.sink.write(entries) : Promise.resolve();
  }

  /**
   * Diff two versions of a record and emit one FIELD_CHANGED entry per change.
   * Returns an empty array when nothing changed — do not write a no-op entry.
   */
  diff(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    ignore: Set<string> = new Set(['updatedAt']),
  ): Record<string, FieldDiff> {
    const changes: Record<string, FieldDiff> = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      if (ignore.has(k)) continue;
      const a = before[k];
      const b = after[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) changes[k] = { from: a ?? null, to: b ?? null };
    }
    return changes;
  }
}
