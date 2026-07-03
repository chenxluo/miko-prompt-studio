import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  fetchReviewSummary,
  listRuns,
  type ReviewGroupBy,
  type ReviewSummaryResponse,
  type RunListItem,
} from '../api/client';
import { useI18n } from '../i18n';

const GROUP_BY_OPTIONS: ReviewGroupBy[] = ['variant', 'model', 'provider'];

function keyLabelKey(g: ReviewGroupBy): string {
  return `results.reviewStats.${g}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function AnalyticsView() {
  const { t } = useI18n();

  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<ReviewGroupBy>('variant');
  const [result, setResult] = useState<ReviewSummaryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);

  // ponytail: 1000 covers every run in practice; pagination UI isn't worth it here.
  useEffect(() => {
    let ignore = false;
    listRuns({ limit: 1000 })
      .then((res) => {
        if (!ignore) setRuns(res.runs);
      })
      .catch((err) => {
        if (!ignore) setRunsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!ignore) setRunsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  // Re-query whenever the selection or grouping changes. ignore flag drops
  // stale responses from rapid toggles (fetchReviewSummary has no abort signal).
  useEffect(() => {
    if (selectedRunIds.size === 0) {
      setResult(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    let ignore = false;
    const ids = [...selectedRunIds];
    fetchReviewSummary(ids, groupBy)
      .then((res) => {
        if (!ignore) setResult(res);
      })
      .catch((err) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [selectedRunIds, groupBy]);

  const toggleRun = (runId: string) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const selectAll = () => setSelectedRunIds(new Set(runs.map((r) => r.run_id)));
  const clearAll = () => setSelectedRunIds(new Set());

  // Aggregate totals across buckets for the summary metric row.
  const totals = useMemo(() => {
    if (!result) return null;
    let n = 0;
    let accepted = 0;
    let rejected = 0;
    let ratingCount = 0;
    let ratingWeighted = 0;
    for (const row of result.rows) {
      n += row.n;
      accepted += row.accepted;
      rejected += row.rejected;
      ratingCount += row.rating_count;
      if (row.avg_rating != null) ratingWeighted += row.avg_rating * row.rating_count;
    }
    const judged = accepted + rejected;
    const undecided = n - judged;
    const passRate = judged > 0 ? accepted / judged : null;
    const avgRating = ratingCount > 0 ? ratingWeighted / ratingCount : null;
    return { n, accepted, rejected, undecided, judged, passRate, avgRating, ratingCount };
  }, [result]);

  const sortedRows = useMemo(() => {
    if (!result) return [];
    const rows = [...result.rows];
    rows.sort((a, b) => (sortDir === 'desc' ? b.n - a.n : a.n - b.n));
    return rows;
  }, [result, sortDir]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      {/* header bar */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-surface-800 bg-surface-900/50 px-4 py-3">
        <h1 className="text-sm font-semibold text-ink">{t('analytics.title')}</h1>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-ink-muted">
            {t('analytics.groupBy')}
          </span>
          <div className="flex overflow-hidden rounded-md border border-surface-800">
            {GROUP_BY_OPTIONS.map((opt) => {
              const active = opt === groupBy;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setGroupBy(opt)}
                  className={
                    'px-3 py-1 text-xs font-medium transition-colors ' +
                    (active
                      ? 'bg-accent text-surface-950'
                      : 'bg-surface-900 text-ink-dim hover:text-ink')
                  }
                >
                  {t(keyLabelKey(opt))}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* body */}
      <div className="flex min-h-0 flex-1">
        {/* run multi-select */}
        <div className="flex w-72 shrink-0 flex-col border-r border-surface-800">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-surface-800 px-3 py-2">
            <span className="text-xs font-medium text-ink-dim">
              {t('analytics.selectRuns')}{' '}
              <span className="text-ink-muted">
                ({selectedRunIds.size}/{runs.length})
              </span>
            </span>
            <div className="flex gap-2 text-[10px]">
              <button
                type="button"
                onClick={selectAll}
                className="text-accent hover:underline disabled:text-ink-muted disabled:no-underline"
                disabled={runs.length === 0}
              >
                {t('analytics.selectAll')}
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="text-ink-dim hover:text-ink hover:underline disabled:text-ink-muted disabled:no-underline"
                disabled={selectedRunIds.size === 0}
              >
                {t('analytics.clear')}
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {runsLoading ? (
              <div className="flex h-full items-center justify-center text-xs text-ink-muted">
                <Loader2 size={14} className="mr-2 animate-spin" />
                {t('analytics.loading')}
              </div>
            ) : runsError ? (
              <div className="flex h-full items-center justify-center p-3 text-center text-xs text-danger">
                {runsError}
              </div>
            ) : runs.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-ink-muted">
                {t('analytics.noData')}
              </div>
            ) : (
              <ul className="divide-y divide-surface-800/50">
                {runs.map((run) => {
                  const checked = selectedRunIds.has(run.run_id);
                  return (
                    <li key={run.run_id}>
                      <label className="flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-surface-900/50">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRun(run.run_id)}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-ink">
                            {run.name}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-muted">
                            <span className="rounded bg-surface-800 px-1 py-0.5 font-mono text-ink-dim">
                              {run.run_type}
                            </span>
                            <span>{formatDate(run.created_at)}</span>
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* summary + table */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {selectedRunIds.size === 0 ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-ink-muted">
              {t('analytics.noSelection')}
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-danger">
              {error}
            </div>
          ) : isLoading ? (
            <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-ink-muted">
              <Loader2 size={16} className="animate-spin" />
              {t('analytics.loading')}
            </div>
          ) : !result || result.rows.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-ink-muted">
              {t('analytics.noData')}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
              {/* summary metric row */}
              {totals && (
                <div className="panel mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-xs">
                  <span className="text-ink">
                    <span className="text-ink-dim">{t('results.reviewStats.total')}:</span>{' '}
                    <span className="font-semibold">{totals.n}</span>
                  </span>
                  <span className="text-ink">
                    <span className="text-ink-dim">{t('results.reviewStats.passRate')}:</span>{' '}
                    <span className="font-semibold text-accent">
                      {totals.passRate != null ? `${Math.round(totals.passRate * 100)}%` : '—'}
                    </span>
                    <span className="ml-1 text-[10px] text-ink-dim">
                      {totals.accepted}/{totals.judged} {t('results.reviewStats.judged')}
                    </span>
                  </span>
                  <span className="text-ink">
                    <span className="text-ink-dim">{t('results.reviewStats.accepted')}:</span>{' '}
                    <span className="font-semibold text-emerald-400">{totals.accepted}</span>
                  </span>
                  <span className="text-ink">
                    <span className="text-ink-dim">{t('results.reviewStats.rejected')}:</span>{' '}
                    <span className="font-semibold text-danger">{totals.rejected}</span>
                  </span>
                  <span className="text-ink">
                    <span className="text-ink-dim">{t('results.reviewStats.undecided')}:</span>{' '}
                    <span className="font-semibold text-ink-muted">{totals.undecided}</span>
                  </span>
                  <span className="text-ink">
                    <span className="text-ink-dim">{t('results.reviewStats.avgRating')}:</span>{' '}
                    <span className="font-semibold text-amber-400">
                      ★ {totals.avgRating != null ? totals.avgRating.toFixed(1) : '—'}
                    </span>
                    <span className="ml-1 text-[10px] text-ink-dim">
                      {t('analytics.ratedSummary', { count: totals.ratingCount })}
                    </span>
                  </span>
                </div>
              )}

              {/* pivot table */}
              <div className="panel overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-800 text-ink-dim">
                      <th className="px-3 py-2 text-left">{t(keyLabelKey(groupBy))}</th>
                      <th className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
                          className="font-medium hover:text-ink"
                          title={t('results.reviewStats.total')}
                        >
                          {t('results.reviewStats.total')}
                          {sortDir === 'desc' ? ' ↓' : ' ↑'}
                        </button>
                      </th>
                      <th className="px-3 py-2 text-right">{t('results.reviewStats.accepted')}</th>
                      <th className="px-3 py-2 text-right">{t('results.reviewStats.rejected')}</th>
                      <th className="px-3 py-2 text-right">{t('results.reviewStats.undecided')}</th>
                      <th className="px-3 py-2 text-right">{t('results.reviewStats.passRate')}</th>
                      <th className="px-3 py-2 text-right">{t('results.reviewStats.avgRating')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row) => (
                      <tr key={row.key} className="border-b border-surface-800/50">
                        <td className="px-3 py-2 text-left">
                          <div className="font-medium text-ink">{row.key}</div>
                          <div className="text-[10px] font-mono text-ink-dim">
                            {row.model_display}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-ink">{row.n}</td>
                        <td className="px-3 py-2 text-right font-mono text-emerald-400">
                          {row.accepted}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-danger">
                          {row.rejected}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-ink-muted">
                          {row.undecided}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-ink">
                          {row.pass_rate != null ? `${Math.round(row.pass_rate * 100)}%` : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-ink">
                          {row.avg_rating != null ? row.avg_rating.toFixed(1) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
