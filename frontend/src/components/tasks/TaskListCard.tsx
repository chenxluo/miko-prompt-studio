import { BookOpen, Loader2, Tag, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '../../i18n';
import type { Task, TaskGroup } from '../../types';

export interface TaskListCardProps {
  task: Task;
  groups: TaskGroup[];
  providerNames: Map<string, string>;
  isDeleting: boolean;
  onClick: () => void;
  onDelete: () => void;
  onLoad: () => void;
  onMoveGroup: (groupId: string | null) => void;
}

export function TaskListCard({
  task,
  groups,
  providerNames,
  isDeleting,
  onClick,
  onDelete,
  onLoad,
  onMoveGroup,
}: TaskListCardProps) {
  const { t } = useI18n();
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const version = task.current_version;
  const providerName = version?.provider_config_id
    ? providerNames.get(version.provider_config_id) ?? version.provider_config_id
    : task.provider_config_id
      ? providerNames.get(task.provider_config_id) ?? task.provider_config_id
      : '—';
  const modelId = version?.model_id ?? task.model_id ?? '—';
  const versionLabel = version?.version_label ?? '—';
  const currentGroup = groups.find((g) => g.group_id === task.group_id);
  const updatedAtText = task.updated_at ? new Date(task.updated_at).toLocaleString() : '—';

  return (
    <article
      className="panel cursor-pointer p-4 transition-colors hover:border-surface-600"
      onClick={onClick}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BookOpen size={14} className="text-accent" />
            <h2 className="truncate text-sm font-semibold text-ink">{task.name}</h2>
            {versionLabel && versionLabel !== '—' && (
              <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-ink-muted">
                {versionLabel}
              </span>
            )}
            {currentGroup && (
              <span
                className="inline-flex max-w-[8rem] items-center gap-1 truncate rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-ink-muted"
                title={currentGroup.name}
              >
                {currentGroup.color && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: currentGroup.color }}
                  />
                )}
                <span className="truncate">{currentGroup.name}</span>
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-dim">
            <span>
              {t('task.model')}: {modelId}
            </span>
            <span>
              {t('task.providerConfig')}: {providerName}
            </span>
            <span>
              {t('task.updatedAt')}: {updatedAtText}
            </span>
          </div>
          {task.description && (
            <p className="mt-2 line-clamp-2 text-xs text-ink-muted">{task.description}</p>
          )}
        </div>

        <div className="flex shrink-0 gap-2" onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={onLoad} className="btn-primary px-3 py-2 text-xs">
            <Upload size={14} />
            {t('task.load')}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowMoveMenu((prev) => !prev)}
              className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:bg-surface-800 hover:text-ink"
            >
              <Tag size={12} />
              {t('task.moveToGroup')}
            </button>
            {showMoveMenu && (
              <div className="absolute right-0 top-full z-10 mt-1 w-40 rounded-md border border-surface-700 bg-surface-900 py-1 shadow-xl">
                <button
                  type="button"
                  onClick={() => {
                    onMoveGroup(null);
                    setShowMoveMenu(false);
                  }}
                  className={`w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-surface-800 ${
                    !task.group_id ? 'text-accent' : 'text-ink-muted'
                  }`}
                >
                  {t('task.noGroup')}
                </button>
                {groups.map((group) => (
                  <button
                    key={group.group_id}
                    type="button"
                    onClick={() => {
                      onMoveGroup(group.group_id);
                      setShowMoveMenu(false);
                    }}
                    className={`w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-surface-800 ${
                      task.group_id === group.group_id ? 'text-accent' : 'text-ink-muted'
                    }`}
                  >
                    <span className="truncate">{group.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-danger/50 hover:text-danger disabled:opacity-50"
          >
            {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            {t('task.delete')}
          </button>
        </div>
      </div>
    </article>
  );
}
