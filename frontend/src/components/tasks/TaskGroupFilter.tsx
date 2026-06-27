import type { TaskGroup } from '../../types';

export interface TaskGroupFilterProps {
  groups: TaskGroup[];
  selectedGroupId: string | null | 'ungrouped';
  onSelect: (groupId: string | null | 'ungrouped') => void;
  allLabel: string;
  ungroupedLabel: string;
}

export function TaskGroupFilter({
  groups,
  selectedGroupId,
  onSelect,
  allLabel,
  ungroupedLabel,
}: TaskGroupFilterProps) {
  return (
    <div className="flex items-center gap-2 border-b border-surface-800 px-6 py-2">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`rounded px-2.5 py-1.5 text-xs transition-colors ${
          selectedGroupId === null
            ? 'bg-accent/10 text-accent'
            : 'text-ink-muted hover:bg-surface-800 hover:text-ink'
        }`}
      >
        {allLabel}
      </button>
      <button
        type="button"
        onClick={() => onSelect('ungrouped')}
        className={`rounded px-2.5 py-1.5 text-xs transition-colors ${
          selectedGroupId === 'ungrouped'
            ? 'bg-accent/10 text-accent'
            : 'text-ink-muted hover:bg-surface-800 hover:text-ink'
        }`}
      >
        {ungroupedLabel}
      </button>
      {groups.map((group) => (
        <button
          key={group.group_id}
          type="button"
          onClick={() => onSelect(group.group_id)}
          className={`inline-flex max-w-[12rem] items-center gap-1.5 truncate rounded px-2.5 py-1.5 text-xs transition-colors ${
            selectedGroupId === group.group_id
              ? 'bg-accent/10 text-accent'
              : 'text-ink-muted hover:bg-surface-800 hover:text-ink'
          }`}
          title={group.name}
        >
          {group.color && (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: group.color }}
            />
          )}
          <span className="truncate">{group.name}</span>
        </button>
      ))}
    </div>
  );
}
