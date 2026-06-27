import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { I18n } from '../../i18n';
import type { RunListItem } from '../../api/client';
export interface RunSelectorProps {
  runs: RunListItem[];
  selectedRunId: string | null;
  onSelect: (runId: string | null) => void;
  disabled?: boolean;
  t: I18n['t'];
}

type RunTypeFilter = 'all' | 'lab' | 'batch' | 'compare';
type SortBy = 'newest' | 'oldest' | 'name';

const RUN_TYPE_OPTIONS: RunTypeFilter[] = ['all', 'lab', 'batch', 'compare'];
const SORT_OPTIONS: SortBy[] = ['newest', 'oldest', 'name'];

function formatRunLabel(run: RunListItem, t: I18n['t']): string {
  const summary = run.summary ?? {};
  const total = typeof summary.total_items === 'number' ? summary.total_items : 0;
  const date = run.created_at ? new Date(run.created_at).toLocaleString() : '';
  const name = run.name || run.run_id;
  return `${name} · ${run.run_type} · ${total} ${t('results.total').toLowerCase()} · ${date}`;
}

function runTypeBadgeClass(runType: string): string {
  switch (runType) {
    case 'lab':
      return 'bg-accent/10 text-accent';
    case 'batch':
      return 'bg-emerald-500/10 text-emerald-400';
    case 'compare':
      return 'bg-amber-500/10 text-amber-400';
    default:
      return 'bg-surface-800 text-ink-muted';
  }
}

export function RunSelector({ runs, selectedRunId, onSelect, disabled, t }: RunSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [runType, setRunType] = useState<RunTypeFilter>('all');
  const [sortBy, setSortBy] = useState<SortBy>('newest');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selectedRun = useMemo(
    () => runs.find((run) => run.run_id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const filteredRuns = useMemo(() => {
    const q = query.trim().toLowerCase();
    let result = runs;
    if (runType !== 'all') {
      result = result.filter((run) => run.run_type === runType);
    }
    if (q) {
      result = result.filter(
        (run) =>
          run.name.toLowerCase().includes(q) ||
          run.run_id.toLowerCase().includes(q) ||
          run.run_type.toLowerCase().includes(q),
      );
    }
    result = [...result].sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case 'oldest':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'name':
          return (a.name || a.run_id).localeCompare(b.name || b.run_id);
        default:
          return 0;
      }
    });
    return result;
  }, [runs, runType, query, sortBy]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [filteredRuns.length, runType, query, sortBy]);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex((prev) => (prev + 1) % filteredRuns.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex((prev) => (prev - 1 + filteredRuns.length) % filteredRuns.length);
      } else if (event.key === 'Enter' && filteredRuns.length > 0) {
        event.preventDefault();
        const run = filteredRuns[highlightedIndex];
        if (run) {
          onSelect(run.run_id);
          setOpen(false);
          setQuery('');
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, filteredRuns, highlightedIndex, onSelect]);

  useEffect(() => {
    const el = itemRefs.current[highlightedIndex];
    if (el && listRef.current) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex]);

  const handleSelect = useCallback(
    (run: RunListItem) => {
      onSelect(run.run_id);
      setOpen(false);
      setQuery('');
    },
    [onSelect],
  );

  const handleClear = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onSelect(null);
    },
    [onSelect],
  );

  const displayLabel = selectedRun ? formatRunLabel(selectedRun, t) : t('results.selectRun');

  return (
    <div ref={containerRef} className="relative min-w-[16rem]">
      <button
        type="button"
        onClick={() => !disabled && setOpen((prev) => !prev)}
        disabled={disabled}
        className={`flex w-full items-center justify-between gap-2 rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-left text-xs transition-colors ${
          disabled
            ? 'cursor-not-allowed opacity-50'
            : 'hover:border-accent/50 focus:border-accent focus:outline-none'
        }`}
      >
        <span className="truncate text-ink">{displayLabel}</span>
        <div className="flex shrink-0 items-center gap-1">
          {selectedRun && !disabled && (
            <button
              type="button"
              onClick={handleClear}
              className="rounded p-0.5 text-ink-dim hover:bg-surface-800 hover:text-ink"
              aria-label={t('common.cancel')}
            >
              <X size={12} />
            </button>
          )}
          <ChevronDown
            size={14}
            className={`shrink-0 text-ink-dim transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-[min(28rem,90vw)] overflow-hidden rounded-md border border-surface-700 bg-surface-900 shadow-xl">
          <div className="border-b border-surface-800 p-2">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-dim"
              />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('results.searchRunPlaceholder')}
                className="w-full rounded-md border border-surface-700 bg-surface-950 py-1.5 pl-8 pr-3 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                autoFocus
              />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-md border border-surface-700 bg-surface-950 p-0.5">
                {RUN_TYPE_OPTIONS.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setRunType(type)}
                    className={`rounded px-2 py-1 text-[10px] transition-colors ${
                      runType === type
                        ? 'bg-accent/10 text-accent'
                        : 'text-ink-muted hover:bg-surface-800 hover:text-ink'
                    }`}
                  >
                    {type === 'all'
                      ? t('results.runTypeAll')
                      : t(`results.runType${type.charAt(0).toUpperCase() + type.slice(1)}`)}
                  </button>
                ))}
              </div>

              <select
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value as SortBy)}
                className="rounded-md border border-surface-700 bg-surface-950 px-2 py-1 text-[10px] text-ink focus:border-accent focus:outline-none"
                aria-label={t('results.sortBy')}
              >
                {SORT_OPTIONS.map((sort) => (
                  <option key={sort} value={sort}>
                    {t(`results.sort${sort.charAt(0).toUpperCase() + sort.slice(1)}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div ref={listRef} className="max-h-72 overflow-y-auto p-1">
            {filteredRuns.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-ink-dim">
                {t('results.noRunsFound')}
              </div>
            ) : (
              filteredRuns.map((run, index) => {
                const summary = run.summary ?? {};
                const total = typeof summary.total_items === 'number' ? summary.total_items : 0;
                const isSelected = run.run_id === selectedRunId;
                const isHighlighted = index === highlightedIndex;
                return (
                  <button
                    key={run.run_id}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    type="button"
                    onClick={() => handleSelect(run)}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    className={`flex w-full items-center gap-3 rounded px-2 py-2 text-left transition-colors ${
                      isHighlighted || isSelected
                        ? 'bg-accent/10 text-ink'
                        : 'text-ink-muted hover:bg-surface-800 hover:text-ink'
                    }`}
                  >
                    <div
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        isSelected
                          ? 'border-accent bg-accent text-surface-950'
                          : 'border-surface-600 text-transparent'
                      }`}
                    >
                      <Check size={10} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${runTypeBadgeClass(
                            run.run_type,
                          )}`}
                        >
                          {run.run_type}
                        </span>
                        <span className="truncate text-xs font-medium text-ink">
                          {run.name || run.run_id}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-dim">
                        <span>
                          {total} {t('results.total').toLowerCase()}
                        </span>
                        <span>·</span>
                        <span>{new Date(run.created_at).toLocaleString()}</span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {filteredRuns.length > 0 && (
            <div className="border-t border-surface-800 px-3 py-1.5 text-[10px] text-ink-dim">
              {t('results.selected', { count: filteredRuns.length })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
