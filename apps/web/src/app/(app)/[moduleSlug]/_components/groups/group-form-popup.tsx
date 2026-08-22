'use client';

import { useId, useMemo, useState } from 'react';
import { api } from '@/lib/client-api';
import { Popup, PopupFooter } from '@/components/ui';
import { fieldMessage, POPUP_INPUT, POPUP_LABEL, PopupTextField } from '../profile-shared';
import type { GroupDto } from './types';

/**
 * New group / Edit group — a 511-wide centred pop-up, the size the file gives
 * every dialog that asks for a name.
 *
 * The language list is NOT an enum and is not hardcoded here: it is whatever
 * the users of this system actually speak (`User.languages`, seed data the
 * Admin edits) plus whatever existing groups already serve, with a free-text
 * "Other…" for the language nobody has been given yet. Hardcoding a list
 * would make "add Tamil" a deploy, which is the one thing this product may
 * never require.
 */

/** The sentinel the select uses for "type one in". Never sent to the server. */
const OTHER = '__other__';

/** `Group.name` is a unique text column; 80 matches the saved-view cap the
 *  rest of the product uses for an Admin-authored name. */
const NAME_MAX = 80;
const LANGUAGE_MAX = 60;

export interface GroupFormPopupProps {
  slug: string;
  /** null → create */
  group: GroupDto | null;
  /** distinct `User.languages` values, from the server page */
  languages: string[];
  /** languages existing groups already serve, so an edited group's own
   *  language is always an option even when nobody speaks it yet */
  groupLanguages: string[];
  onSaved: (group: GroupDto, warning: string | undefined) => void;
  onClose: () => void;
}

export function GroupFormPopup({
  slug,
  group,
  languages,
  groupLanguages,
  onSaved,
  onClose,
}: GroupFormPopupProps) {
  const nameId = useId();
  const languageId = useId();
  const otherId = useId();

  const options = useMemo(() => {
    const set = new Set<string>([...languages, ...groupLanguages]);
    if (group?.language) set.add(group.language);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [languages, groupLanguages, group]);

  const [name, setName] = useState(group?.name ?? '');
  const [choice, setChoice] = useState<string>(group?.language ?? '');
  const [other, setOther] = useState('');
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [languageError, setLanguageError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const language = choice === OTHER ? other.trim() : choice;
  const canSave = trimmedName !== '' && !(choice === OTHER && language === '') && !saving;

  const track = group === null ? `${slug}.groups.create` : `${slug}.groups.edit`;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setNameError(null);
    setLanguageError(null);
    try {
      const body = JSON.stringify({
        name: trimmedName,
        // '' means "no language": such a group is never matched by a lead
        // and is only ever reached as the nominated default pool.
        language: language === '' ? null : language,
      });
      const res =
        group === null
          ? await api<{ group: GroupDto; warning?: string }>('/api/groups', { method: 'POST', body })
          : await api<{ group: GroupDto; warning?: string }>(`/api/groups/${group.id}`, {
              method: 'PATCH',
              body,
            });
      onSaved(res.group, res.warning);
    } catch (err) {
      // The name is the unique column, so a 409 lands on it; anything the
      // server blames on the language lands there instead of on the name.
      const forLanguage = fieldMessage(err, 'language', '');
      if (forLanguage !== '' && forLanguage !== fieldMessage(err, 'name', '')) {
        setLanguageError(forLanguage);
      } else {
        setNameError(fieldMessage(err, 'name', 'Could not save this group.'));
      }
      setSaving(false);
    }
  }

  return (
    <Popup
      open
      width={511}
      title={group === null ? 'New group' : 'Edit group'}
      trackPrefix={track}
      onClose={onClose}
      footer={
        <PopupFooter
          trackPrefix={track}
          cancel={{ label: 'Cancel', onClick: onClose }}
          next={{ label: 'Save', onClick: () => void save(), disabled: !canSave }}
        />
      }
    >
      <PopupTextField
        id={nameId}
        label="Group name"
        value={name}
        onChange={setName}
        maxLength={NAME_MAX}
        autoFocus
        track={`${track}.name`}
        error={nameError}
        onSubmit={() => void save()}
      />

      <div>
        <label htmlFor={languageId} className={POPUP_LABEL}>
          Language
        </label>
        {/* A styled NATIVE select, like every picklist in this product — the
            list is Admin data and can grow without limit. */}
        <select
          id={languageId}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          data-track={`${track}.language`}
          className={POPUP_INPUT}
        >
          <option value="">No language — reachable only as the default pool</option>
          {options.map((lang) => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </select>
        {choice === OTHER ? (
          <div className="mt-2">
            <label htmlFor={otherId} className="sr-only">
              Language name
            </label>
            <input
              id={otherId}
              type="text"
              value={other}
              maxLength={LANGUAGE_MAX}
              autoFocus
              placeholder="Type the language"
              onChange={(e) => setOther(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                void save();
              }}
              data-track={`${track}.language.other`}
              className={POPUP_INPUT}
            />
          </div>
        ) : null}
        {languageError !== null ? (
          <p role="alert" className="mt-1 text-xs text-error">
            {languageError}
          </p>
        ) : (
          <p className="mt-1 text-xs text-body">
            Campaign leads in this language round-robin across the group&rsquo;s active members.
          </p>
        )}
      </div>
    </Popup>
  );
}
