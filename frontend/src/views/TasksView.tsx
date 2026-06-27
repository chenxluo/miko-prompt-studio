import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Copy,
  FileText,
  GitBranch,
  ImageIcon,
  Loader2,
  Plus,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  createTaskGroup,
  deleteTask,
  deleteTaskGroup,
  deleteTaskVersion,
  exportTaskDoc,
  forkTask,
  getTask,
  getTaskInputSpec,
  listResultSnapshots,
  listTaskGroups,
  listTaskVersionSnapshots,
  listTasks,
  updateResultSnapshot,
  updateTask,
  updateTaskGroup,
} from '../api/client';
import { TaskGroupFilter } from '../components/tasks/TaskGroupFilter';
import { TaskGroupManager } from '../components/tasks/TaskGroupManager';
import { TaskListCard } from '../components/tasks/TaskListCard';
import { useI18n } from '../i18n';
import { useLabStore } from '../store/labStore';
import type {
  ResultSnapshot,
  Task,
  TaskGroup,
  TaskInputSpec,
  TaskVersion,
  OutputContract,
  TaskVersionSnapshot,
} from '../types';

export function TasksView() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [groups, setGroups] = useState<TaskGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detail, setDetail] = useState<(Task & { versions: TaskVersion[] }) | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null | 'ungrouped'>(null);
  const [isGroupManagerOpen, setIsGroupManagerOpen] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [groupSaving, setGroupSaving] = useState(false);

  const providerConfigs = useLabStore((state) => state.providerConfigs);
  const loadProviderConfigs = useLabStore((state) => state.loadProviderConfigs);
  const loadTask = useLabStore((state) => state.loadTask);

  useEffect(() => {
    void loadProviderConfigs();
  }, [loadProviderConfigs]);

  useEffect(() => {
    void refreshTasks();
    void refreshGroups();
  }, []);

  useEffect(() => {
    if (!selectedTask) {
      setDetail(null);
      return;
    }
    setIsDetailLoading(true);
    setError(null);
    getTask(selectedTask.task_id)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : t('task.detailFailed')))
      .finally(() => setIsDetailLoading(false));
  }, [selectedTask, t]);

  const providerNames = useMemo(
    () => new Map(providerConfigs.map((config) => [config.provider_config_id, config.name])),
    [providerConfigs],
  );

  const filteredTasks = useMemo(() => {
    if (selectedGroupId === null) return tasks;
    if (selectedGroupId === 'ungrouped') return tasks.filter((task) => !task.group_id);
    return tasks.filter((task) => task.group_id === selectedGroupId);
  }, [tasks, selectedGroupId]);

  async function refreshTasks(groupId?: string | null) {
    setIsLoading(true);
    setError(null);
    try {
      setTasks(await listTasks(groupId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('task.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshGroups() {
    try {
      setGroups(await listTaskGroups());
    } catch {
      // Non-fatal: tasks still usable without groups.
    }
  }

  async function handleDelete(task: Task) {
    setDeletingId(task.task_id);
    setError(null);
    try {
      await deleteTask(task.task_id);
      setTasks((current) => current.filter((item) => item.task_id !== task.task_id));
      if (selectedTask?.task_id === task.task_id) {
        setSelectedTask(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('task.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleMoveTask(task: Task, groupId: string | null) {
    try {
      await updateTask(task.task_id, { group_id: groupId });
      setTasks((current) =>
        current.map((item) => (item.task_id === task.task_id ? { ...item, group_id: groupId } : item)),
      );
      if (selectedTask?.task_id === task.task_id) {
        setSelectedTask((current) => (current ? { ...current, group_id: groupId } : current));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('task.saveFailed'));
    }
  }

  async function handleSaveGroup(payload: {
    group_id?: string;
    name: string;
    description?: string;
    color?: string;
    sort_order?: number;
  }) {
    setGroupSaving(true);
    setGroupError(null);
    try {
      if (payload.group_id) {
        await updateTaskGroup(payload.group_id, payload);
      } else {
        await createTaskGroup(payload);
      }
      await refreshGroups();
      setIsGroupManagerOpen(false);
    } catch (err) {
      setGroupError(err instanceof Error ? err.message : t('task.saveFailed'));
    } finally {
      setGroupSaving(false);
    }
  }

  async function handleDeleteGroup(groupId: string) {
    if (!window.confirm(t('task.deleteGroupConfirm'))) return;
    setGroupError(null);
    try {
      await deleteTaskGroup(groupId);
      if (selectedGroupId === groupId) {
        setSelectedGroupId(null);
      }
      await refreshGroups();
      await refreshTasks(selectedGroupId === groupId ? null : selectedGroupId);
    } catch (err) {
      setGroupError(err instanceof Error ? err.message : t('task.deleteFailed'));
    }
  }

  async function handleLoad(task: Task, version?: TaskVersion) {
    await loadTask(task, version);
    window.dispatchEvent(new CustomEvent('miko:navigate', { detail: 'lab' }));
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="flex items-center justify-between border-b border-surface-800 bg-surface-900/50 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
            {t('task.title')}
          </h1>
          <p className="mt-1 text-xs text-ink-dim">{t('task.description')}</p>
        </div>
        <button
          type="button"
          onClick={() => setIsGroupManagerOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
        >
          <Tag size={14} />
          {t('task.manageGroups')}
        </button>
      </header>

      <TaskGroupFilter
        groups={groups}
        selectedGroupId={selectedGroupId}
        onSelect={setSelectedGroupId}
        allLabel={t('common.all')}
        ungroupedLabel={t('task.noGroup')}
      />

      <section className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-sm text-ink-muted">
            <Loader2 size={16} className="mr-2 animate-spin" />
            {t('task.loading')}
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
            {t('task.empty')}
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredTasks.map((task) => (
              <TaskListCard
                key={task.task_id}
                task={task}
                groups={groups}
                providerNames={providerNames}
                isDeleting={deletingId === task.task_id}
                onClick={() => setSelectedTask(task)}
                onDelete={() => void handleDelete(task)}
                onLoad={() => void handleLoad(task, task.current_version ?? undefined)}
                onMoveGroup={(groupId) => void handleMoveTask(task, groupId)}
              />
            ))}
          </div>
        )}
      </section>

      {selectedTask && (
        <TaskDetailDrawer
          task={selectedTask}
          detail={detail}
          isLoading={isDetailLoading}
          providerNames={providerNames}
          groups={groups}
          onClose={() => setSelectedTask(null)}
          onLoad={(version) => void handleLoad(selectedTask, version)}
          onDelete={() => void handleDelete(selectedTask)}
          onForkNavigate={(newTask) => {
            setSelectedTask(newTask);
            void refreshTasks();
          }}
          onMoveGroup={(groupId) => void handleMoveTask(selectedTask, groupId)}
          onVersionDeleted={() => {
            getTask(selectedTask.task_id)
              .then(setDetail)
              .catch((err) => setError(err instanceof Error ? err.message : t('task.detailFailed')));
          }}
        />
      )}

      {isGroupManagerOpen && (
        <TaskGroupManager
          groups={groups}
          error={groupError}
          saving={groupSaving}
          onClose={() => {
            setIsGroupManagerOpen(false);
            setGroupError(null);
          }}
          onSave={handleSaveGroup}
          onDelete={handleDeleteGroup}
        />
      )}
    </div>
  );
}


function TaskDetailDrawer({
  task,
  detail,
  isLoading,
  providerNames,
  groups,
  onClose,
  onLoad,
  onDelete,
  onForkNavigate,
  onMoveGroup,
  onVersionDeleted,
}: {
  task: Task;
  detail: (Task & { versions: TaskVersion[] }) | null;
  isLoading: boolean;
  providerNames: Map<string, string>;
  groups: TaskGroup[];
  onClose: () => void;
  onLoad: (version: TaskVersion) => void;
  onDelete: () => void;
  onForkNavigate: (task: Task) => void;
  onMoveGroup: (groupId: string | null) => void;
  onVersionDeleted: () => void;
}) {
  const { t } = useI18n();
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    task.current_version_id ?? task.current_version?.task_version_id ?? null,
  );
  const [viewLevel, setViewLevel] = useState<'task' | 'version'>('task');
  const [inputSpec, setInputSpec] = useState<TaskInputSpec | null>(null);
  const [isSpecLoading, setIsSpecLoading] = useState(false);
  const [specError, setSpecError] = useState<string | null>(null);
  const [exampleSnapshots, setExampleSnapshots] = useState<TaskVersionSnapshot[]>([]);
  const [isLoadingExamples, setIsLoadingExamples] = useState(false);
  const [selectedExample, setSelectedExample] = useState<TaskVersionSnapshot | null>(null);
  const [isHistoryPickerOpen, setIsHistoryPickerOpen] = useState(false);
  const [isForking, setIsForking] = useState(false);
  const [forkName, setForkName] = useState('');
  const [forkError, setForkError] = useState<string | null>(null);
  const [deletingVersionId, setDeletingVersionId] = useState<string | null>(null);
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [versionDeleteError, setVersionDeleteError] = useState<string | null>(null);
  const [isExportingDoc, setIsExportingDoc] = useState(false);
  const [exportDocError, setExportDocError] = useState<string | null>(null);

  const versions = detail?.versions ?? [];
  const selectedVersion =
    versions.find((version) => version.task_version_id === selectedVersionId) ??
    task.current_version ??
    versions[0];
  const handleExportDoc = async () => {
    if (!selectedVersion) return;
    setIsExportingDoc(true);
    setExportDocError(null);
    try {
      await exportTaskDoc(task.task_id, selectedVersion.task_version_id);
    } catch (err) {
      setExportDocError(err instanceof Error ? err.message : t('task.exportDocFailed'));
    } finally {
      setIsExportingDoc(false);
    }
  };

  useEffect(() => {
    setSelectedVersionId(task.current_version_id ?? task.current_version?.task_version_id ?? null);
    setViewLevel('task');
    setInputSpec(null);
    setSpecError(null);
    setIsSpecLoading(false);
    setDeletingVersionId(null);
    setShowMoveMenu(false);
    setVersionDeleteError(null);
  }, [task]);

  async function handleSelectVersion(version: TaskVersion) {
    setSelectedVersionId(version.task_version_id);
    setViewLevel('version');
    setSelectedExample(null);
    setInputSpec(null);
    setSpecError(null);
    setIsSpecLoading(true);
    setIsLoadingExamples(true);
    try {
      const [spec, snapshots] = await Promise.all([
        getTaskInputSpec(task.task_id, version.task_version_id),
        listTaskVersionSnapshots(task.task_id, version.task_version_id),
      ]);
      setInputSpec(spec);
      setExampleSnapshots(snapshots);
    } catch (err) {
      setSpecError(err instanceof Error ? err.message : t('task.inputSpec.loadFailed'));
      setExampleSnapshots([]);
    } finally {
      setIsSpecLoading(false);
      setIsLoadingExamples(false);
    }
  }

  async function handleDeleteVersion(version: TaskVersion) {
    if (!window.confirm(t('task.versionDeleteConfirm'))) return;
    setDeletingVersionId(version.task_version_id);
    setVersionDeleteError(null);
    try {
      await deleteTaskVersion(task.task_id, version.task_version_id);
      onVersionDeleted();
      if (task.current_version_id === version.task_version_id) {
        const remaining = detail?.versions.filter(
          (v) => v.task_version_id !== version.task_version_id,
        );
        if (remaining && remaining.length > 0) {
          setSelectedVersionId(remaining[remaining.length - 1].task_version_id);
        }
      }
    } catch (err) {
      setVersionDeleteError(err instanceof Error ? err.message : t('task.versionDeleteFailed'));
    } finally {
      setDeletingVersionId(null);
    }
  }

  function handleBackToTask() {
    setViewLevel('task');
    setSelectedExample(null);
    setExampleSnapshots([]);
    setForkName('');
    setForkError(null);
  }

  async function handleFork() {
    if (!selectedVersion || !task) return;
    const trimmed = forkName.trim();
    if (!trimmed) {
      setForkError(t('task.nameRequired'));
      return;
    }
    setIsForking(true);
    setForkError(null);
    try {
      const newTask = await forkTask(task.task_id, {
        source_version_id: selectedVersion.task_version_id,
        name: trimmed,
      });
      onForkNavigate(newTask);
      setForkName('');
    } catch (err) {
      setForkError(err instanceof Error ? err.message : t('task.forkFailed'));
    } finally {
      setIsForking(false);
    }
  }

  function handleAddExampleFromHistory() {
    setIsHistoryPickerOpen(true);
  }

  function handleSelectExample(snapshot: TaskVersionSnapshot) {
    setSelectedExample(snapshot);
  }

  function handleBackToVersion() {
    setSelectedExample(null);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-surface-950/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {viewLevel === 'version' && (
        <div
          className="hidden lg:flex h-full w-[520px] animate-fade-in flex-col border-r border-surface-700 bg-surface-900 shadow-panel"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-3 py-2.5">
            <span className="text-xs font-semibold text-ink">{t('task.runExamples')}</span>
            <button
              type="button"
              onClick={() => void handleAddExampleFromHistory()}
              className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1 text-[10px] text-ink-muted transition-colors hover:border-accent/50 hover:text-accent"
              title={t('task.addExampleFromHistory')}
            >
              <Plus size={12} />
              {t('task.addExampleFromHistory')}
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
            {isLoadingExamples ? (
              <div className="flex h-20 items-center justify-center text-xs text-ink-muted">
                <Loader2 size={14} className="mr-2 animate-spin" />
                {t('task.loading')}
              </div>
            ) : exampleSnapshots.length === 0 ? (
              <div className="rounded-md border border-dashed border-surface-700 p-4 text-center text-xs text-ink-dim">
                {t('task.noRunExamples')}
              </div>
            ) : (
              exampleSnapshots.map((snapshot) => (
                <ExampleSnapshotCard
                  key={snapshot.snapshot_id}
                  snapshot={snapshot}
                  isSelected={selectedExample?.snapshot_id === snapshot.snapshot_id}
                  onSelect={handleSelectExample}
                />
              ))
            )}
          </div>
        </div>
      )}

      <div
        className="flex h-full w-full max-w-2xl animate-fade-in flex-col border-l border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-4 py-3">
          <div className="flex items-center gap-2">
            {selectedExample ? (
              <>
                <button
                  type="button"
                  onClick={handleBackToVersion}
                  className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
                >
                  <ArrowLeft size={16} />
                </button>
                <span className="text-sm font-semibold text-ink">
                  {t('task.example.detailTitle')}: {selectedExample.name || t('task.untitled')}
                </span>
              </>
            ) : viewLevel === 'version' ? (
              <>
                <button
                  type="button"
                  onClick={handleBackToTask}
                  className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
                >
                  <ArrowLeft size={16} />
                </button>
                <FileText size={16} className="text-accent" />
                <span className="text-sm font-semibold text-ink">
                  {selectedVersion?.version_label ||
                    selectedVersion?.task_version_id ||
                    t('task.untitled')}
                </span>
              </>
            ) : (
              <>
                <BookOpen size={16} className="text-accent" />
                <span className="text-sm font-semibold text-ink">{task.name}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {viewLevel === 'version' && !selectedExample && inputSpec && selectedVersion && (
              <CopyAllButton
                text={formatFullDocument(inputSpec, task.name, selectedVersion.version_label ?? '')}
              />
            )}
            {viewLevel === 'version' && !selectedExample && selectedVersion && (
              <button
                type="button"
                onClick={() => void handleExportDoc()}
                disabled={isExportingDoc}
                className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1.5 text-xs text-ink-muted hover:bg-surface-800 hover:text-ink disabled:opacity-50"
                title={t('task.exportDoc')}
              >
                {isExportingDoc ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
                {t('task.exportDoc')}
              </button>
            )}
            {exportDocError && (
              <span className="text-xs text-danger">{exportDocError}</span>
            )}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowMoveMenu((prev) => !prev)}
                className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1.5 text-xs text-ink-muted hover:bg-surface-800 hover:text-ink"
              >
                <Tag size={12} />
                {groups.find((g) => g.group_id === task.group_id)?.name ?? t('task.noGroup')}
              </button>
              {showMoveMenu && (
                <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-surface-700 bg-surface-900 py-1 shadow-xl">
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
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-auto p-4">
          {viewLevel === 'task' ? (
            <>
              {task.description && <p className="text-xs text-ink-muted">{task.description}</p>}

              {task.tags && task.tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Tag size={12} className="text-ink-dim" />
                  {task.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-ink-muted"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                  {t('task.versions')}
                </h3>
                {versionDeleteError && (
                  <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                    {versionDeleteError}
                  </div>
                )}
                {isLoading ? (
                  <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
                    <Loader2 size={14} className="mr-2 animate-spin" />
                    {t('task.loadingVersions')}
                  </div>
                ) : versions.length === 0 ? (
                  <div className="rounded-md border border-surface-800 bg-surface-950 p-3 text-xs text-ink-dim">
                    {t('task.noVersions')}
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {versions.map((version) => (
                      <li
                        key={version.task_version_id}
                        className={`cursor-pointer rounded-md border p-3 transition-colors ${
                          selectedVersion?.task_version_id === version.task_version_id
                            ? 'border-accent/50 bg-accent/5'
                            : 'border-surface-800 bg-surface-950 hover:border-surface-700'
                        }`}
                        onClick={() => void handleSelectVersion(version)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-ink">
                              {version.version_label || version.task_version_id}
                            </span>
                            {version.task_version_id === task.current_version_id && (
                              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                                {t('task.currentVersion')}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {version.notes && (
                              <span className="truncate text-right text-[10px] text-ink-dim" title={version.notes}>
                                {version.notes}
                              </span>
                            )}
                            {versions.length > 1 && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleDeleteVersion(version);
                                }}
                                disabled={deletingVersionId === version.task_version_id}
                                className="inline-flex items-center justify-center rounded p-1 text-ink-dim transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                                title={t('task.versionDelete')}
                              >
                                {deletingVersionId === version.task_version_id ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : (
                                  <Trash2 size={12} />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-dim">
                          <span>
                            {t('task.model')}: {version.model_id}
                          </span>
                          <span>
                            {t('task.providerConfig')}:{' '}
                            {version.provider_config_id
                              ? providerNames.get(version.provider_config_id) ??
                                version.provider_config_id
                              : '—'}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : selectedExample ? (
            <ExampleDetailView
              snapshot={selectedExample}
              onBack={handleBackToVersion}
              providerNames={providerNames}
            />
          ) : selectedVersion ? (
            <VersionDetailView
              version={selectedVersion}
              inputSpec={inputSpec}
              isSpecLoading={isSpecLoading}
              specError={specError}
              providerNames={providerNames}
            />
          ) : null}
        </div>

        {forkName !== '' && !isForking && (
          <div className="border-t border-surface-800 px-4 py-3">
            {forkError && <p className="mb-2 text-xs text-danger">{forkError}</p>}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={forkName}
                onChange={(e) => setForkName(e.target.value)}
                placeholder={t('task.name')}
                autoFocus
                className="flex-1 rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handleFork()}
                className="btn-primary px-3 py-2 text-xs"
              >
                {t('task.forkConfirm')}
              </button>
              <button
                type="button"
                onClick={() => { setForkName(''); setForkError(null); }}
                className="rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        <div className="flex shrink-0 gap-2 border-t border-surface-800 px-4 py-3">
          <button
            type="button"
            onClick={() => selectedVersion && onLoad(selectedVersion)}
            disabled={!selectedVersion}
            className="btn-primary inline-flex items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-50"
          >
            <Upload size={12} />
            {t('task.loadIntoLab')}
          </button>
          {viewLevel === 'task' ? (
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-danger/50 hover:text-danger"
            >
              <Trash2 size={12} />
              {t('task.delete')}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleBackToTask}
              className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:bg-surface-800"
            >
              <ArrowLeft size={12} />
              {t('task.backToTask')}
            </button>
          )}
          {viewLevel === 'version' && !isForking && (
            <button
              type="button"
              onClick={() => {
                setForkName(
                  selectedVersion?.version_label
                    ? `${task.name} (${selectedVersion.version_label})`
                    : `${task.name} (fork)`,
                );
                setForkError(null);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-accent/50 hover:text-accent"
            >
              <GitBranch size={12} />
              {t('task.fork')}
            </button>
          )}
        </div>
      </div>

      {isHistoryPickerOpen && selectedVersion && (
        <SnapshotLinkPickerModal
          taskVersionId={selectedVersion.task_version_id}
          onClose={() => setIsHistoryPickerOpen(false)}
          onLinked={async () => {
            setIsLoadingExamples(true);
            try {
              const snapshots = await listTaskVersionSnapshots(
                task.task_id,
                selectedVersion.task_version_id,
              );
              setExampleSnapshots(snapshots);
            } catch {
              setExampleSnapshots([]);
            } finally {
              setIsLoadingExamples(false);
            }
          }}
        />
      )}
    </div>
  );
}

function VersionDetailView({
  version,
  inputSpec,
  isSpecLoading,
  specError,
  providerNames,
}: {
  version: TaskVersion;
  inputSpec: TaskInputSpec | null;
  isSpecLoading: boolean;
  specError: string | null;
  providerNames: Map<string, string>;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      {specError && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {specError}
        </div>
      )}

      <div className="space-y-2">
        <SectionTitle icon={<TerminalIcon />} label={t('task.inputSpec.prompts')} />
        {isSpecLoading ? (
          <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
            <Loader2 size={14} className="mr-2 animate-spin" />
            {t('task.inputSpec.loading')}
          </div>
        ) : inputSpec ? (
          <>
            <CollapsibleCodeBlock
              label={t('prompt.systemPrompt')}
              value={inputSpec.system_prompt}
            />
            <CollapsibleCodeBlock
              label={t('prompt.userTemplate')}
              value={inputSpec.user_template}
            />
          </>
        ) : (
          <div className="flex h-24 items-center justify-center text-xs text-ink-dim">
            {t('task.inputSpec.empty')}
          </div>
        )}
      </div>

      <SpecSection title={t('prompt.imageSlotSpecs')}>
        {(version.image_slot_specs?.length ?? 0) === 0 ? (
          <p className="text-xs text-ink-dim">{t('prompt.noImageSlots')}</p>
        ) : (
          <div className="overflow-auto rounded-md border border-surface-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-950 text-ink-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('task.inputSpec.slotId')}</th>
                  <th className="px-3 py-2 font-medium">{t('task.inputSpec.label')}</th>
                  <th className="px-3 py-2 font-medium">{t('task.inputSpec.description')}</th>
                  <th className="px-3 py-2 font-medium">{t('prompt.required')}</th>
                  <th className="px-3 py-2 font-medium">{t('prompt.minCount')}</th>
                  <th className="px-3 py-2 font-medium">{t('prompt.maxCount')}</th>
                  <th className="px-3 py-2 font-medium">{t('prompt.roleHint')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {version.image_slot_specs?.map((slot) => (
                  <tr key={slot.slot_id} className="text-ink">
                    <td className="px-3 py-2 font-mono text-ink-muted">{slot.slot_id}</td>
                    <td className="px-3 py-2">{slot.label ?? '—'}</td>
                    <td className="px-3 py-2 text-ink-dim">{slot.description ?? '—'}</td>
                    <td className="px-3 py-2">
                      {slot.required ? (
                        <span className="rounded bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger">
                          {t('prompt.required')}
                        </span>
                      ) : (
                        <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-ink-muted">
                          {t('prompt.optional')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">{slot.min_count ?? '—'}</td>
                    <td className="px-3 py-2">{slot.max_count ?? t('prompt.unlimited')}</td>
                    <td className="px-3 py-2 font-mono text-ink-muted">{slot.role_hint ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SpecSection>

      <SpecSection title={t('prompt.variableSpecs')}>
        {(version.variable_specs?.length ?? 0) === 0 ? (
          <p className="text-xs text-ink-dim">{t('prompt.noVariables')}</p>
        ) : (
          <div className="overflow-auto rounded-md border border-surface-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-950 text-ink-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('task.inputSpec.varId')}</th>
                  <th className="px-3 py-2 font-medium">{t('task.inputSpec.label')}</th>
                  <th className="px-3 py-2 font-medium">{t('task.inputSpec.description')}</th>
                  <th className="px-3 py-2 font-medium">{t('prompt.required')}</th>
                  <th className="px-3 py-2 font-medium">{t('task.inputSpec.type')}</th>
                  <th className="px-3 py-2 font-medium">{t('prompt.variableDefaultValue')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {version.variable_specs?.map((variable) => (
                  <tr key={variable.var_id} className="text-ink">
                    <td className="px-3 py-2 font-mono text-ink-muted">{variable.var_id}</td>
                    <td className="px-3 py-2">{variable.label ?? '—'}</td>
                    <td className="px-3 py-2 text-ink-dim">{variable.description ?? '—'}</td>
                    <td className="px-3 py-2">
                      {variable.required ? (
                        <span className="rounded bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger">
                          {t('prompt.required')}
                        </span>
                      ) : (
                        <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-ink-muted">
                          {t('prompt.optional')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-ink-muted">{variable.type ?? '—'}</td>
                    <td className="px-3 py-2 text-ink-dim">{variable.default_value ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SpecSection>

      <SpecSection title={t('task.modelConfig')}>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between border-b border-surface-800 py-1.5">
            <span className="text-ink-muted">{t('task.model')}</span>
            <span className="font-mono text-ink">{version.model_id}</span>
          </div>
          <div className="flex justify-between border-b border-surface-800 py-1.5">
            <span className="text-ink-muted">{t('task.providerConfig')}</span>
            <span className="text-ink">
              {version.provider_config_id
                ? providerNames.get(version.provider_config_id) ?? version.provider_config_id
                : '—'}
            </span>
          </div>
          <ModelParametersView parameters={version.model_parameters} />
        </div>
      </SpecSection>

      <SpecSection title={t('task.outputContract')}>
        <OutputContractView contract={version.output_contract} />
      </SpecSection>

      <SpecSection title={t('task.inputSpec.expectedCsvColumns')}>
        {isSpecLoading ? (
          <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
            <Loader2 size={14} className="mr-2 animate-spin" />
            {t('task.inputSpec.loading')}
          </div>
        ) : inputSpec ? (
          inputSpec.expected_csv_columns.length === 0 ? (
            <p className="text-xs text-ink-dim">{t('task.inputSpec.noExpectedCsvColumns')}</p>
          ) : (
            <div className="overflow-auto rounded-md border border-surface-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-surface-950 text-ink-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('task.inputSpec.column')}</th>
                    <th className="px-3 py-2 font-medium">{t('task.inputSpec.kind')}</th>
                    <th className="px-3 py-2 font-medium">{t('prompt.roleHint')}</th>
                    <th className="px-3 py-2 font-medium">{t('task.inputSpec.varId')}</th>
                    <th className="px-3 py-2 font-medium">{t('prompt.required')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-800">
                  {inputSpec.expected_csv_columns.map((column) => (
                    <tr key={column.column} className="text-ink">
                      <td className="px-3 py-2 font-mono text-ink-muted">{column.column}</td>
                      <td className="px-3 py-2">{column.kind}</td>
                      <td className="px-3 py-2 font-mono text-ink-muted">
                        {column.role_hint ?? '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-ink-muted">
                        {column.var_id ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        {column.required ? (
                          <span className="rounded bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger">
                            {t('prompt.required')}
                          </span>
                        ) : (
                          <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-ink-muted">
                            {t('prompt.optional')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <p className="text-xs text-ink-dim">{t('task.inputSpec.empty')}</p>
        )}
      </SpecSection>

      <SpecSection title={t('task.inputSpec.csvExample')}>
        {isSpecLoading ? (
          <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
            <Loader2 size={14} className="mr-2 animate-spin" />
            {t('task.inputSpec.loading')}
          </div>
        ) : inputSpec ? (
          <CopyCodeBlock value={formatCsvRow(inputSpec.csv_example_row)} />
        ) : (
          <p className="text-xs text-ink-dim">{t('task.inputSpec.empty')}</p>
        )}
      </SpecSection>

      <SpecSection title={t('task.inputSpec.jsonlExample')}>
        {isSpecLoading ? (
          <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
            <Loader2 size={14} className="mr-2 animate-spin" />
            {t('task.inputSpec.loading')}
          </div>
        ) : inputSpec ? (
          <CopyCodeBlock value={formatJsonlExample(inputSpec.jsonl_example)} />
        ) : (
          <p className="text-xs text-ink-dim">{t('task.inputSpec.empty')}</p>
        )}
      </SpecSection>

      {version.notes && (
        <SpecSection title={t('task.inputSpec.notes')}>
          <p className="whitespace-pre-wrap text-xs text-ink-muted">{version.notes}</p>
        </SpecSection>
      )}
    </div>
  );
}

function ModelParametersView({
  parameters,
}: {
  parameters?: TaskVersion['model_parameters'];
}) {
  const { t } = useI18n();

  if (!parameters) {
    return (
      <div className="flex justify-between border-b border-surface-800 py-1.5">
        <span className="text-ink-muted">{t('model.parameters')}</span>
        <span className="text-ink">—</span>
      </div>
    );
  }

  const entries: { key: string; value: React.ReactNode }[] = [];
  if (parameters.temperature !== null && parameters.temperature !== undefined) {
    entries.push({ key: t('model.temperature'), value: parameters.temperature });
  }
  if (parameters.max_output_tokens !== null && parameters.max_output_tokens !== undefined) {
    entries.push({ key: t('model.maxOutputTokens'), value: parameters.max_output_tokens });
  }
  if (parameters.top_p !== null && parameters.top_p !== undefined) {
    entries.push({ key: t('model.topP'), value: parameters.top_p });
  }
  if (parameters.stream !== null && parameters.stream !== undefined) {
    entries.push({
      key: t('model.streaming'),
      value: parameters.stream ? t('common.yes') : t('common.no'),
    });
  }
  if (parameters.enable_thinking !== null && parameters.enable_thinking !== undefined) {
    entries.push({
      key: t('model.enableThinking'),
      value: parameters.enable_thinking ? t('common.yes') : t('common.no'),
    });
  }

  if (entries.length === 0) {
    return (
      <div className="flex justify-between border-b border-surface-800 py-1.5">
        <span className="text-ink-muted">{t('model.parameters')}</span>
        <span className="text-ink">—</span>
      </div>
    );
  }

  return (
    <>
      {entries.map(({ key, value }) => (
        <div key={key} className="flex justify-between border-b border-surface-800 py-1.5">
          <span className="text-ink-muted">{key}</span>
          <span className="font-mono text-ink">{value}</span>
        </div>
      ))}
    </>
  );
}

function readOutputContractSectionNames(contract: OutputContract): string[] {
  if (contract.mode !== 'soft_sections') return [];
  const options = contract.parser?.options;
  if (!options) return [];
  const raw = options.section_names ?? options.sections;
  if (!Array.isArray(raw)) return [];
  return raw.filter((name): name is string => typeof name === 'string');
}

function OutputContractView({ contract }: { contract?: TaskVersion['output_contract'] }) {
  const { t } = useI18n();

  if (!contract) {
    return <p className="text-xs text-ink-dim">—</p>;
  }

  const sectionNames = readOutputContractSectionNames(contract);

  return (
    <div className="space-y-2 text-xs">
      <div className="flex justify-between border-b border-surface-800 py-1.5">
        <span className="text-ink-muted">{t('prompt.outputMode')}</span>
        <span className="text-ink">{contract.mode ?? '—'}</span>
      </div>
      {sectionNames.length > 0 && (
        <div className="space-y-1">
          <span className="text-ink-muted">{t('task.outputContractSectionNames')}</span>
          <div className="flex flex-wrap gap-1">
            {sectionNames.map((name) => (
              <code key={name} className="rounded bg-surface-800 px-1.5 py-0.5 text-ink">
                {name}
              </code>
            ))}
          </div>
        </div>
      )}
      {contract.json_schema && (
        <div className="space-y-1">
          <span className="text-ink-muted">{t('prompt.jsonSchema')}</span>
          <pre className="overflow-auto rounded-md border border-surface-800 bg-surface-950 p-2 font-mono text-ink">
            {JSON.stringify(contract.json_schema, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ExampleSnapshotCard({
  snapshot,
  isSelected,
  onSelect,
}: {
  snapshot: TaskVersionSnapshot;
  isSelected: boolean;
  onSelect: (snapshot: TaskVersionSnapshot) => void;
}) {
  const { t } = useI18n();
  const images = getSnapshotImages(snapshot);
  const vars = getSnapshotVars(snapshot);
  const varEntries = Object.entries(vars);
  const tokens = getTokenCount(snapshot);
  const statusIcon = getStatusIcon(snapshot.run_item_status);

  return (
    <div
      onClick={() => onSelect(snapshot)}
      className={`flex h-[280px] w-full cursor-pointer flex-col rounded-md border transition-colors ${
        isSelected
          ? 'border-accent/50 bg-accent/5'
          : 'border-surface-800 bg-surface-950 hover:border-surface-700'
      }`}
    >
      <div className="shrink-0 space-y-2 p-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          {t('task.example.input')}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 overflow-x-auto pb-1">
            {images.length === 0 ? (
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-surface-800 bg-surface-900">
                <ImageIcon size={16} className="text-ink-dim" />
              </div>
            ) : (
              images.slice(0, 4).map((image, index) => (
                <img
                  key={index}
                  src={image.uri || ''}
                  alt={image.display_name || ''}
                  className="h-16 w-16 shrink-0 rounded-md border border-surface-800 object-cover"
                />
              ))
            )}
            {images.length > 4 && (
              <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-surface-800 bg-surface-900 text-[10px] text-ink-muted">
                +{images.length - 4}
              </span>
            )}
          </div>
          <span className="shrink-0 text-[10px] text-ink-dim">
            {images.length > 0
              ? t('task.example.images', { n: images.length })
              : t('task.example.noImages')}
          </span>
        </div>
        {varEntries.length > 0 && (
          <p className="truncate text-[10px] text-ink-muted">
            <span className="text-ink-dim">{t('task.example.vars')}: </span>
            {varEntries.map(([key, value]) => `${key}=${value}`).join(', ')}
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-surface-800" />

      <div className="flex min-h-0 flex-1 flex-col p-3">
        <span className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          {t('task.example.response')}
        </span>
        <div
          className="min-h-0 flex-1 overflow-y-auto rounded-md border border-surface-800 bg-surface-900 p-2 font-mono text-xs whitespace-pre-wrap text-ink"
          onClick={(event) => event.stopPropagation()}
        >
          {snapshot.response_text ? (
            snapshot.response_text
          ) : (
            <span className="text-ink-dim">{t('task.example.noResponse')}</span>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-surface-800" />

      <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-[10px] text-ink-dim">
        <span className="truncate text-ink">{snapshot.model_id || '—'}</span>
        <span>·</span>
        <span>{tokens !== null ? `${tokens} tok` : '—'}</span>
        <span>·</span>
        <span>{formatLatency(snapshot.latency_ms)}</span>
        <span>·</span>
        <span
          className={
            snapshot.run_item_status === 'succeeded'
              ? 'text-accent'
              : snapshot.run_item_status === 'failed'
                ? 'text-danger'
                : 'text-ink-dim'
          }
        >
          {statusIcon}
        </span>
      </div>
    </div>
  );
}

function ExampleDetailView({
  snapshot,
  onBack,
  providerNames,
}: {
  snapshot: TaskVersionSnapshot;
  onBack: () => void;
  providerNames: Map<string, string>;
}) {
  const { t } = useI18n();
  const images = getSnapshotImages(snapshot);
  const vars = getSnapshotVars(snapshot);
  const tokens = getTokenCount(snapshot);
  const usage = snapshot.usage ?? {};
  const inputTokens =
    typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
  const outputTokens =
    typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
  const statusIcon = getStatusIcon(snapshot.run_item_status);

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-xs text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft size={14} />
        {t('task.example.back')}
      </button>

      <SpecSection title={t('task.example.input')}>
        {images.length === 0 ? (
          <div className="flex h-32 w-32 items-center justify-center rounded-md border border-surface-800 bg-surface-900">
            <ImageIcon size={24} className="text-ink-dim" />
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {images.map((image, index) => (
              <img
                key={index}
                src={image.uri || ''}
                alt={image.display_name || ''}
                className="h-32 w-32 rounded-md border border-surface-800 object-cover"
              />
            ))}
          </div>
        )}
        <div className="mt-3">
          <h5 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            {t('task.example.vars')}
          </h5>
          {Object.entries(vars).length === 0 ? (
            <p className="mt-1 text-xs text-ink-dim">{t('task.example.noVars')}</p>
          ) : (
            <div className="mt-1 grid gap-1 text-xs">
              {Object.entries(vars).map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <span className="font-mono text-ink-muted">{key}</span>
                  <span className="text-ink">=</span>
                  <span className="font-mono text-ink">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </SpecSection>

      <SpecSection title={t('task.example.response')}>
        <pre className="max-h-96 overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs whitespace-pre-wrap text-ink">
          {snapshot.response_text || t('task.example.noResponse')}
        </pre>
      </SpecSection>

      {snapshot.parsed_output !== undefined && snapshot.parsed_output !== null && (
        <SpecSection title={t('task.example.parsed')}>
          <pre className="max-h-96 overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
            {JSON.stringify(snapshot.parsed_output, null, 2)}
          </pre>
        </SpecSection>
      )}

      {snapshot.reasoning_text && (
        <CollapsibleCodeBlock
          label={t('task.example.reasoning')}
          value={snapshot.reasoning_text}
        />
      )}

      <SpecSection title={t('task.example.meta')}>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between border-b border-surface-800 py-1.5">
            <span className="text-ink-muted">{t('task.example.provider')}</span>
            <span className="text-ink">
              {snapshot.provider_id
                ? providerNames.get(snapshot.provider_id) ?? snapshot.provider_id
                : '—'}
            </span>
          </div>
          <div className="flex justify-between border-b border-surface-800 py-1.5">
            <span className="text-ink-muted">{t('task.model')}</span>
            <span className="font-mono text-ink">{snapshot.model_id || '—'}</span>
          </div>
          <div className="flex justify-between border-b border-surface-800 py-1.5">
            <span className="text-ink-muted">{t('task.example.tokens')}</span>
            <span className="font-mono text-ink">
              {inputTokens !== null && outputTokens !== null
                ? `${inputTokens}→${outputTokens} (total: ${tokens ?? '—'})`
                : tokens !== null
                  ? `${tokens}`
                  : '—'}
            </span>
          </div>
          <div className="flex justify-between border-b border-surface-800 py-1.5">
            <span className="text-ink-muted">{t('task.example.latency')}</span>
            <span className="font-mono text-ink">
              {snapshot.latency_ms !== null && snapshot.latency_ms !== undefined
                ? `${snapshot.latency_ms}ms`
                : '—'}
            </span>
          </div>
          <div className="flex justify-between border-b border-surface-800 py-1.5">
            <span className="text-ink-muted">{t('task.example.status')}</span>
            <span className="flex items-center gap-1 font-mono text-ink">
              <span
                className={
                  snapshot.run_item_status === 'succeeded'
                    ? 'text-accent'
                    : snapshot.run_item_status === 'failed'
                      ? 'text-danger'
                      : 'text-ink-dim'
                }
              >
                {statusIcon}
              </span>
              {snapshot.run_item_status || '—'}
            </span>
          </div>
          <div className="flex justify-between border-b border-surface-800 py-1.5">
            <span className="text-ink-muted">{t('task.example.created')}</span>
            <span className="text-ink">{formatTime(snapshot.created_at)}</span>
          </div>
        </div>
      </SpecSection>
    </div>
  );
}

function getSnapshotImages(snapshot: TaskVersionSnapshot): SnapshotImage[] {
  const request = snapshot.internal_request_snapshot;
  if (!request || typeof request !== 'object') return [];
  const rawImages = request.images;
  if (!Array.isArray(rawImages)) return [];
  return rawImages.filter(
    (item): item is SnapshotImage =>
      item !== null && typeof item === 'object',
  );
}

function getSnapshotVars(snapshot: TaskVersionSnapshot): Record<string, string> {
  const request = snapshot.internal_request_snapshot;
  if (!request || typeof request !== 'object') return {};
  const prompt = request.prompt;
  if (!prompt || typeof prompt !== 'object') return {};
  const renderContext = (prompt as Record<string, unknown>).render_context;
  if (!renderContext || typeof renderContext !== 'object') return {};
  const rawVars = (renderContext as Record<string, unknown>).vars;
  if (!rawVars || typeof rawVars !== 'object' || Array.isArray(rawVars)) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawVars)) {
    result[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return result;
}

function getTokenCount(snapshot: TaskVersionSnapshot): number | null {
  const usage = snapshot.usage;
  if (!usage || typeof usage !== 'object') return null;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  const input =
    typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
  const output =
    typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
  if (input !== null && output !== null) return input + output;
  return input ?? output ?? null;
}

function formatLatency(ms?: number | null): string {
  if (ms === null || ms === undefined) return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

function getStatusIcon(status?: string | null): string {
  switch (status) {
    case 'succeeded':
      return '✓';
    case 'failed':
      return '✗';
    case 'pending':
    case 'running':
      return '○';
    default:
      return '—';
  }
}

interface SnapshotImage {
  uri?: string;
  display_name?: string;
  role?: string;
}

function SnapshotLinkPickerModal({
  taskVersionId,
  onClose,
  onLinked,
}: {
  taskVersionId: string;
  onClose: () => void;
  onLinked: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [snapshots, setSnapshots] = useState<ResultSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLinking, setIsLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    // List snapshots not yet linked to this task version
    listResultSnapshots({ limit: 100 })
      .then((all) => {
        setSnapshots(all.filter((s) => s.linked_task_version_id !== taskVersionId));
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('snapshot.loadFailed')))
      .finally(() => setIsLoading(false));
  }, [taskVersionId, t]);

  async function handleLink(snapshot: ResultSnapshot) {
    setIsLinking(snapshot.snapshot_id);
    setError(null);
    try {
      await updateResultSnapshot(snapshot.snapshot_id, {
        linked_task_version_id: taskVersionId,
      });
      await onLinked();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('snapshot.linkFailed'));
    } finally {
      setIsLinking(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-4 py-3">
          <span className="text-sm font-semibold text-ink">{t('task.selectSnapshotToLink')}</span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {error && (
            <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex h-32 items-center justify-center text-xs text-ink-muted">
              <Loader2 size={14} className="mr-2 animate-spin" />
              {t('snapshot.loading')}
            </div>
          ) : snapshots.length === 0 ? (
            <p className="py-8 text-center text-xs text-ink-dim">{t('task.noUnlinkedSnapshots')}</p>
          ) : (
            <ul className="space-y-2">
              {snapshots.map((snapshot) => (
                <li
                  key={snapshot.snapshot_id}
                  className="flex items-center justify-between rounded-md border border-surface-800 bg-surface-950 p-3"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    {snapshot.thumbnail_image_uri ? (
                      <img
                        src={snapshot.thumbnail_image_uri}
                        alt={snapshot.name}
                        className="h-10 w-10 shrink-0 rounded-md border border-surface-800 object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-surface-800 bg-surface-900">
                        <ImageIcon size={14} className="text-ink-dim" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-ink">
                        {snapshot.name || t('task.untitled')}
                      </p>
                      {snapshot.description && (
                        <p className="truncate text-[10px] text-ink-dim">{snapshot.description}</p>
                      )}
                      <p className="mt-0.5 text-[10px] text-ink-muted">
                        {snapshot.provider_id ?? '—'} · {snapshot.model_id ?? '—'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleLink(snapshot)}
                    disabled={isLinking === snapshot.snapshot_id}
                    className="btn-primary shrink-0 px-2.5 py-1.5 text-[10px] disabled:opacity-50"
                  >
                    {isLinking === snapshot.snapshot_id ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      t('task.linkSnapshot')
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function SpecSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-muted">
        {title}
      </h4>
      {children}
    </div>
  );
}

function SectionTitle({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-muted">
      {icon}
      {label}
    </div>
  );
}

function TerminalIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-accent"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function CopyCodeBlock({ value }: { value: string }) {
  return (
    <pre className="overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
      {value}
    </pre>
  );
}

function CollapsibleCodeBlock({ label, value }: { label: string; value: string }) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="overflow-hidden rounded-md border border-surface-800">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between bg-surface-950 px-3 py-2 text-left transition-colors hover:bg-surface-900"
      >
        <span className="text-xs font-medium text-ink-muted">{label}</span>
        <ChevronDown
          size={14}
          className={`text-ink-dim transition-transform ${isExpanded ? 'rotate-180' : ''}`}
        />
      </button>
      {isExpanded && (
        <pre className="max-h-64 overflow-auto border-t border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
          {value || '—'}
        </pre>
      )}
    </div>
  );
}

function CopyAllButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    try {
      await copyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore copy failures.
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-900 px-3 py-1.5 text-xs text-ink-muted transition-colors hover:border-accent/50 hover:text-accent"
    >
      <Copy size={12} />
      {copied ? t('task.inputSpec.copied') : t('task.inputSpec.copyAll')}
    </button>
  );
}

function formatFullDocument(
  spec: TaskInputSpec,
  taskName: string,
  versionLabel: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${taskName} (${versionLabel})`);
  lines.push('');

  lines.push('## System Prompt');
  lines.push(spec.system_prompt || '(empty)');
  lines.push('');

  lines.push('## User Template');
  lines.push(spec.user_template || '(empty)');
  lines.push('');

  if (spec.image_slots.length > 0) {
    lines.push('## Image Slots');
    lines.push('| Slot ID | Role | Label | Required | Min | Max | Description |');
    lines.push('|---------|------|-------|----------|-----|-----|-------------|');
    for (const slot of spec.image_slots) {
      lines.push(
        `| ${slot.slot_id} | ${slot.role_hint ?? '-'} | ${slot.label} | ${slot.required ? 'yes' : 'no'} | ${slot.min_count} | ${slot.max_count ?? '∞'} | ${slot.description ?? '-'} |`,
      );
    }
    lines.push('');
  }

  if (spec.variable_slots.length > 0) {
    lines.push('## Variable Slots');
    lines.push('| Var ID | Label | Required | Type | Default | Description |');
    lines.push('|--------|-------|----------|------|---------|-------------|');
    for (const v of spec.variable_slots) {
      lines.push(
        `| ${v.var_id} | ${v.label} | ${v.required ? 'yes' : 'no'} | ${v.type} | ${v.default_value ?? '-'} | ${v.description ?? '-'} |`,
      );
    }
    lines.push('');
  }

  if (spec.expected_csv_columns.length > 0) {
    lines.push('## Expected CSV Columns');
    lines.push('| Column | Kind | Role | Var ID | Required |');
    lines.push('|--------|------|------|--------|----------|');
    for (const col of spec.expected_csv_columns) {
      lines.push(
        `| ${col.column} | ${col.kind} | ${col.role_hint ?? '-'} | ${col.var_id ?? '-'} | ${col.required ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
  }

  lines.push('## CSV Example Row');
  lines.push(formatCsvRow(spec.csv_example_row));
  lines.push('');

  lines.push('## JSONL Example');
  lines.push(formatJsonlExample(spec.jsonl_example));
  lines.push('');

  if (spec.notes) {
    lines.push('## Notes');
    lines.push(spec.notes);
  }

  return lines.join('\n');
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (document.execCommand('copy')) {
        resolve();
      } else {
        reject(new Error('Copy failed'));
      }
    } catch (err) {
      reject(err);
    } finally {
      document.body.removeChild(textarea);
    }
  });
}

function formatCsvRow(row: Record<string, string>): string {
  const headers = Object.keys(row);
  if (headers.length === 0) return '';
  return [headers.join(','), headers.map((key) => formatCsvCell(row[key])).join(',')].join('\n');
}

function formatCsvCell(value: string): string {
  if (value === '') return '';
  if (/[",\n\r]/.test(value)) {
    const escaped = value.replace(/"/g, '""');
    return '"' + escaped + '"';
  }
  return value;
}

function formatJsonlExample(example: Record<string, unknown>): string {
  try {
    return JSON.stringify(example, null, 2);
  } catch {
    return String(example);
  }
}
