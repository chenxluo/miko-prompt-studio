import { AlertCircle, Calculator, Loader2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { getCostStats, getTask, listTasks, type CostStats } from '../api/client';
import { useI18n } from '../i18n';
import type { Task, TaskVersion } from '../types';

interface CostLine {
  id: string;
  task: Task;
  version: TaskVersion;
  quantity: number;
}

export function CostView() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [versions, setVersions] = useState<TaskVersion[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [lines, setLines] = useState<CostLine[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(true);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsLoadingTasks(true);
    listTasks()
      .then((items) => {
        setTasks(items);
        if (items[0]) setSelectedTaskId(items[0].task_id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('task.loadFailed')))
      .finally(() => setIsLoadingTasks(false));
  }, [t]);

  useEffect(() => {
    if (!selectedTaskId) {
      setVersions([]);
      setSelectedVersionId('');
      return;
    }
    setIsLoadingVersions(true);
    getTask(selectedTaskId)
      .then((task) => {
        setVersions(task.versions ?? []);
        setSelectedVersionId(task.current_version_id || task.versions?.[0]?.task_version_id || '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('task.detailFailed')))
      .finally(() => setIsLoadingVersions(false));
  }, [selectedTaskId, t]);

  const selectedTask = tasks.find((task) => task.task_id === selectedTaskId) ?? null;
  const selectedVersion = versions.find((version) => version.task_version_id === selectedVersionId) ?? null;

  function addLine() {
    if (!selectedTask || !selectedVersion) return;
    const id = `${selectedTask.task_id}:${selectedVersion.task_version_id}`;
    if (lines.some((line) => line.id === id)) return;
    setLines((current) => [
      ...current,
      { id, task: selectedTask, version: selectedVersion, quantity: 1000 },
    ]);
  }

  const canAdd = Boolean(selectedTask && selectedVersion && !lines.some((line) => line.id === `${selectedTask.task_id}:${selectedVersion.task_version_id}`));

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="border-b border-surface-800 bg-surface-900/50 px-6 py-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-accent/30 bg-accent/10 text-accent shadow-glow">
            <Calculator size={20} />
          </div>
          <div>
            <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">{t('cost.title')}</h1>
            <p className="mt-1 text-xs text-ink-dim">{t('cost.description')}</p>
          </div>
        </div>
      </header>

      <section className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-5xl space-y-5">
          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          <div className="panel relative overflow-hidden p-4">
            <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-accent/10 blur-3xl" />
            <div className="relative grid gap-3 md:grid-cols-[1fr_1fr_auto]">
              <Select
                label={t('cost.selectTask')}
                value={selectedTaskId}
                disabled={isLoadingTasks}
                onChange={setSelectedTaskId}
                options={tasks.map((task) => ({ value: task.task_id, label: task.name || t('task.untitled') }))}
              />
              <Select
                label={t('cost.selectVersion')}
                value={selectedVersionId}
                disabled={!selectedTaskId || isLoadingVersions}
                onChange={setSelectedVersionId}
                options={versions.map((version) => ({
                  value: version.task_version_id,
                  label: `${version.version_label || version.task_version_id} · ${version.model_id}`,
                }))}
              />
              <button
                type="button"
                onClick={addLine}
                disabled={!canAdd}
                className="btn-primary self-end disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isLoadingVersions ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                {t('cost.addTask')}
              </button>
            </div>
          </div>

          {lines.length === 0 ? (
            <div className="panel flex h-48 items-center justify-center border-dashed text-sm text-ink-dim">
              {t('cost.addTask')}
            </div>
          ) : (
            <CostLineList lines={lines} onChange={setLines} />
          )}
        </div>
      </section>
    </div>
  );
}

function CostLineList({ lines, onChange }: { lines: CostLine[]; onChange: (lines: CostLine[]) => void }) {
  const { t } = useI18n();
  const [statsById, setStatsById] = useState<Record<string, CostStats | null>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    for (const line of lines) {
      if (line.id in statsById || loadingIds.has(line.id)) continue;
      setLoadingIds((current) => new Set(current).add(line.id));
      getCostStats(line.task.task_id, line.version.task_version_id)
        .then((stats) => setStatsById((current) => ({ ...current, [line.id]: stats })))
        .catch(() => setStatsById((current) => ({ ...current, [line.id]: null })))
        .finally(() => {
          setLoadingIds((current) => {
            const next = new Set(current);
            next.delete(line.id);
            return next;
          });
        });
    }
  }, [lines, loadingIds, statsById]);

  const total = useMemo(
    () => lines.reduce((sum, line) => sum + (statsById[line.id]?.avg_cost_per_image ?? 0) * line.quantity, 0),
    [lines, statsById],
  );
  const currency = lines.map((line) => statsById[line.id]?.currency).find(Boolean) ?? 'USD';

  return (
    <div className="space-y-4">
      {lines.map((line) => (
        <CostCard
          key={line.id}
          line={line}
          stats={statsById[line.id]}
          isLoading={loadingIds.has(line.id)}
          onQuantityChange={(quantity) => onChange(lines.map((item) => (item.id === line.id ? { ...item, quantity } : item)))}
          onRemove={() => onChange(lines.filter((item) => item.id !== line.id))}
        />
      ))}
      <div className="flex items-center justify-between border-t border-surface-800 pt-5">
        <span className="text-sm uppercase tracking-[0.2em] text-ink-dim">{t('cost.total')}</span>
        <span className="text-3xl font-bold text-ink">{formatMoney(total, currency)}</span>
      </div>
    </div>
  );
}

function CostCard({
  line,
  stats,
  isLoading,
  onQuantityChange,
  onRemove,
}: {
  line: CostLine;
  stats: CostStats | null | undefined;
  isLoading: boolean;
  onQuantityChange: (quantity: number) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const noData = stats?.total_images === 0;
  const subtotal = stats ? stats.avg_cost_per_image * line.quantity : 0;
  const versionLabel = line.version.version_label || line.version.task_version_id;

  return (
    <article className="panel overflow-hidden border-accent/10 bg-gradient-to-br from-surface-900 to-surface-950 p-5 shadow-xl shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">{line.task.name} <span className="text-accent">({versionLabel})</span></h2>
          <p className="mt-1 font-mono text-xs text-ink-dim">{line.version.model_id}</p>
        </div>
        <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1 text-xs text-ink-muted transition hover:border-danger/50 hover:text-danger">
          <Trash2 size={13} />
          {t('cost.remove')}
        </button>
      </div>

      {isLoading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 size={16} className="animate-spin" />
          {t('task.loading')}
        </div>
      ) : !stats || noData ? (
        <div className="mt-5 rounded-xl border border-surface-700 bg-surface-900/70 p-4">
          <div className="text-sm font-semibold text-ink">{t('cost.noData')}</div>
          <div className="mt-1 text-xs text-ink-dim">{t('cost.noDataHint')}</div>
        </div>
      ) : (
        <div className="mt-5 grid gap-4 md:grid-cols-[1.3fr_1fr]">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label={t('cost.avgCostPerImage')} value={`${formatMoney(stats.avg_cost_per_image, stats.currency)}${t('cost.perImage')}`} />
            <Metric label={t('cost.sampleCount')} value={`${stats.sample_count} / ${stats.total_images}`} hint={`${stats.run_count} ${t('cost.runCount')}`} />
            <Metric label={t('cost.confidence')} value={t(`cost.confidence${capitalize(stats.confidence)}`)} tone={stats.confidence} />
          </div>
          <div className="rounded-2xl border border-surface-700 bg-surface-900/60 p-4">
            <label className="text-xs text-ink-dim">{t('cost.quantity')}</label>
            <div className="mt-2 flex items-center gap-3">
              <input
                type="number"
                min={1}
                value={line.quantity}
                onChange={(event) => onQuantityChange(Math.max(1, Number(event.target.value) || 1))}
                className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              />
              <span className="text-xs text-ink-dim">{t('cost.perImage').replace('/', '')}</span>
            </div>
            <div className="mt-4 flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wider text-ink-dim">{t('cost.subtotal')}</span>
              <span className="text-2xl font-bold text-accent">{formatMoney(subtotal, stats.currency)}</span>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: CostStats['confidence'] }) {
  const toneClass = tone === 'high' ? 'text-accent' : tone === 'medium' ? 'text-cost' : tone === 'low' ? 'text-ink-muted' : 'text-ink-muted';
  return (
    <div className="rounded-2xl border border-surface-700 bg-surface-900/60 p-4">
      <div className="text-xs text-ink-dim">{label}</div>
      <div className={`mt-2 text-lg font-semibold ${toneClass}`}>{tone ? `● ${value}` : value}</div>
      {hint && <div className="mt-1 text-xs text-ink-dim">{hint}</div>}
    </div>
  );
}

function Select({ label, value, options, disabled, onChange }: { label: string; value: string; options: { value: string; label: string }[]; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-ink-dim">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-50"
      >
        <option value="">{label}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function formatMoney(value: number, currency: string) {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${value.toFixed(value < 1 ? 4 : 2)}`;
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
