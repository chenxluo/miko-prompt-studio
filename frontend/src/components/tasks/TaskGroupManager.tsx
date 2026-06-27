import { Loader2, X } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '../../i18n';
import type { TaskGroup } from '../../types';

export interface TaskGroupManagerProps {
  groups: TaskGroup[];
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onSave: (payload: {
    group_id?: string;
    name: string;
    description?: string;
    color?: string;
    sort_order?: number;
  }) => void;
  onDelete: (groupId: string) => void;
}

export function TaskGroupManager({
  groups,
  error,
  saving,
  onClose,
  onSave,
  onDelete,
}: TaskGroupManagerProps) {
  const { t } = useI18n();
  const [editingGroup, setEditingGroup] = useState<TaskGroup | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#0ea5e9');
  const [sortOrder, setSortOrder] = useState(0);

  function startNew() {
    setEditingGroup(null);
    setName('');
    setDescription('');
    setColor('#0ea5e9');
    setSortOrder(groups.length);
  }

  function startEdit(group: TaskGroup) {
    setEditingGroup(group);
    setName(group.name);
    setDescription(group.description ?? '');
    setColor(group.color || '#0ea5e9');
    setSortOrder(group.sort_order ?? 0);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({
      group_id: editingGroup?.group_id,
      name: trimmed,
      description: description.trim(),
      color,
      sort_order: sortOrder,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex w-full max-w-md flex-col rounded-lg border border-surface-700 bg-surface-900 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
          <span className="text-sm font-semibold text-ink">{t('task.manageGroups')}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-muted hover:bg-surface-800 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-64 overflow-y-auto p-2">
          {groups.length === 0 ? (
            <div className="py-6 text-center text-xs text-ink-dim">{t('task.noGroups')}</div>
          ) : (
            <ul className="space-y-1">
              {groups.map((group) => (
                <li
                  key={group.group_id}
                  className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-surface-800"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {group.color && (
                      <span
                        className="h-3 w-3 shrink-0 rounded-full"
                        style={{ backgroundColor: group.color }}
                      />
                    )}
                    <span className="truncate text-xs text-ink">{group.name}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(group)}
                      className="rounded p-1 text-xs text-ink-dim hover:bg-surface-700 hover:text-ink"
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(group.group_id)}
                      className="rounded p-1 text-xs text-ink-dim hover:bg-danger/10 hover:text-danger"
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form onSubmit={handleSubmit} className="border-t border-surface-800 p-4">
          <p className="mb-2 text-xs font-medium text-ink-muted">
            {editingGroup ? t('task.editGroup') : t('task.createGroup')}
          </p>
          {error && (
            <div className="mb-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">
              {error}
            </div>
          )}
          <div className="space-y-2">
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('task.groupName')}
              className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
              required
            />
            <input
              type="text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('task.descriptionLabel')}
              className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <label className="text-xs text-ink-dim">{t('task.groupColor')}</label>
              <input
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                className="h-7 w-10 rounded border border-surface-700 bg-transparent"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            {editingGroup && (
              <button
                type="button"
                onClick={startNew}
                className="mr-auto rounded-md px-3 py-2 text-xs text-ink-muted hover:bg-surface-800"
              >
                {t('common.new')}
              </button>
            )}
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="btn-primary px-3 py-2 text-xs disabled:opacity-50"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : t('common.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
