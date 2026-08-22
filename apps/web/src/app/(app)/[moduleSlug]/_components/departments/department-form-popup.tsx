'use client';

import { useId, useState } from 'react';
import { api } from '@/lib/client-api';
import { Popup, PopupFooter } from '@/components/ui';
import { fieldMessage, PopupTextField } from '../profile-shared';
import type { DepartmentDto } from './types';

/**
 * New department / Rename department — the 511 pop-up the file gives every
 * dialog that asks for one name. A department IS one name: spec §5.2 makes it
 * a view-scope boundary and a filter, nothing more, so there is nothing else
 * to ask for.
 */

/** `Department.name` is a unique text column; 80 matches the product's cap
 *  for an Admin-authored name. */
const NAME_MAX = 80;

export interface DepartmentFormPopupProps {
  slug: string;
  /** null → create */
  department: DepartmentDto | null;
  onSaved: (department: DepartmentDto) => void;
  onClose: () => void;
}

export function DepartmentFormPopup({ slug, department, onSaved, onClose }: DepartmentFormPopupProps) {
  const nameId = useId();
  const [name, setName] = useState(department?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const canSave = trimmed !== '' && !saving;
  const track = department === null ? `${slug}.departments.create` : `${slug}.departments.edit`;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({ name: trimmed });
      const res =
        department === null
          ? await api<{ department: DepartmentDto }>('/api/departments', { method: 'POST', body })
          : await api<{ department: DepartmentDto }>(`/api/departments/${department.id}`, {
              method: 'PATCH',
              body,
            });
      onSaved(res.department);
    } catch (err) {
      setError(fieldMessage(err, 'name', 'Could not save this department.'));
      setSaving(false);
    }
  }

  return (
    <Popup
      open
      width={511}
      title={department === null ? 'New department' : 'Rename department'}
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
        label="Department name"
        value={name}
        onChange={setName}
        maxLength={NAME_MAX}
        autoFocus
        track={`${track}.name`}
        error={error}
        onSubmit={() => void save()}
      />
    </Popup>
  );
}
