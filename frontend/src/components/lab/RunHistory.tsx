import { History, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '../../i18n';
import { useLabStore } from '../../store/labStore';
import type { RunSession, RunSessionStatus } from '../../types';

export function RunHistory() {
  const { t } = useI18n();
  const runHistory = useLabStore((state) => state.runHistory);
  const loadRunDetail = useLabStore((state) => state.loadRunDetail);

  const [loadingRunId, setLoadingRunId] = useState<string | null>(null);

  const handleSelect = async (run: RunSession) => {
    setLoadingRunId(run.run_id);
    try {
      await loadRunDetail(run.run_id);
    } finally {
      setLoadingRunId(null);
    }
  };

  if (runHistory.length === 0) {
    return (
      <div className="panel flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <History size={16} className="text-accent" />
          <span className="text-sm font-semibold text-ink">{t('history.title')}</span>
        </div>
        <p className="text-xs text-ink-dim">
          {t('history.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="panel flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-surface-800 px-4 py-3">
        <History size={16} className="text-accent" />
        <span className="text-sm font-semibold text-ink">{t('history.title')}</span>
        <span className="rounded-full bg-surface-800 px-2 py-0.5 text-xs text-ink-muted">
          {runHistory.length}
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-950 text-ink-muted">
            <tr>
              <th className="px-4 py-2 font-medium">{t('history.name')}</th>
              <th className="px-4 py-2 font-medium">{t('history.status')}</th>
              <th className="px-4 py-2 font-medium">{t('history.created')}</th>
              <th className="px-4 py-2 font-medium">{t('result.cost')}</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-800">
            {runHistory.map((run) => (
              <RunHistoryRow
                key={run.run_id}
                run={run}
                isLoading={loadingRunId === run.run_id}
                onSelect={() => void handleSelect(run)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface RunHistoryRowProps {
  run: RunSession;
  isLoading: boolean;
  onSelect: () => void;
}

function RunHistoryRow({ run, isLoading, onSelect }: RunHistoryRowProps) {
  const { t } = useI18n();
  const cost = run.summary?.total_cost_estimated ?? 0;
  const currency = run.summary?.currency ?? 'USD';
  const createdAt = run.created_at
    ? new Date(run.created_at).toLocaleString()
    : '—';

  return (
    <tr className="transition-colors hover:bg-surface-800/50">
      <td className="px-4 py-2 text-ink">{run.name ?? run.run_id}</td>
      <td className="px-4 py-2">
        <RunStatusBadge status={run.status} />
      </td>
      <td className="px-4 py-2 text-ink-muted">{createdAt}</td>
      <td className="px-4 py-2 font-medium text-cost">
        {currency} {cost.toFixed(6)}
      </td>
      <td className="px-4 py-2 text-right">
        <button
          type="button"
          onClick={onSelect}
          disabled={isLoading}
          className="inline-flex items-center gap-1 rounded-md border border-surface-700 bg-surface-800 px-2 py-1 text-xs font-medium text-ink transition-colors hover:border-surface-600 hover:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              {t('history.loading')}
            </>
          ) : (
            t('history.view')
          )}
        </button>
      </td>
    </tr>
  );
}

function RunStatusBadge({ status }: { status: RunSessionStatus | undefined }) {
  const { t } = useI18n();
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
        {t('history.statusCompleted')}
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
        {t('history.statusFailed')}
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
        {t('history.statusRunning')}
      </span>
    );
  }
  if (status === 'completed_with_errors') {
    return (
      <span className="inline-flex items-center rounded-full bg-cost/10 px-2 py-0.5 text-xs font-medium text-cost">
        {t('history.statusPartial')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-surface-800 px-2 py-0.5 text-xs font-medium text-ink-muted">
      {status ?? t('history.statusUnknown')}
    </span>
  );
}
