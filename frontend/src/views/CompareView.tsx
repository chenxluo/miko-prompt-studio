import {
  AlertCircle,
  ArrowLeft,
  Beaker,
  CheckCircle2,
  Clock,
  Coins,
  Loader2,
  Play,
  Plus,
  Save,
  Square,
  Star,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import * as api from '../api/client';
import { SaveTaskDialog, type SaveTaskDialogPrefill } from '../components/lab/SaveTaskDialog';
import { useI18n } from '../i18n';
import { useLabStore } from '../store/labStore';
import { MappingPanel } from '../components/batch/MappingPanel';
import type { ImagePreprocessConfig, ImageRef, RunItemSummary, Task, TaskVersion } from '../types';

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

interface SelectedVersion {
  taskId: string;
  taskVersionId: string;
  label: string | null;
  taskName: string;
  version: TaskVersion;
  variableMapping: Record<string, string>;
  imageRoleMapping: Record<string, string>;
}

interface VersionColumn {
  taskVersionId: string;
  label: string;
  modelId: string;
  providerConfigId: string | null;
}

export function CompareView() {
  const { t } = useI18n();
  const lab = useLabStore();

  const [phase, setPhase] = useState<Phase>('setup');

  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [sampleSets, setSampleSets] = useState<api.SampleSetListItem[]>([]);
  const [isLoadingSets, setIsLoadingSets] = useState(false);

  const [selectedSetId, setSelectedSetId] = useState<string>('');
  const [sampleRecords, setSampleRecords] = useState<api.SampleListItem[]>([]);
  const [limit, setLimit] = useState<LimitOption>(10);

  const [selectedTaskIdForAdd, setSelectedTaskIdForAdd] = useState<string>('');
  const [taskDetailForAdd, setTaskDetailForAdd] = useState<
    (Task & { versions: TaskVersion[] }) | null
  >(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [selectedVersionIdForAdd, setSelectedVersionIdForAdd] = useState<string | null>(null);
  const [selectedVersions, setSelectedVersions] = useState<SelectedVersion[]>([]);

  const [runId, setRunId] = useState<string | null>(null);
  const [session, setSession] = useState<api.RunListItem | null>(null);
  const [items, setItems] = useState<RunItemSummary[]>([]);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const [bestItemIds, setBestItemIds] = useState<Set<string>>(new Set());
  const [selectedItem, setSelectedItem] = useState<RunItemSummary | null>(null);
  const [savePrefill, setSavePrefill] = useState<SaveTaskDialogPrefill | null>(null);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const providerNames = useMemo(
    () => new Map(lab.providerConfigs.map((c) => [c.provider_config_id, c.name])),
    [lab.providerConfigs],
  );

  const selectedTaskForAdd = useMemo(
    () => tasks.find((task) => task.task_id === selectedTaskIdForAdd) ?? null,
    [tasks, selectedTaskIdForAdd],
  );

  // Load tasks and sample sets on mount.
  useEffect(() => {
    setIsLoadingTasks(true);
    setIsLoadingSets(true);
    setError(null);

    api
      .listTasks()
      .then((loadedTasks) => {
        setTasks(loadedTasks);
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
  }, [t]);

  // Load one sample record from the selected set so we can offer field mapping.
  useEffect(() => {
    if (!selectedSetId) {
      setSampleRecords([]);
      return;
    }
    let cancelled = false;
    api
      .listSamples(selectedSetId, 1)
      .then((records) => {
        if (!cancelled) setSampleRecords(records);
      })
      .catch(() => {
        if (!cancelled) setSampleRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSetId]);

  const sampleVarsKeys = useMemo(() => {
    const vars = sampleRecords[0]?.data?.vars;
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return [];
    return Object.keys(vars);
  }, [sampleRecords]);

  const sampleImageRoles = useMemo(() => {
    const images = sampleRecords[0]?.data?.images;
    if (!Array.isArray(images)) return [];
    const roles = new Set<string>();
    for (const image of images) {
      if (image && typeof image === 'object' && typeof (image as ImageRef).role === 'string') {
        roles.add((image as ImageRef).role as string);
      }
    }
    return Array.from(roles);
  }, [sampleRecords]);

  // Load task detail for the add selector.
  useEffect(() => {
    if (!selectedTaskIdForAdd) {
      setTaskDetailForAdd(null);
      setSelectedVersionIdForAdd(null);
      return;
    }
    setIsDetailLoading(true);
    api
      .getTask(selectedTaskIdForAdd)
      .then((detail) => {
        setTaskDetailForAdd(detail);
        const defaultVersionId =
          detail.current_version_id ??
          detail.current_version?.task_version_id ??
          detail.versions[0]?.task_version_id ??
          null;
        setSelectedVersionIdForAdd((current) => current ?? defaultVersionId);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('task.detailFailed')))
      .finally(() => setIsDetailLoading(false));
  }, [selectedTaskIdForAdd, t]);

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
        .getCompareRunStatus(runId)
        .then(({ session: nextSession, items: nextItems }) => {
          setSession(nextSession);
          setItems(nextItems);
          if (TERMINAL_STATES.has(nextSession.status)) {
            setPhase('results');
          }
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : t('compare.statusFailed'));
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

  const totalItems = items.length;
  const completedCount = counts.succeeded + counts.failed + counts.cancelled;
  const progress = totalItems > 0 ? (completedCount / totalItems) * 100 : 0;

  const totalCost = useMemo(
    () => items.reduce((sum, item) => sum + (item.estimated_cost ?? 0), 0),
    [items],
  );

  const canStart = Boolean(selectedSetId && selectedVersions.length >= 2);

  function buildPayload(): api.CreateCompareRunPayload {
    return {
      sample_set_id: selectedSetId,
      task_versions: selectedVersions.map((v) => {
        const variableMappingPayload: Record<string, string> = {};
        for (const [key, value] of Object.entries(v.variableMapping)) {
          if (value) variableMappingPayload[key] = value;
        }
        const imageRoleMappingPayload: Record<string, string> = {};
        for (const [key, value] of Object.entries(v.imageRoleMapping)) {
          if (value) imageRoleMappingPayload[key] = value;
        }

        return {
          task_id: v.taskId,
          task_version_id: v.taskVersionId,
          label: v.label,
          variable_mapping: variableMappingPayload,
          image_role_mapping: imageRoleMappingPayload,
        };
      }),
      limit: limit === 'all' ? null : limit,
    };
  }

  async function startRun(response: api.CompareRunCreationResponse) {
    setRunId(response.run_id);
    setSession({
      run_id: response.run_id,
      run_type: 'compare',
      name: '',
      status: response.status,
      started_at: new Date().toISOString(),
      completed_at: null,
      summary: response.summary,
      created_at: new Date().toISOString(),
      pipeline_id: null,
      pipeline_step: null,
    });
    setItems([]);
    setElapsedMs(0);
    setRunStartedAt(Date.now());
    setPhase('running');
    setError(null);
    setBestItemIds(new Set());
  }

  async function handleStart() {
    if (!canStart) return;
    setIsStarting(true);
    setError(null);
    try {
      const result = await api.createCompareRun(buildPayload());
      await startRun(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('compare.startFailed'));
    } finally {
      setIsStarting(false);
    }
  }

  async function handleCancel() {
    if (!runId) return;
    setIsCancelling(true);
    try {
      await api.cancelCompareRun(runId);
      const { session: nextSession, items: nextItems } = await api.getCompareRunStatus(runId);
      setSession(nextSession);
      setItems(nextItems);
      if (TERMINAL_STATES.has(nextSession.status)) {
        setPhase('results');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('compare.cancelFailed'));
    } finally {
      setIsCancelling(false);
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
    setBestItemIds(new Set());
  }

  function handleAddVersion() {
    if (!selectedTaskForAdd || !selectedVersionIdForAdd || !taskDetailForAdd) return;
    const version = taskDetailForAdd.versions.find(
      (v) => v.task_version_id === selectedVersionIdForAdd,
    );
    if (!version) return;
    const exists = selectedVersions.some((v) => v.taskVersionId === selectedVersionIdForAdd);
    if (exists) return;

    setSelectedVersions((current) => [
      ...current,
      {
        taskId: selectedTaskForAdd.task_id,
        taskVersionId: version.task_version_id,
        label: version.version_label || null,
        taskName: selectedTaskForAdd.name,
        version,
        variableMapping: {},
        imageRoleMapping: {},
      },
    ]);
  }

  function handleRemoveVersion(taskVersionId: string) {
    setSelectedVersions((current) => current.filter((v) => v.taskVersionId !== taskVersionId));
  }

  function setVersionVariableMapping(
    taskVersionId: string,
    variableMapping: Record<string, string>,
  ) {
    setSelectedVersions((current) =>
      current.map((v) =>
        v.taskVersionId === taskVersionId ? { ...v, variableMapping } : v,
      ),
    );
  }

  function setVersionImageRoleMapping(
    taskVersionId: string,
    imageRoleMapping: Record<string, string>,
  ) {
    setSelectedVersions((current) =>
      current.map((v) =>
        v.taskVersionId === taskVersionId ? { ...v, imageRoleMapping } : v,
      ),
    );
  }

  function toggleBest(item: RunItemSummary) {
    setBestItemIds((current) => {
      const next = new Set(current);
      if (next.has(item.run_item_id)) {
        next.delete(item.run_item_id);
      } else {
        next.add(item.run_item_id);
      }
      return next;
    });
  }

  function handleSaveConfig(item: RunItemSummary) {
    const prefill = buildPrefillFromItem(item);
    setSavePrefill(prefill);
    setIsSaveDialogOpen(true);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="flex items-center justify-between border-b border-surface-800 bg-surface-900/50 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
            {t('compare.title')}
          </h1>
          <p className="mt-1 text-xs text-ink-dim">{t('compare.description')}</p>
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
            selectedTaskId={selectedTaskIdForAdd}
            onSelectTask={setSelectedTaskIdForAdd}
            taskDetail={taskDetailForAdd}
            isDetailLoading={isDetailLoading}
            selectedVersionId={selectedVersionIdForAdd}
            onSelectVersion={setSelectedVersionIdForAdd}
            selectedVersions={selectedVersions}
            onAddVersion={handleAddVersion}
            onRemoveVersion={handleRemoveVersion}
            selectedSetId={selectedSetId}
            onSelectSet={setSelectedSetId}
            limit={limit}
            onChangeLimit={setLimit}
            providerNames={providerNames}
            sampleVarsKeys={sampleVarsKeys}
            sampleImageRoles={sampleImageRoles}
            onChangeVersionVariableMapping={setVersionVariableMapping}
            onChangeVersionImageRoleMapping={setVersionImageRoleMapping}
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
            bestItemIds={bestItemIds}
            onToggleBest={toggleBest}
            onSaveConfig={handleSaveConfig}
            onViewItem={setSelectedItem}
            providerNames={providerNames}
          />
        )}
      </section>

      {selectedItem && (
        <ResponseModal item={selectedItem} onClose={() => setSelectedItem(null)} />
      )}

      <SaveTaskDialog
        isOpen={isSaveDialogOpen}
        onClose={() => {
          setIsSaveDialogOpen(false);
          setSavePrefill(null);
        }}
        prefill={savePrefill}
      />
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
  selectedVersions: SelectedVersion[];
  onAddVersion: () => void;
  onRemoveVersion: (taskVersionId: string) => void;
  selectedSetId: string;
  onSelectSet: (id: string) => void;
  limit: LimitOption;
  onChangeLimit: (value: LimitOption) => void;
  providerNames: Map<string, string>;
  sampleVarsKeys: string[];
  sampleImageRoles: string[];
  onChangeVersionVariableMapping: (
    taskVersionId: string,
    mapping: Record<string, string>,
  ) => void;
  onChangeVersionImageRoleMapping: (
    taskVersionId: string,
    mapping: Record<string, string>,
  ) => void;
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
  selectedVersions,
  onAddVersion,
  onRemoveVersion,
  selectedSetId,
  onSelectSet,
  limit,
  onChangeLimit,
  providerNames,
  sampleVarsKeys,
  sampleImageRoles,
  onChangeVersionVariableMapping,
  onChangeVersionImageRoleMapping,
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

  const versions = taskDetail?.versions ?? [];

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-5">
      <section className="panel p-5">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {t('compare.sampleSet')}
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

      <section className="panel p-5">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {t('compare.versions')}
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
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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

              <div>
                <label className="mb-1.5 block text-xs text-ink-muted">
                  {t('batch.version')}
                </label>
                {isDetailLoading ? (
                  <div className="flex h-9 items-center text-xs text-ink-muted">
                    <Loader2 size={14} className="mr-2 animate-spin" />
                    {t('task.loadingVersions')}
                  </div>
                ) : selectedTaskId && versions.length === 0 ? (
                  <div className="rounded-md border border-surface-800 bg-surface-950 p-2 text-xs text-ink-dim">
                    {t('task.noVersions')}
                  </div>
                ) : (
                  <select
                    value={selectedVersionId ?? ''}
                    onChange={(event) => onSelectVersion(event.target.value || null)}
                    disabled={!selectedTaskId || versions.length === 0}
                    className="w-full rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none disabled:opacity-50"
                  >
                    <option value="">{t('compare.versionPlaceholder')}</option>
                    {versions.map((version) => (
                      <option key={version.task_version_id} value={version.task_version_id}>
                        {version.version_label || version.task_version_id}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={onAddVersion}
              disabled={!selectedVersionId}
              className="btn-secondary px-3 py-2 text-xs disabled:opacity-50"
            >
              <Plus size={14} />
              {t('compare.addVersion')}
            </button>

            {selectedVersions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedVersions.map((v) => (
                  <div
                    key={v.taskVersionId}
                    className="inline-flex items-center gap-2 rounded-md border border-accent/20 bg-accent/5 px-2.5 py-1.5 text-xs"
                  >
                    <Beaker size={12} className="text-accent" />
                    <span className="text-ink">
                      {v.taskName}
                      <span className="mx-1 text-ink-dim">·</span>
                      <span className="text-ink-muted">{v.label || v.taskVersionId}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemoveVersion(v.taskVersionId)}
                      className="rounded p-0.5 text-ink-dim hover:bg-surface-800 hover:text-danger"
                      aria-label={t('compare.removeVersion')}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {selectedVersions.length > 0 && (
              <div className="rounded-md border border-surface-800 bg-surface-950 p-3 text-xs text-ink-dim">
                <div className="mb-2 font-medium text-ink-muted">{t('compare.selectedConfig')}</div>
                <div className="space-y-4">
                  {selectedVersions.map((v) => (
                    <div key={v.taskVersionId} className="space-y-2">
                      <div className="flex flex-wrap gap-x-3 text-ink">
                        <span className="font-medium">{v.taskName}</span>
                        <span className="text-ink-muted">
                          {v.label || v.taskVersionId}
                        </span>
                        <span>{t('task.model')}: {v.version.model_id}</span>
                        <span>
                          {t('task.providerConfig')}:{' '}
                          {v.version.provider_config_id
                            ? providerNames.get(v.version.provider_config_id) ??
                              v.version.provider_config_id
                            : '—'}
                        </span>
                      </div>
                      {selectedSetId && (
                        <MappingPanel
                          namespace="compare"
                          variableSpecs={v.version.variable_specs ?? []}
                          imageSlotSpecs={v.version.image_slot_specs ?? []}
                          sampleVarsKeys={sampleVarsKeys}
                          sampleImageRoles={sampleImageRoles}
                          variableMapping={v.variableMapping}
                          imageRoleMapping={v.imageRoleMapping}
                          onChangeVariableMapping={(mapping) =>
                            onChangeVersionVariableMapping(v.taskVersionId, mapping)
                          }
                          onChangeImageRoleMapping={(mapping) =>
                            onChangeVersionImageRoleMapping(v.taskVersionId, mapping)
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

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
            {t('compare.start')}
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
              <Loader2 size={14} className="animate-spin text-accent" />
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
  bestItemIds: Set<string>;
  onToggleBest: (item: RunItemSummary) => void;
  onSaveConfig: (item: RunItemSummary) => void;
  onViewItem: (item: RunItemSummary) => void;
  providerNames: Map<string, string>;
}

function ResultsPanel({
  session,
  items,
  counts,
  totalCost,
  elapsedMs,
  bestItemIds,
  onToggleBest,
  onSaveConfig,
  onViewItem,
  providerNames,
}: ResultsPanelProps) {
  const { t } = useI18n();

  const versionColumns = useMemo<VersionColumn[]>(() => {
    const map = new Map<string, VersionColumn>();
    for (const item of items) {
      const taskVersionId = item.compare_axes?.task_version_id;
      if (!taskVersionId || map.has(taskVersionId)) continue;
      const promptSnapshot = item.prompt_snapshot ?? {};
      const modelSnapshot = item.model_config_snapshot ?? {};
      map.set(taskVersionId, {
        taskVersionId,
        label:
          typeof promptSnapshot.version_label === 'string'
            ? promptSnapshot.version_label
            : taskVersionId.slice(0, 8),
        modelId: typeof modelSnapshot.model_id === 'string' ? modelSnapshot.model_id : '—',
        providerConfigId:
          typeof modelSnapshot.provider_config_id === 'string'
            ? modelSnapshot.provider_config_id
            : null,
      });
    }
    return Array.from(map.values());
  }, [items]);

  const rows = useMemo(() => {
    const map = new Map<string, RunItemSummary[]>();
    for (const item of items) {
      const list = map.get(item.sample_id) ?? [];
      list.push(item);
      map.set(item.sample_id, list);
    }
    return Array.from(map.entries())
      .map(([sampleId, rowItems]) => ({
        sampleId,
        cells: new Map(
          rowItems.map((item) => [item.compare_axes?.task_version_id ?? '', item]),
        ),
      }))
      .sort((a, b) => a.sampleId.localeCompare(b.sampleId));
  }, [items]);

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
              <Loader2 size={14} className="text-ink-dim" />
              <span className="text-ink-dim">{t('batch.elapsed')}:</span>
              <span className="font-mono">{formatDuration(elapsedMs)}</span>
            </span>
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
                  <th className="whitespace-nowrap px-4 py-3 font-semibold uppercase tracking-wider">
                    {t('batch.sampleId')}
                  </th>
                  {versionColumns.map((col) => (
                    <th
                      key={col.taskVersionId}
                      className="min-w-[12rem] px-4 py-3 font-semibold uppercase tracking-wider"
                    >
                      <div className="text-ink">{col.label}</div>
                      <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] font-normal normal-case text-ink-dim">
                        <span>{col.modelId}</span>
                        {col.providerConfigId ? (
                          <span>
                            {providerNames.get(col.providerConfigId) ?? col.providerConfigId}
                          </span>
                        ) : null}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {rows.map((row) => (
                  <tr key={row.sampleId} className="bg-surface-950">
                    <td className="whitespace-nowrap px-4 py-3 align-top font-mono text-ink">
                      {row.sampleId}
                    </td>
                    {versionColumns.map((col) => {
                      const item = row.cells.get(col.taskVersionId);
                      return (
                        <td key={col.taskVersionId} className="px-4 py-3 align-top">
                          {item ? (
                            <MatrixCell
                              item={item}
                              isBest={bestItemIds.has(item.run_item_id)}
                              onToggleBest={() => onToggleBest(item)}
                              onSaveConfig={() => onSaveConfig(item)}
                              onView={() => onViewItem(item)}
                            />
                          ) : (
                            <span className="text-ink-dim">—</span>
                          )}
                        </td>
                      );
                    })}
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

interface MatrixCellProps {
  item: RunItemSummary;
  isBest: boolean;
  onToggleBest: () => void;
  onSaveConfig: () => void;
  onView: () => void;
}

function MatrixCell({ item, isBest, onToggleBest, onSaveConfig, onView }: MatrixCellProps) {
  const { t } = useI18n();
  const rawText = extractRawText(item.response);

  return (
    <div
      onClick={onView}
      className={`cursor-pointer rounded-md border p-3 transition-colors ${
        isBest
          ? 'border-accent/40 bg-accent/5'
          : 'border-surface-800 bg-surface-900/50 hover:border-surface-600'
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <StatusBadge status={item.status} />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleBest();
            }}
            className={`rounded p-1 transition-colors ${
              isBest
                ? 'text-accent hover:bg-accent/10'
                : 'text-ink-dim hover:bg-surface-800 hover:text-ink'
            }`}
            aria-label={t('compare.markBest')}
            title={t('compare.markBest')}
          >
            <Star size={14} className={isBest ? 'fill-current' : ''} />
          </button>
          {isBest && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSaveConfig();
              }}
              className="rounded p-1 text-accent transition-colors hover:bg-accent/10"
              aria-label={t('compare.saveWinningConfig')}
              title={t('compare.saveWinningConfig')}
            >
              <Save size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="mb-2 space-y-1 text-[11px] text-ink-dim">
        <div className="flex items-center gap-1">
          <Coins size={10} className="text-cost" />
          <span>{item.estimated_cost.toFixed(6)}</span>
        </div>
        <div className="flex items-center gap-1">
          <Clock size={10} />
          <span>{formatLatency(item.latency_ms)}</span>
        </div>
      </div>
      <div className="max-h-[4.5em] overflow-hidden text-[11px] leading-relaxed text-ink-dim">
        {truncateText(rawText, 120) || t('history.noResponse')}
      </div>
    </div>
  );
}

function ResponseModal({ item, onClose }: { item: RunItemSummary; onClose: () => void }) {
  const { t } = useI18n();
  const rawText = extractRawText(item.response);

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
        <div className="min-h-0 flex-1 overflow-auto p-4">
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

function buildPrefillFromItem(item: RunItemSummary): SaveTaskDialogPrefill {
  const promptSnapshot = item.prompt_snapshot ?? {};
  const modelSnapshot = item.model_config_snapshot ?? {};
  const outputContract = item.output_contract_snapshot ?? {};
  const pricingSnapshot = item.pricing_snapshot ?? {};

  const modelParameters =
    (modelSnapshot.parameters as Record<string, unknown> | undefined) ??
    (modelSnapshot.model_parameters as Record<string, unknown> | undefined);

  const imagePreprocessConfig =
    (modelSnapshot.image_preprocess_config as ImagePreprocessConfig | null | undefined) ?? null;

  return {
    system_prompt:
      typeof promptSnapshot.system_prompt === 'string'
        ? promptSnapshot.system_prompt
        : undefined,
    user_template:
      typeof promptSnapshot.user_template === 'string'
        ? promptSnapshot.user_template
        : undefined,
    image_slot_specs: Array.isArray(promptSnapshot.image_slot_specs)
      ? promptSnapshot.image_slot_specs
      : undefined,
    provider_config_id:
      typeof modelSnapshot.provider_config_id === 'string'
        ? modelSnapshot.provider_config_id
        : null,
    model_id: typeof modelSnapshot.model_id === 'string' ? modelSnapshot.model_id : undefined,
    model_parameters: modelParameters,
    output_contract: Object.keys(outputContract).length > 0 ? outputContract : undefined,
    image_preprocess_config: imagePreprocessConfig,
    pricing_profile_id:
      typeof pricingSnapshot.pricing_profile_id === 'string'
        ? pricingSnapshot.pricing_profile_id
        : null,
    notes: typeof promptSnapshot.notes === 'string' ? promptSnapshot.notes : undefined,
  };
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
