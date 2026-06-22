import { Loader2, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { deleteTask, listTasks } from '../api/client';
import { useI18n } from '../i18n';
import { useLabStore } from '../store/labStore';
import type { Task } from '../types';

export function TasksView() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const providerConfigs = useLabStore((state) => state.providerConfigs);
  const loadProviderConfigs = useLabStore((state) => state.loadProviderConfigs);
  const loadTask = useLabStore((state) => state.loadTask);

  useEffect(() => {
    void loadProviderConfigs();
  }, [loadProviderConfigs]);

  useEffect(() => {
    void refreshTasks();
  }, []);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : t('task.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }

  function handleLoad(task: Task) {
    loadTask(task);
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
              <article key={task.task_id} className="panel p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold text-ink">{task.name}</h2>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-dim">
                      <span>{t('task.model')}: {task.model_id}</span>
                      <span>
                        {t('task.providerConfig')}: {task.provider_config_id ? providerNames.get(task.provider_config_id) ?? task.provider_config_id : '—'}
                      </span>
                      <span>{t('task.updatedAt')}: {formatTime(task.updated_at)}</span>
                    </div>
                    {task.notes && <p className="mt-2 line-clamp-2 text-xs text-ink-muted">{task.notes}</p>}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => handleLoad(task)}
                      className="btn-primary px-3 py-2 text-xs"
                    >
                      <Upload size={14} />
                      {t('task.load')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(task)}
                      disabled={deletingId === task.task_id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-danger/50 hover:text-danger disabled:opacity-50"
                    >
                      {deletingId === task.task_id ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Trash2 size={14} />
                      )}
                      {t('task.delete')}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function formatTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
