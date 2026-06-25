import {
  AlertCircle,
  ArrowLeft,
  Beaker,
  CheckCircle2,
  ChevronRight,
  Clock,
  Coins,
  Download,
  Eye,
  FileDown,
  ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Square,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import * as api from '../api/client';
import { ImagePreviewGrid } from '../components/prompts/ImagePreviewGrid';
import { resolveImageSrc } from '../components/lab/ImagePanel';
import { useI18n } from '../i18n';
import { useLabStore } from '../store/labStore';
import type { ImageRef, RequestImage, RunItemSummary, Task, TaskVersion } from '../types';

type Phase = 'setup' | 'running' | 'results';
type LimitOption = 10 | 50 | 'all';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATES = new Set([
  'completed',
  'completed_with_errors',
  'cancelled',
  'failed',
]);

interface StatusCounts {
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export function BatchView() {
  const { t } = useI18n();
  const lab = useLabStore();

  const [phase, setPhase] = useState<Phase>('setup');

  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [sampleSets, setSampleSets] = useState<api.SampleSetListItem[]>([]);
  const [isLoadingSets, setIsLoadingSets] = useState(false);

  const [selectedTaskId, setSelectedTaskId] = useState<string>('');
  const [taskDetail, setTaskDetail] = useState<(Task & { versions: TaskVersion[] }) | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  const [selectedSetId, setSelectedSetId] = useState<string>('');
  const [limit, setLimit] = useState<LimitOption>(10);

  const [runId, setRunId] = useState<string | null>(null);
  const [session, setSession] = useState<api.RunListItem | null>(null);
  const [items, setItems] = useState<RunItemSummary[]>([]);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<'jsonl' | 'csv' | null>(null);

  const [selectedItem, setSelectedItem] = useState<RunItemSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const providerNames = useMemo(
    () => new Map(lab.providerConfigs.map((c) => [c.provider_config_id, c.name])),
    [lab.providerConfigs],
  );

  const selectedTask = useMemo(
    () => tasks.find((task) => task.task_id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  const selectedVersion = useMemo(() => {
    if (!selectedTask) return null;
    return (
      taskDetail?.versions.find(
        (version) => version.task_version_id === selectedVersionId,
      ) ??
      selectedTask.current_version ??
      taskDetail?.versions[0] ??
      null
    );
  }, [selectedTask, taskDetail, selectedVersionId]);

  const selectedSetName = useMemo(() => {
    const set = sampleSets.find((s) => s.sample_set_id === selectedSetId);
    return set?.name;
  }, [sampleSets, selectedSetId]);

  // Load tasks and sample sets on mount.
  useEffect(() => {
    setIsLoadingTasks(true);
    setIsLoadingSets(true);
    setError(null);

    api
      .listTasks()
      .then((loadedTasks) => {
        setTasks(loadedTasks);
        const defaultTaskId =
          lab.activeTaskId ??
          loadedTasks[0]?.task_id ??
          '';
        setSelectedTaskId((current) => current || defaultTaskId);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('task.loadFailed'));
      })
      .finally(() => setIsLoadingTasks(false));

    api
      .listSampleSets()
      .then((sets) => {
        setSampleSets(sets);
        setSelectedSetId((current) => current || (sets[0]?.sample_set_id ?? ''));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('batch.loadFailed'));
      })
      .finally(() => setIsLoadingSets(false));
  }, [lab.activeTaskId, t]);

  // Load task detail (versions) when the selected task changes.
  useEffect(() => {
    if (!selectedTaskId) {
      setTaskDetail(null);
      setSelectedVersionId(null);
      return;
    }
    setIsDetailLoading(true);
    api
      .getTask(selectedTaskId)
      .then((detail) => {
        setTaskDetail(detail);
        setSelectedVersionId(
          (current) =>
            current ??
            (detail.current_version_id ??
              detail.current_version?.task_version_id ??
              detail.versions[0]?.task_version_id ??
              null),
        );
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('task.detailFailed')))
      .finally(() => setIsDetailLoading(false));
  }, [selectedTaskId, t]);

  useEffect(() => {
    if (phase !== 'running' || runStartedAt === null) return;

    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - runStartedAt);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [phase, runStartedAt]);

  useEffect(() => {
    if (phase !== 'running' || !runId) return;

    const poll = window.setInterval(() => {
      api
        .getBatchRunStatus(runId)
        .then(({ session: nextSession, items: nextItems }) => {
          setSession(nextSession);
          setItems(nextItems);
          if (TERMINAL_STATES.has(nextSession.status)) {
            setPhase('results');
          }
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : t('batch.statusFailed'));
        });
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(poll);
  }, [phase, runId, t]);

  const counts = useMemo<StatusCounts>(() => {
    const result = { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const item of items) {
      if (item.status === 'pending') result.pending += 1;
      else if (item.status === 'running') result.running += 1;
      else if (item.status === 'succeeded') result.succeeded += 1;
      else if (item.status === 'failed') result.failed += 1;
      else if (item.status === 'cancelled') result.cancelled += 1;
    }
    return result;
  }, [items]);

  const summary = (session?.summary ?? {}) as Record<string, number>;
  const totalItems = summary.total_items ?? items.length;
  const succeededCount = summary.succeeded_items ?? counts.succeeded;
  const failedCount = summary.failed_items ?? counts.failed;
  const cancelledCount = summary.cancelled_items ?? counts.cancelled;
  const completedCount = succeededCount + failedCount + cancelledCount;
  const progress = totalItems > 0 ? (completedCount / totalItems) * 100 : 0;

  const totalCost = useMemo(
    () => items.reduce((sum, item) => sum + (item.estimated_cost ?? 0), 0),
    [items],
  );

  const canStart = Boolean(selectedTaskId && selectedSetId && selectedVersion);

  function buildPayload(): api.CreateBatchRunPayload {
    return {
      task_id: selectedTaskId,
      sample_set_id: selectedSetId,
      task_version_id: selectedVersion?.task_version_id ?? selectedTask?.current_version_id ?? null,
      limit: limit === 'all' ? null : limit,
    };
  }

  async function startRun(response: api.BatchRunCreationResponse) {
    setRunId(response.run_id);
    setSession({
      run_id: response.run_id,
      run_type: 'batch',
      name: '',
      status: response.status,
      started_at: new Date().toISOString(),
      completed_at: null,
      summary: response.summary,
      created_at: new Date().toISOString(),
    });
    setItems([]);
    setElapsedMs(0);
    setRunStartedAt(Date.now());
    setPhase('running');
    setError(null);
  }

  async function handleStart() {
    if (!canStart) return;
    setIsStarting(true);
    setError(null);
    try {
      const result = await api.createBatchRun(buildPayload());
      await startRun(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('batch.startFailed'));
    } finally {
      setIsStarting(false);
    }
  }

  async function handleCancel() {
    if (!runId) return;
    setIsCancelling(true);
    try {
      await api.cancelBatchRun(runId);
      const { session: nextSession, items: nextItems } = await api.getBatchRunStatus(runId);
      setSession(nextSession);
      setItems(nextItems);
      if (TERMINAL_STATES.has(nextSession.status)) {
        setPhase('results');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('batch.cancelFailed'));
    } finally {
      setIsCancelling(false);
    }
  }

  async function handleRetryFailed() {
    if (!runId) return;
    setIsRetrying(true);
    setError(null);
    try {
      const result = await api.retryFailedBatchRun(runId);
      await startRun(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('batch.retryFailedError'));
    } finally {
      setIsRetrying(false);
    }
  }

  async function handleExport(format: 'jsonl' | 'csv') {
    if (!runId) return;
    setExportingFormat(format);
    try {
      if (format === 'jsonl') {
        await api.exportRunJsonl(runId);
      } else {
        await api.exportRunCsv(runId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('batch.exportFailed'));
    } finally {
      setExportingFormat(null);
    }
  }

  function handleBackToSetup() {
    setPhase('setup');
    setRunId(null);
    setSession(null);
    setItems([]);
    setElapsedMs(0);
    setRunStartedAt(null);
    setError(null);
    setSelectedItem(null);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="flex items-center justify-between border-b border-surface-800 bg-surface-900/50 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
            {t('batch.title')}
          </h1>
          <p className="mt-1 text-xs text-ink-dim">{t('batch.description')}</p>
        </div>
        {phase !== 'setup' && (
          <button
            type="button"
            onClick={handleBackToSetup}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
          >
            <ArrowLeft size={14} />
            {t('batch.setup')}
          </button>
        )}
      </header>

      <section className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {phase === 'setup' && (
          <SetupPanel
            tasks={tasks}
            sampleSets={sampleSets}
            isLoadingTasks={isLoadingTasks}
            isLoadingSets={isLoadingSets}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
            taskDetail={taskDetail}
            isDetailLoading={isDetailLoading}
            selectedVersionId={selectedVersionId}
            onSelectVersion={setSelectedVersionId}
            selectedSetId={selectedSetId}
            onSelectSet={setSelectedSetId}
            limit={limit}
            onChangeLimit={setLimit}
            providerNames={providerNames}
            selectedSetName={selectedSetName}
            onStart={handleStart}
            isStarting={isStarting}
            canStart={canStart}
          />
        )}

        {phase === 'running' && (
          <RunningPanel
            counts={counts}
            totalItems={totalItems}
            progress={progress}
            totalCost={totalCost}
            elapsedMs={elapsedMs}
            onCancel={handleCancel}
            isCancelling={isCancelling}
          />
        )}

        {phase === 'results' && (
          <ResultsPanel
            session={session}
            items={items}
            counts={counts}
            totalCost={totalCost}
            elapsedMs={elapsedMs}
            onRetry={handleRetryFailed}
            isRetrying={isRetrying}
            onViewItem={setSelectedItem}
            onExport={handleExport}
            exportingFormat={exportingFormat}
          />
        )}
      </section>

      {selectedItem && (
        <ResponseModal item={selectedItem} onClose={() => setSelectedItem(null)} />
      )}
    </div>
  );
}

interface SetupPanelProps {
  tasks: Task[];
  sampleSets: api.SampleSetListItem[];
  isLoadingTasks: boolean;
  isLoadingSets: boolean;
  selectedTaskId: string;
  onSelectTask: (id: string) => void;
  taskDetail: (Task & { versions: TaskVersion[] }) | null;
  isDetailLoading: boolean;
  selectedVersionId: string | null;
  onSelectVersion: (id: string | null) => void;
  selectedSetId: string;
  onSelectSet: (id: string) => void;
  limit: LimitOption;
  onChangeLimit: (value: LimitOption) => void;
  providerNames: Map<string, string>;
  selectedSetName?: string;
  onStart: () => void;
  isStarting: boolean;
  canStart: boolean;
}

function SetupPanel({
  tasks,
  sampleSets,
  isLoadingTasks,
  isLoadingSets,
  selectedTaskId,
  onSelectTask,
  taskDetail,
  isDetailLoading,
  selectedVersionId,
  onSelectVersion,
  selectedSetId,
  onSelectSet,
  limit,
  onChangeLimit,
  providerNames,
  selectedSetName,
  onStart,
  isStarting,
  canStart,
}: SetupPanelProps) {
  const { t } = useI18n();

  const limitOptions: { value: LimitOption; labelKey: string }[] = [
    { value: 10, labelKey: 'batch.limit10' },
    { value: 50, labelKey: 'batch.limit50' },
    { value: 'all', labelKey: 'batch.limitAll' },
  ];

  const selectedTask = tasks.find((task) => task.task_id === selectedTaskId);
  const versions = taskDetail?.versions ?? [];
  const currentVersion = selectedTask?.current_version;
  const selectedVersion = versions.find(
    (version) => version.task_version_id === selectedVersionId,
  );

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-5">
      <section className="panel p-5">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {t('batch.task')}
        </h2>
        {isLoadingTasks && tasks.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
            <Loader2 size={14} className="mr-2 animate-spin" />
            {t('task.loading')}
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-md border border-surface-800 bg-surface-950 p-4 text-xs text-ink-dim">
            {t('batch.noTasks')}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs text-ink-muted">{t('batch.task')}</label>
              <select
                value={selectedTaskId}
                onChange={(event) => onSelectTask(event.target.value)}
                className="w-full rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
              >
                <option value="">{t('batch.taskPlaceholder')}</option>
                {tasks.map((task) => (
                  <option key={task.task_id} value={task.task_id}>
                    {task.name}
                  </option>
                ))}
              </select>
            </div>

            {selectedTaskId && (
              <div>
                <label className="mb-1.5 block text-xs text-ink-muted">
                  {t('batch.version')}
                </label>
                {isDetailLoading ? (
                  <div className="flex h-16 items-center justify-center text-xs text-ink-muted">
                    <Loader2 size={14} className="mr-2 animate-spin" />
                    {t('task.loadingVersions')}
                  </div>
                ) : versions.length === 0 ? (
                  <div className="rounded-md border border-surface-800 bg-surface-950 p-3 text-xs text-ink-dim">
                    {t('task.noVersions')}
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {versions.map((version) => {
                    const isCurrent =
                      version.task_version_id === selectedTask?.current_version_id ||
                      version.task_version_id === currentVersion?.task_version_id;

                      return (
                        <li
                          key={version.task_version_id}
                          onClick={() => onSelectVersion(version.task_version_id)}
                          className={`cursor-pointer rounded-md border p-3 transition-colors ${
                            selectedVersion?.task_version_id === version.task_version_id
                              ? 'border-accent/50 bg-accent/5'
                              : 'border-surface-800 bg-surface-950 hover:border-surface-700'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-ink">
                              {version.version_label || version.task_version_id}
                            </span>
                            <div className="flex items-center gap-2">
                              {version.notes && (
                                <span className="truncate text-right text-[10px] text-ink-dim max-w-[200px]" title={version.notes}>
                                  {version.notes}
                                </span>
                              )}
                              {isCurrent && (
                                <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent shrink-0">
                                  {t('task.currentVersion')}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-dim">
                            <span>{t('task.model')}: {version.model_id}</span>
                            <span>
                              {t('task.providerConfig')}:{' '}
                              {version.provider_config_id
                                ? providerNames.get(version.provider_config_id) ??
                                  version.provider_config_id
                                : '—'}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {t('batch.sampleSet')}
        </h2>
        {isLoadingSets && sampleSets.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
            <Loader2 size={14} className="mr-2 animate-spin" />
            {t('samples.loading')}
          </div>
        ) : sampleSets.length === 0 ? (
          <div className="rounded-md border border-surface-800 bg-surface-950 p-4 text-xs text-ink-dim">
            {t('batch.noSampleSets')}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs text-ink-muted">
                {t('batch.sampleSet')}
              </label>
              <select
                value={selectedSetId}
                onChange={(event) => onSelectSet(event.target.value)}
                className="w-full rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
              >
                <option value="">{t('batch.sampleSetPlaceholder')}</option>
                {sampleSets.map((set) => (
                  <option key={set.sample_set_id} value={set.sample_set_id}>
                    {set.name} ({set.record_ids.length})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-ink-muted">{t('batch.limit')}</label>
              <div className="flex flex-wrap gap-2">
                {limitOptions.map((option) => (
                  <button
                    key={String(option.value)}
                    type="button"
                    onClick={() => onChangeLimit(option.value)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs transition-colors ${
                      limit === option.value
                        ? 'border-accent/50 bg-accent/10 text-accent'
                        : 'border-surface-700 text-ink-muted hover:bg-surface-800 hover:text-ink'
                    }`}
                  >
                    {limit === option.value ? (
                      <CheckCircle2 size={12} className="text-accent" />
                    ) : (
                      <Square size={12} />
                    )}
                    {t(option.labelKey)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {selectedTask && selectedVersion && (
        <section className="panel p-5">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-ink-muted">
            {t('batch.selectedConfig')}
          </h2>
          <div className="grid gap-3 text-xs">
            <div className="flex items-center gap-2 text-ink">
              <Beaker size={14} className="text-accent" />
              <span className="font-medium">{selectedTask.name}</span>
              {selectedVersion.version_label && (
                <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-ink-muted">
                  {selectedVersion.version_label}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-ink-dim">
              <span>{t('batch.modelId')}: {selectedVersion.model_id}</span>
              <span>
                {t('batch.providerConfig')}:{' '}
                {selectedVersion.provider_config_id
                  ? providerNames.get(selectedVersion.provider_config_id) ??
                    selectedVersion.provider_config_id
                  : '—'}
              </span>
              <span>
                {t('batch.sampleSet')}: {selectedSetName ?? '—'}
              </span>
            </div>
          </div>
        </section>
      )}

      <section className="panel p-5">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onStart}
            disabled={!canStart || isStarting}
            className="btn-primary px-3 py-2 text-xs disabled:opacity-50"
          >
            {isStarting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            {t('batch.start')}
          </button>
        </div>
      </section>
    </div>
  );
}

interface RunningPanelProps {
  counts: StatusCounts;
  totalItems: number;
  progress: number;
  totalCost: number;
  elapsedMs: number;
  onCancel: () => void;
  isCancelling: boolean;
}

function RunningPanel({
  counts,
  totalItems,
  progress,
  totalCost,
  elapsedMs,
  onCancel,
  isCancelling,
}: RunningPanelProps) {
  const { t } = useI18n();

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-5">
      <section className="panel p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            {t('batch.progress')}
          </h2>
          <span className="text-xs text-ink-dim">
            {Math.round(progress)}% · {completedCount(counts)} / {totalItems}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-800">
          <div
            className="h-full rounded-full bg-accent transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <CountCard label={t('batch.pending')} value={counts.pending} color="muted" />
        <CountCard label={t('batch.running')} value={counts.running} color="accent" />
        <CountCard label={t('batch.succeeded')} value={counts.succeeded} color="success" />
        <CountCard label={t('batch.failed')} value={counts.failed} color="danger" />
        <CountCard label={t('batch.cancelled')} value={counts.cancelled} color="warning" />
      </section>

      <section className="panel p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
            <span className="flex items-center gap-1.5 text-ink">
              <Coins size={14} className="text-cost" />
              <span className="text-ink-dim">{t('batch.totalCost')}:</span>
              <span className="font-semibold text-cost">USD {totalCost.toFixed(6)}</span>
            </span>
            <span className="flex items-center gap-1.5 text-ink">
              <Clock size={14} className="text-ink-dim" />
              <span className="text-ink-dim">{t('batch.elapsed')}:</span>
              <span className="font-mono">{formatDuration(elapsedMs)}</span>
            </span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isCancelling}
            className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 px-3 py-2 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            {isCancelling ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            {t('batch.cancel')}
          </button>
        </div>
      </section>
    </div>
  );
}

interface ResultsPanelProps {
  session: api.RunListItem | null;
  items: RunItemSummary[];
  counts: StatusCounts;
  totalCost: number;
  elapsedMs: number;
  onRetry: () => void;
  isRetrying: boolean;
  onViewItem: (item: RunItemSummary) => void;
  onExport?: (format: 'jsonl' | 'csv') => void;
  exportingFormat?: 'jsonl' | 'csv' | null;
}

function ResultsPanel({
  session,
  items,
  counts,
  totalCost,
  elapsedMs,
  onRetry,
  isRetrying,
  onViewItem,
  onExport,
  exportingFormat,
}: ResultsPanelProps) {
  const { t } = useI18n();

  return (
    <div className="animate-fade-in space-y-5">
      <section className="panel p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
            <span className="text-ink">
              <span className="text-ink-dim">{t('batch.status')}:</span>{' '}
              <StatusBadge status={session?.status ?? 'unknown'} />
            </span>
            <span className="flex items-center gap-1.5 text-ink">
              <Coins size={14} className="text-cost" />
              <span className="text-ink-dim">{t('batch.totalCost')}:</span>
              <span className="font-semibold text-cost">USD {totalCost.toFixed(6)}</span>
            </span>
            <span className="flex items-center gap-1.5 text-ink">
              <Clock size={14} className="text-ink-dim" />
              <span className="text-ink-dim">{t('batch.elapsed')}:</span>
              <span className="font-mono">{formatDuration(elapsedMs)}</span>
            </span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void onExport?.('jsonl')}
              disabled={exportingFormat !== null}
              className="btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs disabled:opacity-50"
            >
              {exportingFormat === 'jsonl' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <FileDown size={12} />
              )}
              {t('batch.exportJsonl')}
            </button>
            <button
              type="button"
              onClick={() => void onExport?.('csv')}
              disabled={exportingFormat !== null}
              className="btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs disabled:opacity-50"
            >
              {exportingFormat === 'csv' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Download size={12} />
              )}
              {t('batch.exportCsv')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!session?.run_id) return;
                window.dispatchEvent(
                  new CustomEvent('miko:navigate', { detail: { view: 'results', runId: session.run_id } }),
                );
              }}
              className="btn-primary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
            >
              <Eye size={12} />
              {t('batch.viewResults')}
            </button>
            <button
              type="button"
              onClick={onRetry}
              disabled={isRetrying || counts.failed === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
            >
              {isRetrying ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              {t('batch.retryFailed')}
            </button>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <CountCard label={t('batch.pending')} value={counts.pending} color="muted" />
        <CountCard label={t('batch.running')} value={counts.running} color="accent" />
        <CountCard label={t('batch.succeeded')} value={counts.succeeded} color="success" />
        <CountCard label={t('batch.failed')} value={counts.failed} color="danger" />
        <CountCard label={t('batch.cancelled')} value={counts.cancelled} color="warning" />
      </section>

      {items.length === 0 ? (
        <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
          {t('batch.noItems')}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-surface-700">
          <div className="max-h-[calc(100vh-20rem)] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 z-10 bg-surface-900">
                <tr className="border-b border-surface-700 text-ink-muted">
                  <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                    {t('batch.sampleId')}
                  </th>
                  <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                    {t('batch.status')}
                  </th>
                  <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                    {t('batch.cost')}
                  </th>
                  <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                    {t('batch.latency')}
                  </th>
                  <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                    {t('batch.image')}
                  </th>
                  <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                    {t('batch.responsePreview')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {items.map((item) => (
                  <tr
                    key={item.run_item_id}
                    onClick={() => onViewItem(item)}
                    className="cursor-pointer bg-surface-950 transition-colors hover:bg-surface-900/50"
                  >
                    <td className="px-4 py-3 align-top font-mono text-ink">{item.sample_id}</td>
                    <td className="px-4 py-3 align-top">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-4 py-3 align-top text-ink">{item.estimated_cost.toFixed(6)}</td>
                    <td className="px-4 py-3 align-top text-ink-muted">{formatLatency(item.latency_ms)}</td>
                    <td className="px-4 py-3 align-top">
                      <ImageThumbnail snapshot={item.internal_request_snapshot} />
                    </td>
                    <td className="px-4 py-3 align-top text-ink-muted">
                      <div className="flex items-center gap-2">
                        <span className="max-w-xs truncate">
                          {truncateText(extractRawText(item.response), 120)}
                        </span>
                        <ChevronRight size={14} className="shrink-0 text-ink-dim" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ResponseModal({ item, onClose }: { item: RunItemSummary; onClose: () => void }) {
  const { t } = useI18n();
  const rawText = extractRawText(item.response);
  const itemImages = extractImagesFromSnapshot(item.internal_request_snapshot);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <span className="font-mono text-xs text-ink-dim">{item.sample_id}</span>
            <span className="text-ink-muted">·</span>
            <StatusBadge status={item.status} />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
            aria-label={t('common.cancel')}
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {itemImages.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                {t('batch.inputImages')}
              </h3>
              <ImagePreviewGrid images={itemImages} size="md" />
            </section>
          )}
          <pre className="whitespace-pre-wrap rounded-md border border-surface-800 bg-surface-950 p-4 font-mono text-xs text-ink">
            {rawText || t('result.noRawOutput')}
          </pre>
        </div>
      </div>
    </div>
  );
}

function CountCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: 'muted' | 'accent' | 'success' | 'danger' | 'warning';
}) {
  const colorClasses = {
    muted: 'bg-surface-900 text-ink-muted border-surface-700',
    accent: 'bg-accent/10 text-accent border-accent/20',
    success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    danger: 'bg-danger/10 text-danger border-danger/20',
    warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  };

  return (
    <div className={`rounded-md border p-3 ${colorClasses[color]}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const normalized = status.toLowerCase();

  if (normalized === 'succeeded' || normalized === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
        <CheckCircle2 size={10} />
        {t('batch.succeeded')}
      </span>
    );
  }
  if (normalized === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
        <XCircle size={10} />
        {t('batch.failed')}
      </span>
    );
  }
  if (normalized === 'running') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
        <Loader2 size={10} className="animate-spin" />
        {t('batch.running')}
      </span>
    );
  }
  if (normalized === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
        <Square size={10} />
        {t('batch.cancelled')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-800 px-2 py-0.5 text-[10px] font-medium text-ink-muted">
      {t('batch.pending')}
    </span>
  );
}

function completedCount(counts: StatusCounts): number {
  return counts.succeeded + counts.failed + counts.cancelled;
}

function extractRawText(response: Record<string, unknown>): string {
  const raw = response.raw_text;
  if (typeof raw === 'string') return raw;
  const text = response.text;
  if (typeof text === 'string') return text;
  return '';
}

function extractImagesFromSnapshot(
  snapshot: Record<string, unknown> | null | undefined,
): ImageRef[] {
  if (!snapshot) return [];
  const images = snapshot.images as RequestImage[] | undefined;
  if (!Array.isArray(images)) return [];
  return images
    .filter((img) => img && (img.resolved?.uri || img.resolved?.path || img.path))
    .map((img) => ({
      path: img.resolved?.path ?? img.path ?? null,
      uri: img.resolved?.uri ?? null,
      mime_type: img.mime_type ?? null,
      role: img.role ?? undefined,
      order: img.order ?? 0,
    }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function ImageThumbnail({
  snapshot,
}: {
  snapshot: Record<string, unknown> | null | undefined;
}) {
  const images = extractImagesFromSnapshot(snapshot);
  const first = images[0];
  const src = first ? resolveImageSrc(first) : '';

  if (!src) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-surface-800 bg-surface-950 text-ink-dim">
        <ImageIcon size={14} />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      className="h-10 w-10 rounded-md border border-surface-700 object-cover"
    />
  );
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function formatLatency(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [pad(minutes), pad(seconds)];
  if (hours > 0) parts.unshift(String(hours));
  return parts.join(':');
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}
