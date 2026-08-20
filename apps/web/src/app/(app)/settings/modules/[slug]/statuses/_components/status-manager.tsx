'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StatusCreateInput } from '@crm/shared';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { SortableList, SortableRow } from '@/components/config/sortable';
import { Button, Chip, FieldLabel, Panel, Select } from '@/components/ui';
import { api, ApiClientError } from '@/lib/client-api';
import type { StatusDto } from '@/lib/config/statuses';
import { StatusForm } from './status-form';
import { ColorDot, TagChip } from './status-meta';

/**
 * The status manager for one module — which module is pure data (`slug`), so
 * this single component serves every pipeline the Admin ever creates.
 *
 * Wire shapes come straight from the routes: GET and reorder answer with the
 * status array, POST/PATCH/DELETE with the affected status. Failures arrive
 * as the uniform ApiError; guardrail refusals (422 GUARDRAIL) are surfaced
 * verbatim because the reason string is authored next to the rule it
 * enforces, in @crm/core.
 */

type Overlay =
  | { kind: 'create' }
  | { kind: 'edit'; status: StatusDto }
  /** `reason` is the server's 409 message — it carries the in-use count. */
  | { kind: 'delete'; status: StatusDto; reason: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function StatusManager({ slug }: { slug: string }) {
  const [statuses, setStatuses] = useState<StatusDto[] | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatuses((await api<{ statuses: StatusDto[] }>(`/api/modules/${slug}/statuses`)).statuses);
    } catch (err) {
      setBanner(messageOf(err));
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Optimistic reorder: paint the new order immediately, roll back on failure. */
  function handleReorder(next: StatusDto[]) {
    const prev = statuses;
    setStatuses(next);
    api<{ statuses: StatusDto[] }>(`/api/modules/${slug}/statuses/reorder`, {
      method: 'POST',
      body: JSON.stringify({ orderedIds: next.map((s) => s.id) }),
    })
      // Adopt the server-confirmed order — displayOrder was recomputed there.
      .then((res) => setStatuses(res.statuses))
      .catch((err) => {
        setStatuses(prev);
        setBanner(messageOf(err));
      });
  }

  async function handleCreate(input: StatusCreateInput) {
    await api<{ status: StatusDto }>(`/api/modules/${slug}/statuses`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    setOverlay(null);
    await refresh();
  }

  async function handleEdit(statusId: string, input: StatusCreateInput) {
    await api<{ status: StatusDto }>(`/api/modules/${slug}/statuses/${statusId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    setOverlay(null);
    await refresh();
  }

  /** The DELETE call itself; shared by the row button and the confirm step. */
  async function attemptDelete(status: StatusDto, replacementStatusId?: string) {
    await api<{ status: StatusDto }>(`/api/modules/${slug}/statuses/${status.id}`, {
      method: 'DELETE',
      body: JSON.stringify(replacementStatusId ? { replacementStatusId } : {}),
    });
    setOverlay(null);
    await refresh();
  }

  /**
   * Delete is a conversation with the server: try without a replacement
   * first, and only when the 409 comes back (status in use) open the
   * replacement picker. A 422 is a guardrail — the last live carrier of a
   * system tag — so there is nothing to pick, only a reason to show.
   */
  function handleRowDelete(status: StatusDto) {
    setBanner(null);
    attemptDelete(status).catch((err) => {
      if (err instanceof ApiClientError && err.status === 409 && err.code === 'CONFLICT') {
        setOverlay({ kind: 'delete', status, reason: err.message });
      } else {
        setBanner(messageOf(err));
      }
    });
  }

  return (
    <div>
      {banner !== null && (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between gap-4 rounded border border-error bg-surface px-4 py-3 text-sm text-error"
        >
          <span>{banner}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setBanner(null)}
            data-track={`${slug}.statuses.banner.dismiss`}
            className="text-error hover:bg-error/10"
          >
            Dismiss
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-body">
          {statuses === null
            ? 'Loading…'
            : `${statuses.length} active status${statuses.length === 1 ? '' : 'es'}`}
        </p>
        <Button
          onClick={() => setOverlay({ kind: 'create' })}
          data-track={`${slug}.statuses.create.open`}
        >
          New status
        </Button>
      </div>

      <Panel className="mt-4">
        {statuses === null ? (
          <p className="px-4 py-6 text-sm text-body">Loading statuses…</p>
        ) : statuses.length === 0 ? (
          <p className="px-4 py-6 text-sm text-body">No statuses yet — create the first one.</p>
        ) : (
          <SortableList
            items={statuses}
            getId={(s) => s.id}
            onReorder={handleReorder}
            renderItem={(s) => (
              <SortableRow
                key={s.id}
                id={s.id}
                dataTrack={`${slug}.statuses.row.reorder`}
                className="border-b border-border px-3 py-2 last:border-0"
              >
                <Button
                  variant="ghost"
                  onClick={() => setOverlay({ kind: 'edit', status: s })}
                  data-track={`${slug}.statuses.row.open`}
                  className="min-w-0 flex-1 justify-start gap-3 px-0 text-left font-normal"
                >
                  <ColorDot color={s.color} />
                  <span className="truncate text-sm text-heading" title={s.name}>
                    {s.name}
                  </span>
                  <TagChip tag={s.tag} />
                  {s.isSystem && <Chip>System</Chip>}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRowDelete(s)}
                  data-track={`${slug}.statuses.row.delete`}
                  className="hover:text-error"
                >
                  Delete
                </Button>
              </SortableRow>
            )}
          />
        )}
      </Panel>

      {overlay?.kind === 'create' && (
        <FullScreenOverlay
          title="New status"
          onClose={() => setOverlay(null)}
          trackPrefix={`${slug}.statuses`}
        >
          <StatusForm
            slug={slug}
            mode="create"
            initial={null}
            onSave={handleCreate}
            onCancel={() => setOverlay(null)}
          />
        </FullScreenOverlay>
      )}

      {overlay?.kind === 'edit' && (
        <FullScreenOverlay
          title={`Edit "${overlay.status.name}"`}
          onClose={() => setOverlay(null)}
          trackPrefix={`${slug}.statuses`}
        >
          <StatusForm
            slug={slug}
            mode="edit"
            initial={overlay.status}
            onSave={(input) => handleEdit(overlay.status.id, input)}
            onCancel={() => setOverlay(null)}
          />
        </FullScreenOverlay>
      )}

      {overlay?.kind === 'delete' && statuses !== null && (
        <DeleteOverlay
          slug={slug}
          status={overlay.status}
          reason={overlay.reason}
          others={statuses.filter((s) => s.id !== overlay.status.id)}
          onConfirm={(replacementStatusId) => attemptDelete(overlay.status, replacementStatusId)}
          onClose={() => setOverlay(null)}
        />
      )}
    </div>
  );
}

/**
 * The replacement picker, reached only via the server's 409 — the count in
 * `reason` is the server's own tally across every table that carries a
 * statusId, so the UI never recomputes it.
 */
function DeleteOverlay({
  slug,
  status,
  reason,
  others,
  onConfirm,
  onClose,
}: {
  slug: string;
  status: StatusDto;
  reason: string;
  others: StatusDto[];
  onConfirm: (replacementStatusId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [replacementId, setReplacementId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setBusy(true);
    setError(null);
    onConfirm(replacementId).catch((err) => {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setBusy(false);
    });
  }

  return (
    <FullScreenOverlay
      title={`Delete "${status.name}"`}
      onClose={onClose}
      trackPrefix={`${slug}.statuses`}
    >
      <div className="mx-auto max-w-2xl px-8 py-8">
        <p className="text-sm text-heading">{reason}</p>
        <p className="mt-2 text-sm text-body">
          The status is soft-deleted and history stays readable — every moved record&apos;s
          timeline shows the change. Pick the status those records should carry instead.
        </p>

        {error !== null && (
          <div
            role="alert"
            className="mt-4 rounded border border-error bg-surface px-4 py-3 text-sm text-error"
          >
            {error}
          </div>
        )}

        <FieldLabel htmlFor="replacement-status" className="mt-6" required>
          Replacement status
        </FieldLabel>
        <Select
          id="replacement-status"
          value={replacementId}
          onChange={(e) => setReplacementId(e.target.value)}
          data-track={`${slug}.statuses.delete.replacement.select`}
        >
          <option value="">Choose a replacement…</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.tag})
            </option>
          ))}
        </Select>

        <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
          {/* Solid error fill, not the outlined destructive variant: this is
              the confirm step of a delete the server already refused once. */}
          <Button
            disabled={replacementId === ''}
            loading={busy}
            onClick={confirm}
            data-track={`${slug}.statuses.delete.confirm`}
            className="border border-error bg-error text-surface hover:bg-error/90"
          >
            {busy ? 'Deleting…' : 'Delete and reassign'}
          </Button>
          <Button
            variant="secondary"
            onClick={onClose}
            data-track={`${slug}.statuses.delete.cancel`}
          >
            Cancel
          </Button>
        </div>
      </div>
    </FullScreenOverlay>
  );
}
