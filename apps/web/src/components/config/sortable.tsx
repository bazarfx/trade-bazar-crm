'use client';

import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, cn } from '@/components/ui';

/**
 * The one drag-to-reorder primitive, shared by the field, status and layout
 * builders. It knows nothing about what it sorts — items are opaque, ids come
 * from `getId`, rows come from `renderItem`. Keyboard reordering (Space to
 * lift, arrows to move, Space to drop) comes from the KeyboardSensor, so
 * every builder is keyboard-operable for free.
 */
interface SortableListProps<T> {
  items: T[];
  /** Receives the full array in its new order — persist `displayOrder` from it. */
  onReorder: (items: T[]) => void;
  renderItem: (item: T, index: number) => React.ReactNode;
  getId: (item: T) => string;
  direction?: 'vertical' | 'horizontal';
}

export function SortableList<T>({
  items,
  onReorder,
  renderItem,
  getId,
  direction = 'vertical',
}: SortableListProps<T>) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    // A small activation distance keeps plain clicks (open, edit, delete)
    // from being swallowed as zero-pixel drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = items.map(getId);
  const activeIndex = activeId === null ? -1 : ids.indexOf(activeId);
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(items, from, to));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext
        items={ids}
        strategy={direction === 'horizontal' ? horizontalListSortingStrategy : verticalListSortingStrategy}
      >
        {items.map((item, index) => renderItem(item, index))}
      </SortableContext>
      {/* The overlay is what follows the pointer; the row itself stays in
          place as a dimmed placeholder (see SortableRow's isDragging). */}
      <DragOverlay>
        {activeItem !== undefined ? renderItem(activeItem, activeIndex) : null}
      </DragOverlay>
    </DndContext>
  );
}

interface SortableRowProps {
  id: string;
  /** data-track for the grip handle, e.g. `${slug}.fields.row.reorder`. */
  dataTrack: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * A sortable row whose drag affordance is an explicit grip handle — listeners
 * go on the handle, not the row, so buttons and inputs inside the row keep
 * working normally.
 */
export function SortableRow({ id, dataTrack, className, children }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex items-center gap-2', isDragging && 'opacity-50', className)}
    >
      {/* Ghost button, narrowed to the glyph: the handle must not read as an
          action button beside the row's real actions. `attributes`/`listeners`
          land in Button's rest spread, so dnd-kit still owns the element. */}
      <Button
        variant="ghost"
        size="sm"
        aria-label="Reorder"
        data-track={dataTrack}
        className="w-6 cursor-grab px-0 hover:text-heading active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <span aria-hidden="true">⠿</span>
      </Button>
      {children}
    </div>
  );
}
