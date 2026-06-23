import {
  BookOpen,
  ChevronDown,
  Copy,
  FileText,
  Loader2,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { deleteTask, getTask, getTaskInputSpec, listTasks } from '../api/client';
import { useI18n } from '../i18n';
import { useLabStore } from '../store/labStore';
import type { Task, TaskInputSpec, TaskVersion } from '../types';

export function TasksView() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detail, setDetail] = useState<(Task & { versions: TaskVersion[] }) | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [specVersion, setSpecVersion] = useState<TaskVersion | null>(null);
  const [inputSpec, setInputSpec] = useState<TaskInputSpec | null>(null);
  const [isSpecLoading, setIsSpecLoading] = useState(false);
  const [specError, setSpecError] = useState<string | null>(null);

  const providerConfigs = useLabStore((state) => state.providerConfigs);
  const loadProviderConfigs = useLabStore((state) => state.loadProviderConfigs);
  const loadTask = useLabStore((state) => state.loadTask);

  useEffect(() => {
    void loadProviderConfigs();
  }, [loadProviderConfigs]);

  useEffect(() => {
    void refreshTasks();
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

  async function refreshTasks() {
    setIsLoading(true);
    setError(null);
    try {
      setTasks(await listTasks());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('task.loadFailed'));
    } finally {
      setIsLoading(false);
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

  async function handleLoad(task: Task, version?: TaskVersion) {
    await loadTask(task, version);
    window.dispatchEvent(new CustomEvent('miko:navigate', { detail: 'lab' }));
  }

  async function handleViewInputSpec(task: Task, version: TaskVersion) {
    setSpecVersion(version);
    setInputSpec(null);
    setSpecError(null);
    setIsSpecLoading(true);
    try {
      const spec = await getTaskInputSpec(task.task_id, version.task_version_id);
      setInputSpec(spec);
    } catch (err) {
      setSpecError(err instanceof Error ? err.message : t('task.inputSpec.loadFailed'));
    } finally {
      setIsSpecLoading(false);
    }
  }

  function handleCloseInputSpec() {
    setSpecVersion(null);
    setInputSpec(null);
    setSpecError(null);
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
      </header>

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
        ) : tasks.length === 0 ? (
          <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
            {t('task.empty')}
          </div>
        ) : (
          <div className="grid gap-3">
            {tasks.map((task) => (
              <TaskListCard
                key={task.task_id}
                task={task}
                providerNames={providerNames}
                isDeleting={deletingId === task.task_id}
                onClick={() => setSelectedTask(task)}
                onDelete={() => void handleDelete(task)}
                onLoad={() => void handleLoad(task, task.current_version ?? undefined)}
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
          onClose={() => setSelectedTask(null)}
          onLoad={(version) => void handleLoad(selectedTask, version)}
          onDelete={() => void handleDelete(selectedTask)}
          onViewInputSpec={(version) => void handleViewInputSpec(selectedTask, version)}
        />
      )}

      {specVersion && selectedTask && (
        <InputSpecModal
          taskName={selectedTask.name}
          version={specVersion}
          spec={inputSpec}
          isLoading={isSpecLoading}
          error={specError}
          onClose={handleCloseInputSpec}
        />
      )}
    </div>
  );
}

function TaskListCard({
  task,
  providerNames,
  isDeleting,
  onClick,
  onDelete,
  onLoad,
}: {
  task: Task;
  providerNames: Map<string, string>;
  isDeleting: boolean;
  onClick: () => void;
  onDelete: () => void;
  onLoad: () => void;
}) {
  const { t } = useI18n();
  const version = task.current_version;
  const providerName = version?.provider_config_id
    ? providerNames.get(version.provider_config_id) ?? version.provider_config_id
    : task.provider_config_id
      ? providerNames.get(task.provider_config_id) ?? task.provider_config_id
      : '—';
  const modelId = version?.model_id ?? task.model_id ?? '—';
  const versionLabel = version?.version_label ?? '—';

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
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-dim">
            <span>{t('task.model')}: {modelId}</span>
            <span>{t('task.providerConfig')}: {providerName}</span>
            <span>{t('task.updatedAt')}: {formatTime(task.updated_at)}</span>
          </div>
          {task.description && (
            <p className="mt-2 line-clamp-2 text-xs text-ink-muted">{task.description}</p>
          )}
        </div>

        <div className="flex shrink-0 gap-2"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={onLoad}
            className="btn-primary px-3 py-2 text-xs"
          >
            <Upload size={14} />
            {t('task.load')}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-danger/50 hover:text-danger disabled:opacity-50"
          >
            {isDeleting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
            {t('task.delete')}
          </button>
        </div>
      </div>
    </article>
  );
}

function TaskDetailDrawer({
  task,
  detail,
  isLoading,
  providerNames,
  onClose,
  onLoad,
  onDelete,
  onViewInputSpec,
}: {
  task: Task;
  detail: (Task & { versions: TaskVersion[] }) | null;
  isLoading: boolean;
  providerNames: Map<string, string>;
  onClose: () => void;
  onLoad: (version: TaskVersion) => void;
  onDelete: () => void;
  onViewInputSpec: (version: TaskVersion) => void;
}) {
  const { t } = useI18n();
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    task.current_version_id ?? task.current_version?.task_version_id ?? null,
  );

  const versions = detail?.versions ?? [];
  const selectedVersion = versions.find(
    (version) => version.task_version_id === selectedVersionId,
  ) ?? task.current_version ?? versions[0];

  useEffect(() => {
    setSelectedVersionId(
      task.current_version_id ?? task.current_version?.task_version_id ?? null,
    );
  }, [task]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-surface-950/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex h-full w-full max-w-2xl animate-fade-in flex-col border-l border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-accent" />
            <span className="text-sm font-semibold text-ink">{task.name}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-auto p-4">
          {task.description && (
            <p className="text-xs text-ink-muted">{task.description}</p>
          )}

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
                    onClick={() => setSelectedVersionId(version.task_version_id)}
                  >
                    <div className="flex items-center justify-between">
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
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onViewInputSpec(version);
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-surface-700 bg-surface-900 px-2 py-1 text-[10px] text-ink-muted transition-colors hover:border-accent/50 hover:text-accent"
                      >
                        <FileText size={10} />
                        {t('task.inputSpec')}
                      </button>
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
                ))}
              </ul>
            )}
          </div>
        </div>

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
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-danger/50 hover:text-danger"
          >
            <Trash2 size={12} />
            {t('task.delete')}
          </button>
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

