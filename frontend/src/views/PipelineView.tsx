import { AlertCircle, Eye, Loader2, Search, Trash, Trash2, Workflow } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import * as api from '../api/client';
import { useI18n } from '../i18n';
import type { RunSessionStatus } from '../types';
import { RunStatusBadge } from './RunHistoryView';

// MVP assumption: pipeline runs are a modest subset of all runs, so we fetch a
// large page and group client-side. If run volume grows, add a server-side
// pipeline_id filter to /api/runs instead.
const FETCH_LIMIT = 10000;

interface PipelineGroup {
  pipelineId: string;
  runs: api.RunListItem[];
  totalCost: number;
  currency: string;
  firstAt: string;
  lastAt: string;
}

export function PipelineView() {
  const { t } = useI18n();
  const [runs, setRuns] = useState<api.RunListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [deletingPipelineId, setDeletingPipelineId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const result = await api.listRuns({ limit: FETCH_LIMIT });
        if (cancelled) return;
        setRuns(result.runs);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('pipelines.loadFailed'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const groups = useMemo(() => groupPipelineRuns(runs), [runs]);

  const filteredGroups = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) => group.pipelineId.toLowerCase().includes(query));
  }, [groups, filter]);

  function handleViewRun(runId: string) {
    window.dispatchEvent(
      new CustomEvent('miko:navigate', { detail: { view: 'results', runId } }),
    );
  }

  async function handleDeleteRun(runId: string) {
    if (!window.confirm(t('pipelines.deleteRunConfirm'))) return;
    setDeletingRunId(runId);
    setError(null);
    try {
      await api.deleteRun(runId);
      setRuns((current) => current.filter((run) => run.run_id !== runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('runs.deleteFailed'));
    } finally {
      setDeletingRunId(null);
    }
  }

  async function handleDeletePipeline(group: PipelineGroup) {
    if (
      !window.confirm(
        t('pipelines.deletePipelineConfirm', {
          id: group.pipelineId,
          count: group.runs.length,
        }),
      )
    )
      return;
    setDeletingPipelineId(group.pipelineId);
    setError(null);
    const deletedIds: string[] = [];
    try {
      for (const run of group.runs) {
        await api.deleteRun(run.run_id);
        deletedIds.push(run.run_id);
      }
    } catch (err) {
      const succeeded = deletedIds.length;
      const total = group.runs.length;
      const failed = total - succeeded;
      const baseMessage = err instanceof Error ? err.message : t('runs.deleteFailed');
      setError(
        t('pipelines.deletePipelinePartial', {
          succeeded,
          failed,
          total,
          message: baseMessage,
        }),
      );
    } finally {
      if (deletedIds.length > 0) {
        setRuns((current) => current.filter((run) => !deletedIds.includes(run.run_id)));
      }
      setDeletingPipelineId(null);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="flex flex-col gap-3 border-b border-surface-800 bg-surface-900/50 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
            {t('pipelines.title')}
          </h1>
          <p className="mt-1 text-xs text-ink-dim">{t('pipelines.description')}</p>
        </div>

        <div className="relative max-w-md">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-dim"
          />
          <input
            type="text"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('pipelines.filterPlaceholder')}
            className="w-full rounded-md border border-surface-700 bg-surface-900 py-2 pl-9 pr-3 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>
      </header>

      <section className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {isLoading && runs.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-ink-muted">
            <Loader2 size={16} className="mr-2 animate-spin" />
            {t('pipelines.loading')}
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="panel flex h-64 flex-col items-center justify-center p-6 text-center">
            <Workflow size={32} className="mb-3 text-ink-dim" />
            <h3 className="text-sm font-semibold text-ink">{t('pipelines.emptyTitle')}</h3>
            <p className="mt-2 max-w-md text-xs leading-relaxed text-ink-dim">
              {t('pipelines.emptyDescription')}
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            {filteredGroups.map((group) => (
              <PipelineCard
                key={group.pipelineId}
                group={group}
                onViewRun={handleViewRun}
                onDeleteRun={handleDeleteRun}
                onDeletePipeline={handleDeletePipeline}
                deletingRunId={deletingRunId}
                deletingPipelineId={deletingPipelineId}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PipelineCard({
  group,
  onViewRun,
  onDeleteRun,
  onDeletePipeline,
  deletingRunId,
  deletingPipelineId,
}: {
  group: PipelineGroup;
  onViewRun: (runId: string) => void;
  onDeleteRun: (runId: string) => void;
  onDeletePipeline: (group: PipelineGroup) => void;
  deletingRunId: string | null;
  deletingPipelineId: string | null;
}) {
  const { t } = useI18n();
  const firstAt = group.firstAt ? new Date(group.firstAt).toLocaleString() : '—';
  const lastAt = group.lastAt ? new Date(group.lastAt).toLocaleString() : '—';
  const isDeletingPipeline = deletingPipelineId === group.pipelineId;

  return (
    <article className="panel p-4">
      <div className="mb-4 flex flex-col gap-2 border-b border-surface-800 pb-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Workflow size={16} className="shrink-0 text-accent" />
            <code className="truncate text-sm font-semibold text-ink">{group.pipelineId}</code>
          </div>
          <div className="mt-1 text-xs text-ink-dim">
            {t('pipelines.runCount', { count: group.runs.length })} · {firstAt} → {lastAt}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onDeletePipeline(group)}
            disabled={isDeletingPipeline}
            className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2.5 py-1.5 text-xs text-ink-muted transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
            title={t('pipelines.deletePipeline')}
            aria-label={t('pipelines.deletePipeline')}
          >
            {isDeletingPipeline ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Trash size={14} />
            )}
            {t('pipelines.deletePipeline')}
          </button>
          <div className="text-left md:text-right">
            <div className="text-xs text-ink-dim">{t('pipelines.totalCost')}</div>
            <div className="text-sm font-semibold text-cost">
              {group.currency} {group.totalCost.toFixed(6)}
            </div>
          </div>
        </div>
      </div>

      <div className="pl-2">
        {group.runs.map((run, index) => (
          <PipelineStepRow
            key={run.run_id}
            run={run}
            index={index}
            isLast={index === group.runs.length - 1}
            onView={onViewRun}
            onDelete={onDeleteRun}
            isDeleting={deletingRunId === run.run_id}
          />
        ))}
      </div>
    </article>
  );
}

function PipelineStepRow({
  run,
  index,
  isLast,
  onView,
  onDelete,
  isDeleting,
}: {
  run: api.RunListItem;
  index: number;
  isLast: boolean;
  onView: (runId: string) => void;
  onDelete: (runId: string) => void;
  isDeleting: boolean;
}) {
  const { t } = useI18n();
  const summary = run.summary || {};
  const sampleCount = typeof summary.total_items === 'number' ? summary.total_items : 0;
  const totalCost = typeof summary.total_cost_estimated === 'number'
    ? summary.total_cost_estimated
    : 0;
  const currency = typeof summary.currency === 'string' ? summary.currency : 'USD';
  const createdAt = run.created_at ? new Date(run.created_at).toLocaleString() : '—';
  const stepLabel = run.pipeline_step || t('pipelines.step', { n: index + 1 });
  // Run list payload does not include task name; show the run name / id instead.
  const identifier = run.name || run.run_id;

  return (
    <div className="group flex">
      <div className="flex w-8 flex-col items-center py-1">
        <div className="h-2.5 w-2.5 rounded-full bg-accent" />
        {!isLast && <div className="w-px flex-1 bg-surface-700" />}
      </div>
      <button
        type="button"
        onClick={() => onView(run.run_id)}
        className="mb-3 flex flex-1 cursor-pointer items-start justify-between gap-4 rounded-md border border-surface-800 bg-surface-950 p-3 text-left transition-colors hover:border-surface-600 hover:bg-surface-900/50"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-ink">{stepLabel}</span>
            <RunStatusBadge status={run.status as RunSessionStatus} />
          </div>
          <div className="mt-1 truncate text-[10px] text-ink-dim">{identifier}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-xs font-medium text-cost">
            {currency} {totalCost.toFixed(6)}
          </div>
          <div className="text-[10px] text-ink-dim">
            {t('pipelines.sampleCount', { count: sampleCount })}
          </div>
          <div className="text-[10px] text-ink-dim">{createdAt}</div>
        </div>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete(run.run_id);
        }}
        disabled={isDeleting}
        className="mb-3 ml-2 inline-flex items-center justify-center self-center rounded-md p-1.5 text-ink-dim opacity-0 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50 group-hover:opacity-100"
        title={t('pipelines.deleteRun')}
        aria-label={t('pipelines.deleteRun')}
      >
        {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
      </button>
      <button
        type="button"
        onClick={() => onView(run.run_id)}
        className="mb-3 ml-2 inline-flex items-center justify-center self-center rounded-md p-1.5 text-ink-dim opacity-0 transition-colors hover:bg-surface-800 hover:text-ink group-hover:opacity-100"
        aria-label={t('pipelines.viewRun')}
        title={t('pipelines.viewRun')}
      >
        <Eye size={14} />
      </button>
    </div>
  );
}

function groupPipelineRuns(runs: api.RunListItem[]): PipelineGroup[] {
  const map = new Map<string, api.RunListItem[]>();
  for (const run of runs) {
    if (!run.pipeline_id) continue;
    const list = map.get(run.pipeline_id) ?? [];
    list.push(run);
    map.set(run.pipeline_id, list);
  }

  const groups: PipelineGroup[] = [];
  for (const [pipelineId, pipelineRuns] of map.entries()) {
    const sorted = [...pipelineRuns].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const totalCost = sorted.reduce((sum, run) => {
      const summary = run.summary || {};
      const cost = typeof summary.total_cost_estimated === 'number' ? summary.total_cost_estimated : 0;
      return sum + cost;
    }, 0);
    const firstSummary = sorted[0]?.summary || {};
    const currency = typeof firstSummary.currency === 'string' ? firstSummary.currency : 'USD';
    groups.push({
      pipelineId,
      runs: sorted,
      totalCost,
      currency,
      firstAt: sorted[0]?.created_at ?? '',
      lastAt: sorted[sorted.length - 1]?.created_at ?? '',
    });
  }

  groups.sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());
  return groups;
}
