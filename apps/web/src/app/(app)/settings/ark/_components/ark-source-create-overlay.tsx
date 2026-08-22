'use client';

import { useState } from 'react';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button, FieldError, FieldLabel, Input } from '@/components/ui';
import { api } from '@/lib/client-api';
import { CopyField } from '@/app/(app)/settings/intake/_components/copy-field';

/**
 * Create one ARK source: the URL ARK Terminal will post account events to.
 *
 * No module picker, unlike a campaign source: an ARK event is not "a record
 * in a module", it is matched against deals first and leads second and acts
 * on whichever it finds (spec §7). The target is the conversion pipeline,
 * resolved from the storage shapes server-side — there is nothing to choose.
 *
 * The token is generated server-side and stored as a hash, so the success
 * state lives INSIDE this overlay: closing it is the user asserting they
 * have the URL, and there is no second chance to show it.
 */

export interface CreatedArkSource {
  name: string;
  intakeUrl: string;
}

export interface ArkSourceCreateOverlayProps {
  onCreated: (created: CreatedArkSource) => void;
  onClose: () => void;
}

export function ArkSourceCreateOverlay({ onCreated, onClose }: ArkSourceCreateOverlayProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedArkSource | null>(null);

  function submit() {
    if (name.trim() === '') {
      setError('Name the source — “ARK Terminal production”, say.');
      return;
    }
    setBusy(true);
    setError(null);
    // `ArkSourceCreatedDto` — `receiverUrl` is the one copy of the full URL.
    api<{ source: { name: string }; receiverUrl: string }>('/api/ark-sources', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() }),
    })
      .then((res) => {
        setBusy(false);
        setResult({ name: res.source.name, intakeUrl: res.receiverUrl });
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : 'The source could not be created.');
      });
  }

  /** Closing after a create still hands the URL up — the manager keeps it on
   *  screen until dismissed, so an accidental Escape here does not destroy
   *  the only copy. */
  function finish() {
    if (result !== null) onCreated(result);
    else onClose();
  }

  return (
    <FullScreenOverlay title="New ARK source" onClose={finish} trackPrefix="settings.ark.create">
      <div className="mx-auto max-w-2xl px-8 py-8">
        {result === null ? (
          <>
            <p className="text-sm text-body">
              A source is one webhook URL ARK Terminal posts account events into — every account
              created, every deposit. One is enough; a second exists for a staging terminal or a
              migration, each with its own mapping and its own event log.
            </p>

            <FieldLabel htmlFor="ark-source-name" className="mt-6" required>
              Name
            </FieldLabel>
            <Input
              id="ark-source-name"
              value={name}
              autoFocus
              maxLength={100}
              placeholder="ARK Terminal production"
              onChange={(e) => setName(e.target.value)}
              data-track="settings.ark.create.name.input"
            />

            <FieldError>{error}</FieldError>

            <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
              <Button loading={busy} onClick={submit} data-track="settings.ark.source.create">
                Create source
              </Button>
              <Button variant="secondary" onClick={onClose} data-track="settings.ark.create.cancel">
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-heading">“{result.name}” is ready.</p>
            <p className="mt-2 text-sm text-body">
              This is the webhook URL — and the ONLY time the server can show it, because it
              stores just a hash of the token inside it. Copy it now and hand it to ARK as the
              account-event destination. Lose it and you create a new source, not recover this one.
            </p>
            <div className="mt-4">
              <CopyField value={result.intakeUrl} track="settings.ark.source.url.copy" />
            </div>
            <p className="mt-4 text-sm text-body">
              ARK is not connected yet. The first real account event will land in this
              source&apos;s Events list as FAILED — open it, read its shape, map it, replay it.
            </p>
            <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
              <Button onClick={finish} data-track="settings.ark.create.done">
                Done
              </Button>
            </div>
          </>
        )}
      </div>
    </FullScreenOverlay>
  );
}