function InputSpecModal({
  taskName,
  version,
  spec,
  isLoading,
  error,
  onClose,
}: {
  taskName: string;
  version: TaskVersion;
  spec: TaskInputSpec | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg border border-surface-700 bg-surface-900 shadow-panel animate-fade-in"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-5 py-3">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-accent" />
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-ink">
                {t('task.inputSpec')}
              </span>
              <span className="text-[10px] text-ink-dim">
                {taskName} · {version.version_label || version.task_version_id}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {spec && (
              <CopyAllButton text={formatFullDocument(spec, taskName, version.version_label ?? '')} />
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-auto p-5">
          {error && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex h-32 items-center justify-center text-xs text-ink-muted">
              <Loader2 size={14} className="mr-2 animate-spin" />
              {t('task.inputSpec.loading')}
            </div>
          ) : !spec ? (
            <div className="flex h-32 items-center justify-center text-xs text-ink-dim">
              {t('task.inputSpec.empty')}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <SectionTitle icon={<TerminalIcon />} label={t('task.inputSpec.prompts')} />
                <CollapsibleCodeBlock
                  label={t('prompt.systemPrompt')}
                  value={spec.system_prompt}
                />
                <CollapsibleCodeBlock
                  label={t('prompt.userTemplate')}
                  value={spec.user_template}
                />
                <CollapsibleCodeBlock
                  label={t('task.inputSpec.formatInstruction')}
                  value={spec.format_instruction}
                />
              </div>

              <SpecSection title={t('prompt.imageSlotSpecs')}>
                {spec.image_slots.length === 0 ? (
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
                        {spec.image_slots.map((slot) => (
                          <tr key={slot.slot_id} className="text-ink">
                            <td className="px-3 py-2 font-mono text-ink-muted">{slot.slot_id}</td>
                            <td className="px-3 py-2">{slot.label}</td>
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
                            <td className="px-3 py-2">{slot.min_count}</td>
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
                {spec.variable_slots.length === 0 ? (
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
                        {spec.variable_slots.map((variable) => (
                          <tr key={variable.var_id} className="text-ink">
                            <td className="px-3 py-2 font-mono text-ink-muted">{variable.var_id}</td>
                            <td className="px-3 py-2">{variable.label}</td>
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
                            <td className="px-3 py-2 font-mono text-ink-muted">{variable.type}</td>
                            <td className="px-3 py-2 text-ink-dim">{variable.default_value ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SpecSection>

              <SpecSection title={t('task.inputSpec.expectedCsvColumns')}>
                {spec.expected_csv_columns.length === 0 ? (
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
                        {spec.expected_csv_columns.map((column) => (
                          <tr key={column.column} className="text-ink">
                            <td className="px-3 py-2 font-mono text-ink-muted">{column.column}</td>
                            <td className="px-3 py-2">{column.kind}</td>
                            <td className="px-3 py-2 font-mono text-ink-muted">{column.role_hint ?? '—'}</td>
                            <td className="px-3 py-2 font-mono text-ink-muted">{column.var_id ?? '—'}</td>
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
                )}
              </SpecSection>

              <SpecSection title={t('task.inputSpec.csvExample')}>
                <CopyCodeBlock value={formatCsvRow(spec.csv_example_row)} />
              </SpecSection>

              <SpecSection title={t('task.inputSpec.jsonlExample')}>
                <CopyCodeBlock value={formatJsonlExample(spec.jsonl_example)} />
              </SpecSection>

              {spec.notes && (
                <SpecSection title={t('task.inputSpec.notes')}>
                  <p className="whitespace-pre-wrap text-xs text-ink-muted">{spec.notes}</p>
                </SpecSection>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 justify-end border-t border-surface-800 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:bg-surface-800"
          >
            {t('history.close')}
          </button>
        </div>
      </div>
    </div>
  );
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

  if (spec.format_instruction) {
    lines.push('## Format Instruction');
    lines.push(spec.format_instruction);
    lines.push('');
  }

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
  if (/[\",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
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

