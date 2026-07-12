import {
  AlertCircle,
  AlignLeft,
  ArrowLeft,
  Beaker,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Coins,
  Columns3,
  GitCompare,
  Loader2,
  Play,
  Plus,
  Save,
  Square,
  Star,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import * as api from '../api/client';
import { SaveTaskDialog, type SaveTaskDialogPrefill } from '../components/lab/SaveTaskDialog';
import { resolveImageUrl } from '../components/lab/ImagePanel';
import { useI18n } from '../i18n';
import { useLabStore } from '../store/labStore';
import { MappingPanel } from '../components/batch/MappingPanel';
import {
  RunExecutionControls,
  type RunConcurrency,
  type RunLimit,
  type RunLimitStrategy,
  type RunRetries,
} from '../components/runs/RunExecutionControls';
import type { CrossRunColumn, CrossRunResponse, CrossRunRow, ImagePreprocessConfig, ImageRef, RunItemSummary, Task, TaskVersion } from '../types';

type Phase = 'setup' | 'running' | 'results';
type LimitOption = RunLimit;
type CompareMode = 'new-run' | 'cross-run';

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

export function CompareRunView() {
  return <CompareWorkspace workflow="create-run" />;
}

export function CrossRunAnalysisView({ onExit }: { onExit: () => void }) {
  return <CompareWorkspace workflow="analyze-runs" onExit={onExit} />;
}

function CompareWorkspace({
  workflow,
  onExit,
}: {
  workflow: 'create-run' | 'analyze-runs';
  onExit?: () => void;
}) {
  const { t } = useI18n();
  const lab = useLabStore();

  const [phase, setPhase] = useState<Phase>('setup');
  const [mode, setMode] = useState<CompareMode>(
    workflow === 'analyze-runs' ? 'cross-run' : 'new-run',
  );

  // new-run mode state
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [sampleSets, setSampleSets] = useState<api.SampleSetListItem[]>([]);
  const [isLoadingSets, setIsLoadingSets] = useState(false);

  const [selectedSetId, setSelectedSetId] = useState<string>('');
  const [sampleRecords, setSampleRecords] = useState<api.SampleListItem[]>([]);
  const [limit, setLimit] = useState<LimitOption>(10);
  const [limitStrategy, setLimitStrategy] = useState<RunLimitStrategy>('first');
  const [concurrency, setConcurrency] = useState<RunConcurrency>(1);
  const [maxRetries, setMaxRetries] = useState<RunRetries>(0);
  const [runName, setRunName] = useState('');

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

  // cross-run mode state
  const [completedRuns, setCompletedRuns] = useState<api.RunListItem[]>([]);
  const [isLoadingCompletedRuns, setIsLoadingCompletedRuns] = useState(false);
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [isStartingCrossRun, setIsStartingCrossRun] = useState(false);
  const [crossRunData, setCrossRunData] = useState<CrossRunResponse | null>(null);

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

  // Load completed runs for cross-run mode.
  useEffect(() => {
    if (mode !== 'cross-run' || phase !== 'setup') return;
    let cancelled = false;
    setIsLoadingCompletedRuns(true);
    api
      .listCompletedRuns()
      .then((runs) => {
        if (!cancelled) setCompletedRuns(runs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('batch.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingCompletedRuns(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, phase, t]);

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
      variants: selectedVersions.map((v) => {
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
      limit_strategy: limit === 'all' ? undefined : limitStrategy,
      max_concurrency: concurrency,
      max_retries: maxRetries,
      name: runName.trim(),
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
    setCrossRunData(null);
    setSelectedRunIds([]);
  }

  async function handleStartCrossRun() {
    if (selectedRunIds.length < 2 || selectedRunIds.length > 4) return;
    setIsStartingCrossRun(true);
    setError(null);
    try {
      const data = await api.compareCrossRun(selectedRunIds);
      setCrossRunData(data);
      setBestItemIds(new Set());
      setPhase('results');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('compare.startFailed'));
    } finally {
      setIsStartingCrossRun(false);
    }
  }

  function toggleRunSelection(runId: string) {
    setSelectedRunIds((current) => {
      if (current.includes(runId)) {
        return current.filter((id) => id !== runId);
      }
      if (current.length >= 4) return current;
      return [...current, runId];
    });
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

  async function handleAddAllFamilyVersions(familyTasks: Task[]) {
    if (familyTasks.length === 0) return;
    const tasksToFetch: Task[] = [];
    const versionsToAdd: SelectedVersion[] = [];

    for (const task of familyTasks) {
      const version = task.current_version;
      if (version && version.task_version_id) {
        const exists = selectedVersions.some((v) => v.taskVersionId === version.task_version_id);
        if (!exists) {
          versionsToAdd.push({
            taskId: task.task_id,
            taskVersionId: version.task_version_id,
            label: version.version_label || null,
            taskName: task.name,
            version,
            variableMapping: {},
            imageRoleMapping: {},
          });
        }
      } else {
        tasksToFetch.push(task);
      }
    }

    if (tasksToFetch.length > 0) {
      setIsDetailLoading(true);
      try {
        const details = await Promise.all(tasksToFetch.map((t) => api.getTask(t.task_id)));
        for (const [index, task] of tasksToFetch.entries()) {
          const detail = details[index];
          const version = detail.current_version ?? detail.versions[0];
          if (!version || !version.task_version_id) {
            setError(t('compare.noCurrentVersion'));
            continue;
          }
          const exists = selectedVersions.some((v) => v.taskVersionId === version.task_version_id);
          if (!exists) {
            versionsToAdd.push({
              taskId: task.task_id,
              taskVersionId: version.task_version_id,
              label: version.version_label || null,
              taskName: task.name,
              version,
              variableMapping: {},
              imageRoleMapping: {},
            });
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('compare.addFamilyFailed'));
        return;
      } finally {
        setIsDetailLoading(false);
      }
    }

    if (versionsToAdd.length > 0) {
      setSelectedVersions((current) => [...current, ...versionsToAdd]);
      setSelectedTaskIdForAdd(familyTasks[0]?.task_id ?? '');
    }
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
            {workflow === 'analyze-runs' ? t('compare.crossRunTitle') : t('compare.title')}
          </h1>
          <p className="mt-1 text-xs text-ink-dim">
            {workflow === 'analyze-runs'
              ? t('compare.crossRunDescription')
              : t('compare.description')}
          </p>
        </div>
        {(phase !== 'setup' || onExit) && (
          <button
            type="button"
            onClick={phase !== 'setup' ? handleBackToSetup : onExit}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
          >
            <ArrowLeft size={14} />
            {phase !== 'setup' ? t('batch.setup') : t('results.backToResults')}
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
          <div className="mx-auto max-w-3xl animate-fade-in space-y-5">
            {workflow === 'create-run' && (
            <div className="flex gap-1 border-b border-surface-800">
              <ModeTabButton
                isActive={mode === 'new-run'}
                onClick={() => setMode('new-run')}
                icon={Plus}
                label={t('compare.modeNewRun')}
              />
              <ModeTabButton
                isActive={mode === 'cross-run'}
                onClick={() => setMode('cross-run')}
                icon={GitCompare}
                label={t('compare.modeCrossRun')}
              />
            </div>
            )}

            {mode === 'new-run' && (
              <SetupPanel
                tasks={tasks}
                sampleSets={sampleSets}
                isLoadingTasks={isLoadingTasks}
                isLoadingSets={isLoadingSets}
                selectedTaskId={selectedTaskIdForAdd}
                onSelectTask={setSelectedTaskIdForAdd}
                onAddAllFamilyVersions={handleAddAllFamilyVersions}
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
                limitStrategy={limitStrategy}
                onChangeLimitStrategy={setLimitStrategy}
                concurrency={concurrency}
                onChangeConcurrency={setConcurrency}
                maxRetries={maxRetries}
                onChangeMaxRetries={setMaxRetries}
                runName={runName}
                onChangeRunName={setRunName}
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

            {mode === 'cross-run' && (
              <CrossRunSetupPanel
                runs={completedRuns}
                isLoading={isLoadingCompletedRuns}
                selectedRunIds={selectedRunIds}
                onToggleRun={toggleRunSelection}
                onStart={handleStartCrossRun}
                isStarting={isStartingCrossRun}
              />
            )}
          </div>
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

        {phase === 'results' && mode === 'new-run' && (
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

        {phase === 'results' && mode === 'cross-run' && crossRunData && (
          <CrossRunResultsPanel
            data={crossRunData}
            bestItemIds={bestItemIds}
            onToggleBest={toggleBest}
            onSaveConfig={handleSaveConfig}
            onViewItem={setSelectedItem}
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

/// Language codes used for name-suffix heuristic grouping.
const NAME_LANGUAGE_CODES = [
  'en', 'jp', 'ja', 'zh', 'ko', 'fr', 'de', 'es', 'pt', 'it',
  'ru', 'ar', 'hi', 'th', 'vi', 'id', 'ms', 'tr', 'nl', 'pl',
];

interface DetectedLanguage {
  baseName: string;
  language: string;
}

/// Detect a trailing language code in a task name.
/// e.g. "ins描述en" → { baseName: "ins描述", language: "en" }
function detectLanguageFromName(name: string): DetectedLanguage | null {
  const trimmed = name.trim();
  for (const code of NAME_LANGUAGE_CODES) {
    const match = trimmed.match(new RegExp(`(.+?)[-\\s_/~]?${code}$`, 'i'));
    if (match && match[1].trim().length > 0) {
      return { baseName: match[1].trim(), language: code.toLowerCase() };
    }
  }
  return null;
}

function getTaskDisplayLanguage(task: Task): string | null {
  if (task.language) return task.language;
  return detectLanguageFromName(task.name)?.language ?? null;
}

interface PickerGroup {
  key: string;
  label: string;
  members: Task[];
  isInferred: boolean;
}

interface TaskFamilyPickerProps {
  tasks: Task[];
  selectedTaskId: string;
  onSelectTask: (taskId: string) => void;
  onAddAllFamilyVersions: (familyTasks: Task[]) => void;
}

function TaskFamilyPicker({
  tasks,
  selectedTaskId,
  onSelectTask,
  onAddAllFamilyVersions,
}: TaskFamilyPickerProps) {
  const { t } = useI18n();
  const [openFamilies, setOpenFamilies] = useState<Set<string>>(
    () => new Set(),
  );

  const { groups, ungrouped } = useMemo(() => {
    const explicitFamilies = new Map<string, Task[]>();
    const inferredMap = new Map<string, { baseName: string; members: Task[] }>();
    const ungrouped: Task[] = [];

    for (const task of tasks) {
      if (task.family_id) {
        const current = explicitFamilies.get(task.family_id);
        if (current) {
          current.push(task);
        } else {
          explicitFamilies.set(task.family_id, [task]);
        }
      } else {
        // Fallback: detect language from name suffix to infer family grouping.
        const detected = detectLanguageFromName(task.name);
        if (detected) {
          const key = detected.baseName.toLowerCase();
          const existing = inferredMap.get(key);
          if (existing) {
            existing.members.push(task);
          } else {
            inferredMap.set(key, { baseName: detected.baseName, members: [task] });
          }
        } else {
          ungrouped.push(task);
        }
      }
    }

    // Sort members within each group by language for stable display.
    for (const members of explicitFamilies.values()) {
      members.sort((a, b) => (a.language || '').localeCompare(b.language || ''));
    }
    for (const { members } of inferredMap.values()) {
      members.sort((a, b) => (a.language || '').localeCompare(b.language || ''));
    }
    ungrouped.sort((a, b) => a.name.localeCompare(b.name));

    const resultGroups: PickerGroup[] = [];
    for (const [familyId, members] of explicitFamilies.entries()) {
      resultGroups.push({
        key: familyId,
        label: members[0]?.name ?? familyId,
        members,
        isInferred: false,
      });
    }
    // Only promote inferred groups with 2+ members; singles go to ungrouped.
    for (const { baseName, members } of inferredMap.values()) {
      if (members.length >= 2) {
        resultGroups.push({
          key: `inferred:${baseName.toLowerCase()}`,
          label: baseName,
          members,
          isInferred: true,
        });
      } else {
        ungrouped.push(members[0]);
      }
    }
    resultGroups.sort((a, b) => a.label.localeCompare(b.label));

    return { groups: resultGroups, ungrouped };
  }, [tasks]);

  function toggleFamily(familyId: string) {
    setOpenFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(familyId)) {
        next.delete(familyId);
      } else {
        next.add(familyId);
      }
      return next;
    });
  }

  const renderTaskButton = (task: Task, showLanguage: boolean) => {
    const displayLanguage = getTaskDisplayLanguage(task);
    return (
      <button
        key={task.task_id}
        type="button"
        onClick={() => onSelectTask(task.task_id)}
        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${
          selectedTaskId === task.task_id
            ? 'bg-accent/10 text-accent'
            : 'text-ink hover:bg-surface-800'
        }`}
      >
        <span className="truncate">{task.name}</span>
        {showLanguage && displayLanguage && (
          <span className="shrink-0 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
            {displayLanguage}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="max-h-72 overflow-auto rounded-md border border-surface-700 bg-surface-900 text-xs">
      {groups.length === 0 && ungrouped.length === 0 && (
        <div className="px-3 py-2 text-ink-dim">{t('batch.taskPlaceholder')}</div>
      )}
      <div className="divide-y divide-surface-800">
        {groups.map((group) => {
          const isOpen = openFamilies.has(group.key);
          return (
            <div key={group.key} className="bg-surface-950">
              <div className="flex items-center justify-between border-b border-surface-800 px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggleFamily(group.key)}
                  className="flex flex-1 items-center gap-2 text-left text-xs font-medium text-ink transition-colors hover:text-accent"
                >
                  <span
                    className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}
                  >
                    <ChevronRight size={14} />
                  </span>
                  <span className="truncate">
                    {t('compare.familyLabel')}: {group.label}
                  </span>
                  {group.isInferred && (
                    <span className="shrink-0 rounded border border-violet-400/30 bg-violet-500/10 px-1 py-0.5 text-[9px] text-violet-300">
                      {t('compare.inferredFamily')}
                    </span>
                  )}
                  <span className="shrink-0 rounded-full bg-surface-800 px-1.5 py-0.5 text-[10px] text-ink-muted">
                    {group.members.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onAddAllFamilyVersions(group.members)}
                  className="ml-2 inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] text-accent transition-colors hover:bg-accent/10"
                  title={t('compare.selectAllLanguages')}
                >
                  <Plus size={10} />
                  {t('compare.selectAllLanguages')}
                </button>
              </div>
              {isOpen && (
                <div className="divide-y divide-surface-800">
                  {group.members.map((task) => renderTaskButton(task, true))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {ungrouped.length > 0 && (
        <div className="border-t border-surface-700">
          <div className="bg-surface-950 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
            {t('task.noGroup')}
          </div>
          <div className="divide-y divide-surface-800">
            {ungrouped.map((task) => renderTaskButton(task, false))}
          </div>
        </div>
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
  onSelectTask: (taskId: string) => void;
  onAddAllFamilyVersions: (familyTasks: Task[]) => void;
  taskDetail: (Task & { versions: TaskVersion[] }) | null;
  isDetailLoading: boolean;
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string | null) => void;
  selectedVersions: SelectedVersion[];
  onAddVersion: () => void;
  onRemoveVersion: (taskVersionId: string) => void;
  selectedSetId: string;
  onSelectSet: (setId: string) => void;
  limit: LimitOption;
  onChangeLimit: (value: LimitOption) => void;
  limitStrategy: RunLimitStrategy;
  onChangeLimitStrategy: (value: RunLimitStrategy) => void;
  concurrency: RunConcurrency;
  onChangeConcurrency: (value: RunConcurrency) => void;
  maxRetries: RunRetries;
  onChangeMaxRetries: (value: RunRetries) => void;
  runName: string;
  onChangeRunName: (value: string) => void;
  providerNames: Map<string, string>;
  sampleVarsKeys: string[];
  sampleImageRoles: string[];
  onChangeVersionVariableMapping: (
    taskVersionId: string,
    variableMapping: Record<string, string>,
  ) => void;
  onChangeVersionImageRoleMapping: (
    taskVersionId: string,
    imageRoleMapping: Record<string, string>,
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
  onAddAllFamilyVersions,
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
  limitStrategy,
  onChangeLimitStrategy,
  concurrency,
  onChangeConcurrency,
  maxRetries,
  onChangeMaxRetries,
  runName,
  onChangeRunName,
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

            <RunExecutionControls
              name={runName}
              onChangeName={onChangeRunName}
              limit={limit}
              onChangeLimit={onChangeLimit}
              limitStrategy={limitStrategy}
              onChangeLimitStrategy={onChangeLimitStrategy}
              concurrency={concurrency}
              onChangeConcurrency={onChangeConcurrency}
              maxRetries={maxRetries}
              onChangeMaxRetries={onChangeMaxRetries}
            />
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
                <TaskFamilyPicker
                  tasks={tasks}
                  selectedTaskId={selectedTaskId}
                  onSelectTask={onSelectTask}
                  onAddAllFamilyVersions={onAddAllFamilyVersions}
                />
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
  divergenceStatus?: 'divergent' | 'consistent' | 'missing' | 'no_parse';
}

function MatrixCell({
  item,
  isBest,
  onToggleBest,
  onSaveConfig,
  onView,
  divergenceStatus,
}: MatrixCellProps) {
  const { t } = useI18n();
  const rawText = extractRawText(item.response);

  const divergenceDot = (() => {
    if (divergenceStatus === 'divergent') {
      return (
        <span
          className="text-amber-400"
          title={t('compare.divergent')}
          aria-label={t('compare.divergent')}
        >
          ●
        </span>
      );
    }
    if (divergenceStatus === 'consistent') {
      return (
        <span
          className="text-emerald-400"
          title={t('compare.consistent')}
          aria-label={t('compare.consistent')}
        >
          ●
        </span>
      );
    }
    return null;
  })();

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
        <div className="flex items-center gap-1.5">
          <StatusBadge status={item.status} />
          {divergenceDot}
        </div>
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

interface ModeTabButtonProps {
  isActive: boolean;
  onClick: () => void;
  icon: typeof Plus;
  label: string;
}

function ModeTabButton({ isActive, onClick, icon: Icon, label }: ModeTabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
        isActive
          ? 'border-accent text-accent'
          : 'border-transparent text-ink-muted hover:text-ink'
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

interface CrossRunSetupPanelProps {
  runs: api.RunListItem[];
  isLoading: boolean;
  selectedRunIds: string[];
  onToggleRun: (runId: string) => void;
  onStart: () => void;
  isStarting: boolean;
}

function CrossRunSetupPanel({
  runs,
  isLoading,
  selectedRunIds,
  onToggleRun,
  onStart,
  isStarting,
}: CrossRunSetupPanelProps) {
  const { t } = useI18n();
  const canStart = selectedRunIds.length >= 2 && selectedRunIds.length <= 4;
  const orderedRuns = useMemo(
    () =>
      [...runs].sort((a, b) => {
        const aFamily = String(a.summary?.family_id || a.summary?.task_id || '');
        const bFamily = String(b.summary?.family_id || b.summary?.task_id || '');
        if (aFamily !== bFamily) return aFamily.localeCompare(bFamily);
        return (b.completed_at ?? b.created_at).localeCompare(a.completed_at ?? a.created_at);
      }),
    [runs],
  );

  return (
    <div className="space-y-5">
      <section className="panel p-5">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {t('compare.selectRuns')}
        </h2>
        {isLoading && runs.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
            <Loader2 size={14} className="mr-2 animate-spin" />
            {t('task.loading')}
          </div>
        ) : runs.length === 0 ? (
          <div className="rounded-md border border-surface-800 bg-surface-950 p-4 text-xs text-ink-dim">
            {t('runs.empty')}
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-surface-700">
            <div className="max-h-[calc(100vh-26rem)] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 z-10 bg-surface-900">
                  <tr className="border-b border-surface-700 text-ink-muted">
                    <th className="w-12 px-4 py-3 font-semibold uppercase tracking-wider"></th>
                    <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                      {t('runs.runName')}
                    </th>
                    <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                      {t('task.model')}
                    </th>
                    <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                      {t('batch.sampleSet')}
                    </th>
                    <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                      {t('task.updatedAt')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-800">
                  {orderedRuns.map((run) => {
                    const isSelected = selectedRunIds.includes(run.run_id);
                    const summary = run.summary ?? {};
                    const taskName =
                      typeof summary.task_name === 'string' ? summary.task_name : '';
                    const modelId =
                      typeof summary.model_id === 'string' ? summary.model_id : '';
                    const language =
                      typeof summary.language === 'string' ? summary.language : '';
                    const sampleSetName =
                      typeof summary.sample_set_name === 'string' ? summary.sample_set_name : '';
                    const familyId =
                      typeof summary.family_id === 'string' ? summary.family_id : '';
                    const itemCount =
                      typeof summary.item_count === 'number'
                        ? summary.item_count
                        : typeof summary.total === 'number'
                          ? summary.total
                          : null;
                    return (
                      <tr
                        key={run.run_id}
                        onClick={() => onToggleRun(run.run_id)}
                        className={`cursor-pointer ${
                          isSelected ? 'bg-accent/5' : 'bg-surface-950 hover:bg-surface-900'
                        }`}
                      >
                        <td className="px-4 py-3 align-middle">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => onToggleRun(run.run_id)}
                            onClick={(event) => event.stopPropagation()}
                            className="h-4 w-4 rounded border-surface-600 bg-surface-900 text-accent"
                          />
                        </td>
                        <td className="px-4 py-3 align-middle">
                          <div className="font-medium text-ink">{run.name || taskName || run.run_id}</div>
                          <div className="font-mono text-[10px] text-ink-dim">{run.run_id}</div>
                          {itemCount !== null ? (
                            <div className="text-[11px] text-ink-dim">
                              {itemCount} {t('runs.column.sampleCount')}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          <div className="text-ink">{taskName || '—'}</div>
                          <div className="flex gap-2 text-[11px] text-ink-dim">
                            {language && <span className="text-accent">{language}</span>}
                            <span>{modelId || '—'}</span>
                          </div>
                          {familyId && (
                            <div className="mt-0.5 truncate text-[10px] text-violet-300/70" title={familyId}>
                              {t('task.translationFamily')}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 align-middle text-ink-dim">
                          {sampleSetName || '—'}
                        </td>
                        <td className="px-4 py-3 align-middle text-ink-dim">
                          {formatDate(run.completed_at ?? run.created_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="panel p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="text-xs">
            <span className="text-ink">
              {t('compare.selectedCount', { count: selectedRunIds.length })}
            </span>
            {selectedRunIds.length < 2 && (
              <span className="ml-3 text-amber-400">{t('compare.minRequired')}</span>
            )}
          </div>
          <button
            type="button"
            onClick={onStart}
            disabled={!canStart || isStarting}
            className="btn-primary inline-flex items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-50"
          >
            {isStarting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            {t('compare.startCrossRun')}
          </button>
        </div>
      </section>
    </div>
  );
}

interface CrossRunResultsPanelProps {
  data: CrossRunResponse;
  bestItemIds: Set<string>;
  onToggleBest: (item: RunItemSummary) => void;
  onSaveConfig: (item: RunItemSummary) => void;
  onViewItem: (item: RunItemSummary) => void;
}

function CrossRunResultsPanel({
  data,
  bestItemIds,
  onToggleBest,
  onSaveConfig,
  onViewItem,
}: CrossRunResultsPanelProps) {
  const { t } = useI18n();
  const [baseColumnIndex, setBaseColumnIndex] = useState(0);
  const [showDivergentOnly, setShowDivergentOnly] = useState(false);
  const [selectedDiffRowIndex, setSelectedDiffRowIndex] = useState<number | null>(null);
  const [navigateMode, setNavigateMode] = useState<'divergent' | 'all'>('divergent');

  const rows = useMemo(
    () => [...data.rows].sort((a, b) => a.sample_id.localeCompare(b.sample_id)),
    [data.rows],
  );

  const divergenceByRow = useMemo(() => {
    const baseCol = data.columns[baseColumnIndex];
    const baseRunId = baseCol?.run_id;
    const result = new Map<string, boolean>();
    for (const row of rows) {
      const baseItem = baseRunId ? row.items[baseRunId] : undefined;
      let hasDivergent = false;
      for (const col of data.columns) {
        const item = row.items[col.run_id];
        if (computeDivergence(item, baseItem) === 'divergent') {
          hasDivergent = true;
          break;
        }
      }
      result.set(row.sample_id, hasDivergent);
    }
    return result;
  }, [rows, data.columns, baseColumnIndex]);

  const visibleRows = useMemo(() => {
    if (!showDivergentOnly) return rows;
    return rows.filter((row) => divergenceByRow.get(row.sample_id) ?? false);
  }, [rows, showDivergentOnly, divergenceByRow]);

  const divergentRowIndices = useMemo(() => {
    const indices: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (divergenceByRow.get(rows[i].sample_id)) {
        indices.push(i);
      }
    }
    return indices;
  }, [rows, divergenceByRow]);

  const selectedDiffRow =
    selectedDiffRowIndex !== null ? rows[selectedDiffRowIndex] : null;

  const hasPrev =
    selectedDiffRowIndex !== null &&
    (navigateMode === 'divergent'
      ? divergentRowIndices.length > 1
      : rows.length > 1);
  const hasNext =
    selectedDiffRowIndex !== null &&
    (navigateMode === 'divergent'
      ? divergentRowIndices.length > 1
      : rows.length > 1);

  const goToPrev = () => {
    if (selectedDiffRowIndex === null) return;
    const source =
      navigateMode === 'divergent'
        ? divergentRowIndices
        : rows.map((_, index) => index);
    const currentIdx = source.indexOf(selectedDiffRowIndex);
    const nextIdx = currentIdx <= 0 ? source.length - 1 : currentIdx - 1;
    const nextIndex = source[nextIdx];
    if (nextIndex !== undefined) {
      setSelectedDiffRowIndex(nextIndex);
    }
  };

  const goToNext = () => {
    if (selectedDiffRowIndex === null) return;
    const source =
      navigateMode === 'divergent'
        ? divergentRowIndices
        : rows.map((_, index) => index);
    const currentIdx = source.indexOf(selectedDiffRowIndex);
    const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % source.length;
    const nextIndex = source[nextIdx];
    if (nextIndex !== undefined) {
      setSelectedDiffRowIndex(nextIndex);
    }
  };

  return (
    <div className="animate-fade-in space-y-5">
      <section className="panel p-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <span className="text-ink">
            <span className="text-ink-dim">
              {t('compare.intersection', { count: data.sample_count })}
            </span>
          </span>
          <label className="inline-flex items-center gap-2 text-xs text-ink">
            <input
              type="checkbox"
              checked={showDivergentOnly}
              onChange={(event) => setShowDivergentOnly(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-surface-600 bg-surface-900 text-accent"
            />
            {t('compare.divergentOnly')}
          </label>
        </div>
      </section>

      <div className="overflow-hidden rounded-lg border border-surface-700">
        <div className="max-h-[calc(100vh-20rem)] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface-900">
              <tr className="border-b border-surface-700 text-ink-muted">
                <th className="whitespace-nowrap px-4 py-3 font-semibold uppercase tracking-wider">
                  {t('batch.sampleId')}
                </th>
                {data.columns.map((col, index) => (
                  <th
                    key={col.run_id}
                    onClick={() => setBaseColumnIndex(index)}
                    className="min-w-[12rem] cursor-pointer px-4 py-3 font-semibold uppercase tracking-wider transition-colors hover:bg-surface-800"
                  >
                    <div className="text-ink">
                      {col.task_name}
                      {col.language && (
                        <span className="ml-2 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                          {col.language}
                        </span>
                      )}
                      {index === baseColumnIndex && (
                        <span className="ml-2 text-[10px] text-accent">
                          {t('compare.baseColumn')}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] font-normal normal-case text-ink-dim">
                      <span>{col.model_id}</span>
                      <span>{col.task_version_label}</span>
                      {col.family_id && <span>{t('task.translationSibling')}</span>}
                      {col.translation_drift && (
                        <span className="text-amber-300">{t('task.translationDrift')}</span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-800">
              {visibleRows.map((row) => (
                <tr key={row.sample_id} className="bg-surface-950">
                  <td
                    className="cursor-pointer whitespace-nowrap px-4 py-3 align-top font-mono text-ink hover:text-accent hover:underline"
                    onClick={() => {
                      const index = rows.findIndex(
                        (r) => r.sample_id === row.sample_id,
                      );
                      setSelectedDiffRowIndex(index >= 0 ? index : null);
                    }}
                  >
                    {row.sample_id}
                  </td>
                  {data.columns.map((col) => {
                    const item = row.items[col.run_id];
                    const baseItem =
                      row.items[data.columns[baseColumnIndex].run_id];
                    return (
                      <td key={col.run_id} className="px-4 py-3 align-top">
                        {item ? (
                          <MatrixCell
                            item={item}
                            isBest={bestItemIds.has(item.run_item_id)}
                            onToggleBest={() => onToggleBest(item)}
                            onSaveConfig={() => onSaveConfig(item)}
                            onView={() => onViewItem(item)}
                            divergenceStatus={computeDivergence(item, baseItem)}
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

      {selectedDiffRow && (
        <DiffDetailPanel
          row={selectedDiffRow}
          columns={data.columns}
          baseColumnIndex={baseColumnIndex}
          onChangeBase={setBaseColumnIndex}
          onClose={() => setSelectedDiffRowIndex(null)}
          onPrev={goToPrev}
          onNext={goToNext}
          hasPrev={hasPrev}
          hasNext={hasNext}
          navigateMode={navigateMode}
          onToggleNavigateMode={() =>
            setNavigateMode((mode) =>
              mode === 'divergent' ? 'all' : 'divergent',
            )
          }
        />
      )}
    </div>
  );
}

interface DiffDetailPanelProps {
  row: CrossRunRow;
  columns: CrossRunColumn[];
  baseColumnIndex: number;
  onChangeBase: (index: number) => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  navigateMode: 'divergent' | 'all';
  onToggleNavigateMode: () => void;
}

type DiffTab = 'parsed' | 'raw' | 'reasoning';

function formatFieldValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function DiffDetailPanel({
  row,
  columns,
  baseColumnIndex,
  onChangeBase,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  navigateMode,
  onToggleNavigateMode,
}: DiffDetailPanelProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<DiffTab>('parsed');

  const baseColumn = columns[baseColumnIndex];
  const baseRunId = baseColumn?.run_id;
  const baseItem = baseRunId ? row.items[baseRunId] : undefined;

  const parsedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const col of columns) {
      const item = row.items[col.run_id];
      const parsed = item?.response?.parsed;
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        for (const key of Object.keys(parsed)) {
          keys.add(key);
        }
      }
    }
    return Array.from(keys).sort();
  }, [row, columns]);

  const getParsedValue = (item: RunItemSummary | undefined, key: string): unknown => {
    if (!item) return undefined;
    const parsed = item.response?.parsed;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>)[key];
  };

  const isStructured = (item: RunItemSummary | undefined): boolean => {
    if (!item) return false;
    const parsed = item.response?.parsed;
    return (
      parsed !== null &&
      parsed !== undefined &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    );
  };

  const tabs: { key: DiffTab; label: string; icon: typeof Plus }[] = [
    { key: 'parsed', label: t('compare.parsedFields'), icon: Columns3 },
    { key: 'raw', label: t('compare.rawText'), icon: AlignLeft },
    { key: 'reasoning', label: t('compare.reasoning'), icon: GitCompare },
  ];
  const sharedImages = getCrossRunImages(baseItem);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex h-[90vh] w-[90vw] max-w-[90vw] flex-col rounded-lg border border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
          <div className="flex items-center gap-3 text-sm font-semibold text-ink">
            <span className="font-mono text-xs text-ink-dim">{row.sample_id}</span>
            <select
              value={baseColumnIndex}
              onChange={(event) => onChangeBase(Number(event.target.value))}
              className="rounded border border-surface-700 bg-surface-950 px-2 py-1 text-xs text-ink outline-none focus:border-accent"
            >
              {columns.map((col, index) => (
                <option key={col.run_id} value={index}>
                  {t('compare.baseColumn')}: {col.task_name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onToggleNavigateMode}
              className="rounded border border-surface-700 px-2 py-1 text-xs text-ink transition-colors hover:bg-surface-800"
            >
              {navigateMode === 'divergent'
                ? t('compare.divergentSamples')
                : t('compare.allSamples')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onPrev}
              disabled={!hasPrev}
              className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1 text-xs text-ink transition-colors hover:bg-surface-800 disabled:opacity-40"
            >
              <ChevronLeft size={14} />
              {navigateMode === 'divergent'
                ? t('compare.previousDivergent')
                : t('compare.previous')}
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!hasNext}
              className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1 text-xs text-ink transition-colors hover:bg-surface-800 disabled:opacity-40"
            >
              {navigateMode === 'divergent'
                ? t('compare.nextDivergent')
                : t('compare.next')}
              <ChevronRight size={14} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
              aria-label={t('common.cancel')}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="border-b border-surface-800 px-4 py-2">
          {sharedImages.length > 0 && (
            <div className="mb-2 flex items-center gap-2 overflow-x-auto">
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-ink-dim">
                {t('batch.inputImages')}
              </span>
              {sharedImages.map((image, index) => (
                <img
                  key={`${image.uri}-${index}`}
                  src={resolveImageUrl(image.uri)}
                  alt={image.display_name || `${row.sample_id} ${index + 1}`}
                  title={image.display_name || image.role || ''}
                  className="h-12 w-12 shrink-0 rounded border border-surface-700 object-cover"
                />
              ))}
            </div>
          )}
          <div className="flex gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === tab.key
                    ? 'border-accent text-accent'
                    : 'border-transparent text-ink-muted hover:text-ink'
                }`}
              >
                <tab.icon size={14} />
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {activeTab === 'parsed' && (
            <div className="overflow-hidden rounded-md border border-surface-700">
              <div className="max-h-full overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-surface-900">
                    <tr className="border-b border-surface-700 text-ink-muted">
                      <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                        {t('task.inputSpec.kind')}
                      </th>
                      {columns.map((col, index) => (
                        <th
                          key={col.run_id}
                          className="px-4 py-3 font-semibold uppercase tracking-wider"
                        >
                          <div className={index === baseColumnIndex ? 'text-accent' : ''}>
                            {col.task_name}
                            {index === baseColumnIndex && (
                              <span className="ml-2 text-[10px] text-accent">
                                {t('compare.baseColumn')}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] font-normal normal-case text-ink-dim">
                            {col.model_id}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-800">
                    {parsedKeys.length === 0 ? (
                      <tr>
                        <td
                          colSpan={columns.length + 1}
                          className="px-4 py-8 text-center text-ink-dim"
                        >
                          {t('compare.noParse')}
                        </td>
                      </tr>
                    ) : (
                      parsedKeys.map((key) => (
                        <tr key={key} className="bg-surface-950">
                          <td className="whitespace-nowrap px-4 py-3 font-mono text-ink">
                            {key}
                          </td>
                          {columns.map((col, index) => {
                            const item = row.items[col.run_id];
                            const baseValue = getParsedValue(baseItem, key);
                            const value = getParsedValue(item, key);
                            const isBase = index === baseColumnIndex;

                            let cellContent: ReactNode;
                            if (!item) {
                              cellContent = (
                                <span className="text-ink-dim">—</span>
                              );
                            } else if (!isStructured(item)) {
                              cellContent = (
                                <span className="text-ink-dim">
                                  {t('compare.nonStructured')}
                                </span>
                              );
                            } else if (value === undefined) {
                              cellContent = (
                                <span className="text-ink-dim">—</span>
                              );
                            } else if (isBase) {
                              cellContent = (
                                <span className="whitespace-pre-wrap font-mono text-ink">
                                  {formatFieldValue(value)}
                                </span>
                              );
                            } else {
                              const equal =
                                JSON.stringify(value) ===
                                JSON.stringify(baseValue);
                              cellContent = (
                                <span
                                  className={
                                    equal ? 'text-emerald-400' : 'text-amber-400'
                                  }
                                >
                                  {equal ? '✓ ' : '⚠ '}
                                  <span className="whitespace-pre-wrap font-mono text-ink">
                                    {formatFieldValue(value)}
                                  </span>
                                </span>
                              );
                            }

                            return (
                              <td
                                key={col.run_id}
                                className="max-w-[20rem] px-4 py-3 align-top"
                              >
                                {cellContent}
                              </td>
                            );
                          })}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'raw' && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {columns.map((col) => {
                const item = row.items[col.run_id];
                const rawText = item ? extractRawText(item.response) : '';
                return (
                  <div
                    key={col.run_id}
                    className="flex flex-col rounded-md border border-surface-700 bg-surface-950"
                  >
                    <div className="border-b border-surface-800 px-3 py-2 text-xs font-semibold text-ink">
                      {col.task_name}
                      <span className="ml-2 text-[10px] text-ink-dim">
                        {col.model_id}
                      </span>
                      {col.run_id === baseRunId && (
                        <span className="ml-2 text-[10px] text-accent">
                          {t('compare.baseColumn')}
                        </span>
                      )}
                    </div>
                    <pre className="max-h-[60vh] flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-ink">
                      {item ? rawText || t('result.noRawOutput') : '—'}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === 'reasoning' && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {columns.map((col) => {
                const item = row.items[col.run_id];
                const reasoning = item ? extractReasoningText(item.response) : '';
                return (
                  <div
                    key={col.run_id}
                    className="flex flex-col rounded-md border border-surface-700 bg-surface-950"
                  >
                    <div className="border-b border-surface-800 px-3 py-2 text-xs font-semibold text-ink">
                      {col.task_name}
                      <span className="ml-2 text-[10px] text-ink-dim">
                        {col.model_id}
                      </span>
                      {col.run_id === baseRunId && (
                        <span className="ml-2 text-[10px] text-accent">
                          {t('compare.baseColumn')}
                        </span>
                      )}
                    </div>
                    <pre className="max-h-[60vh] flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-ink">
                      {item ? reasoning || t('result.noRawOutput') : '—'}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getCrossRunImages(item: RunItemSummary | undefined): Array<{
  uri: string;
  display_name?: string;
  role?: string;
}> {
  const images = item?.internal_request_snapshot?.images;
  if (!Array.isArray(images)) return [];
  return images.filter(
    (image): image is { uri: string; display_name?: string; role?: string } =>
      Boolean(image) &&
      typeof image === 'object' &&
      typeof (image as { uri?: unknown }).uri === 'string',
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

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function computeDivergence(
  item: RunItemSummary | undefined,
  baseItem: RunItemSummary | undefined,
): 'divergent' | 'consistent' | 'missing' | 'no_parse' {
  if (!item) return 'missing';
  if (!baseItem) return 'no_parse';
  const parsed = item.response?.parsed;
  const baseParsed = baseItem.response?.parsed;
  if (
    parsed === undefined ||
    parsed === null ||
    baseParsed === undefined ||
    baseParsed === null
  ) {
    return 'no_parse';
  }
  if (
    typeof parsed !== 'object' ||
    typeof baseParsed !== 'object' ||
    Array.isArray(parsed) ||
    Array.isArray(baseParsed)
  ) {
    return 'no_parse';
  }
  const keys = new Set([
    ...Object.keys(parsed as Record<string, unknown>),
    ...Object.keys(baseParsed as Record<string, unknown>),
  ]);
  for (const key of keys) {
    if (
      JSON.stringify((parsed as Record<string, unknown>)[key]) !==
      JSON.stringify((baseParsed as Record<string, unknown>)[key])
    ) {
      return 'divergent';
    }
  }
  return 'consistent';
}

function extractReasoningText(response: Record<string, unknown>): string {
  const reasoning = response.reasoning_text;
  if (typeof reasoning === 'string') return reasoning;
  const reasoning2 = response.reasoning;
  if (typeof reasoning2 === 'string') return reasoning2;
  const reasoning3 = response.__reasoning_text;
  if (typeof reasoning3 === 'string') return reasoning3;
  return '';
}
