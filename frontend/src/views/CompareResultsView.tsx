import { AlertCircle, ArrowLeft, Eye, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import * as api from '../api/client';
import type { UpdateReviewPayload } from '../api/payloads';
import { resolveImageSrc } from '../components/lab/ImagePanel';
import {
  CompareOverlay,
  ReviewBadge,
  StatusBadge,
  extractImagesFromSnapshot,
  extractReview,
} from '../components/results/CompareOverlay';
import { ParsedOutputView } from '../components/results/ParsedOutputView';
import { ReasoningBlock } from '../components/results/ReasoningBlock';
import { RunSelector } from '../components/results/RunSelector';
import { useI18n } from '../i18n';
import type { CompareRunMatrix, RunItemSummary } from '../types';

interface CompareResultsViewProps {
  initialRunId?: string | null;
}

export function CompareResultsView({ initialRunId }: CompareResultsViewProps) {
  const { t } = useI18n();
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  const [runs, setRuns] = useState<api.RunListItem[]>([]);
  const [detail, setDetail] = useState<api.RunDetail | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingReview, setSavingReview] = useState(false);
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);

  useEffect(() => {
    if (initialRunId && initialRunId !== runId) {
      setRunId(initialRunId);
    }
  }, [initialRunId]);

  useEffect(() => {
    let cancelled = false;
    setLoadingRuns(true);
    api
      .listRuns({ run_type: 'compare', limit: 1000 })
      .then((response) => {
        if (!cancelled) setRuns(response.runs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('results.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoadingRuns(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (!runId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setError(null);
    api
      .getRun(runId)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('results.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, t]);

  const matrix = detail?.matrix;

  const updateReview = useCallback(
    async (item: RunItemSummary, payload: UpdateReviewPayload) => {
      if (!runId) return;
      setSavingReview(true);
      const nextReview: Record<string, unknown> = {
        ...item.review,
        ...payload,
        reviewed_at: new Date().toISOString(),
      };
      const nextItem = { ...item, review: nextReview };

      setDetail((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((it) =>
            it.run_item_id === item.run_item_id ? nextItem : it,
          ),
          matrix: prev.matrix
            ? updateItemInMatrix(prev.matrix, nextItem)
            : undefined,
        };
      });

      try {
        await api.updateReview(runId, item.run_item_id, payload);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('results.reviewSaveFailed'));
        setDetail((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            items: prev.items.map((it) =>
              it.run_item_id === item.run_item_id ? item : it,
            ),
            matrix: prev.matrix ? updateItemInMatrix(prev.matrix, item) : undefined,
          };
        });
      } finally {
        setSavingReview(false);
      }
    },
    [runId, t],
  );

  const handleAccepted = useCallback(
    (item: RunItemSummary, value: boolean | null) => {
      void updateReview(item, { accepted: value });
    },
    [updateReview],
  );

  const handleRating = useCallback(
    (item: RunItemSummary, value: number) => {
      const current = extractReview(item.review).rating;
      const next = current === value ? null : value;
      void updateReview(item, { rating: next });
    },
    [updateReview],
  );

  const overlayItems = useMemo(() => {
    if (!selectedSampleId || !matrix) return [];
    return matrix.variant_labels
      .map((label) => matrix.items_by_sample[selectedSampleId]?.[label])
      .filter(Boolean);
  }, [selectedSampleId, matrix]);

  function handleSelectRun(nextRunId: string | null) {
    setRunId(nextRunId);
  }

  function handleBackToResults() {
    window.dispatchEvent(new CustomEvent('miko:navigate', { detail: 'results' }));
  }

  const session = detail?.session;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="relative z-20 flex flex-col gap-4 border-b border-surface-800 bg-surface-900/50 px-6 py-4 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
              {t('compareResults.title')}
            </h1>
            <p className="mt-1 text-xs text-ink-dim">{t('compareResults.selectRun')}</p>
          </div>
          <button
            type="button"
            onClick={handleBackToResults}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
          >
            <ArrowLeft size={14} />
            {t('compareResults.backToResults')}
          </button>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <RunSelector
            runs={runs}
            selectedRunId={runId}
            onSelect={handleSelectRun}
            disabled={loadingRuns}
            t={t}
          />
          {session && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
              <span className="text-ink">
                <span className="text-ink-dim">{t('results.total')}:</span>{' '}
                <span className="font-semibold">{matrix?.sample_ids.length ?? 0}</span>
              </span>
              <span className="text-ink">
                <span className="text-ink-dim">{t('batch.status')}:</span>{' '}
                <StatusBadge status={session.status} />
              </span>
            </div>
          )}
        </div>
      </header>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden p-6">
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {loadingDetail && !detail && (
          <div className="flex h-48 items-center justify-center text-xs text-ink-muted">
            <Loader2 size={16} className="mr-2 animate-spin" />
            {t('task.loading')}
          </div>
        )}

        {!runId && !loadingDetail && (
          <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
            {t('compareResults.noRunSelected')}
          </div>
        )}

        {runId && !loadingDetail && !matrix && (
          <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
            {t('compareResults.noMatrix')}
          </div>
        )}

        {matrix && (
          <div className="h-full animate-fade-in overflow-auto rounded-lg border border-surface-700">
            <table className="w-full table-fixed text-left text-xs">
                <thead className="sticky top-0 z-10 bg-surface-900">
                  <tr className="border-b border-surface-700 text-ink-muted">
                    <th className="w-36 whitespace-nowrap px-4 py-3 font-semibold uppercase tracking-wider">
                      {t('compareResults.sample')}
                    </th>
                    {matrix.variant_labels.map((label) => (
                      <th
                        key={label}
                        className="w-56 px-4 py-3 font-semibold uppercase tracking-wider"
                      >
                        {label}
                      </th>
                    ))}
                    <th className="w-24 px-4 py-3 font-semibold uppercase tracking-wider">
                      <span className="sr-only">{t('compareResults.viewGroup')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-800">
                  {matrix.sample_ids.map((sampleId) => {
                    const firstItem =
                      matrix.items_by_sample[sampleId]?.[matrix.variant_labels[0] ?? ''];
                    const rowImages = extractImagesFromSnapshot(
                      firstItem?.internal_request_snapshot,
                    );
                    const rowImage = rowImages[0];
                    const rowImageSrc = rowImage ? resolveImageSrc(rowImage) : '';
                    return (
                    <tr key={sampleId} className="bg-surface-950 hover:bg-surface-900/50">
                      <td className="w-36 whitespace-nowrap px-4 py-3 align-top">
                        <div className="flex h-96 flex-col gap-2">
                          {rowImageSrc ? (
                            <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-surface-800 bg-surface-900">
                              <img
                                src={rowImageSrc}
                                alt=""
                                className="h-full w-full object-contain"
                              />
                            </div>
                          ) : (
                            <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-surface-800 bg-surface-900 text-[10px] text-ink-dim">
                              —
                            </div>
                          )}
                          <span className="shrink-0 font-mono text-xs break-all text-ink">
                            {sampleId}
                          </span>
                        </div>
                      </td>
                      {matrix.variant_labels.map((label) => {
                        const item = matrix.items_by_sample[sampleId]?.[label];
                        return (
                          <td key={label} className="w-56 px-2 py-2 align-top">
                            {item ? (
                              <MatrixCell item={item} />
                            ) : (
                              <span className="text-ink-dim">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-4 py-3 align-top">
                        <button
                          type="button"
                          onClick={() => setSelectedSampleId(sampleId)}
                          className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1.5 text-xs text-ink-muted transition-colors hover:border-accent/50 hover:text-accent"
                        >
                          <Eye size={12} />
                          {t('compareResults.viewGroup')}
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
          </div>
        )}
      </section>

      {selectedSampleId && overlayItems.length > 0 && (
        <CompareOverlay
          items={overlayItems}
          savingReview={savingReview}
          onAccepted={handleAccepted}
          onRating={handleRating}
          onClose={() => setSelectedSampleId(null)}
          t={t}
        />
      )}
    </div>
  );
}

function MatrixCell({ item }: { item: RunItemSummary }) {
  const rawText = extractRawText(item.response);
  const parsed = item.response.parsed;
  const parseStatus = extractParseStatus(item.response);
  const reasoningText = extractReasoningText(item.response);
  const review = extractReview(item.review);

  return (
    <div className="flex h-96 flex-col overflow-hidden rounded-md border border-surface-800 bg-surface-900">
      <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-2 py-1.5">
        <StatusBadge status={item.status} />
        <ReviewBadge review={review} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <ParsedOutputView
          parsed={parsed}
          parseStatus={parseStatus}
          fallbackText={rawText}
        />
        {reasoningText && <ReasoningBlock reasoningText={reasoningText} />}
      </div>
    </div>
  );
}

function extractRawText(response: Record<string, unknown>): string {
  const raw = response.raw_text;
  if (typeof raw === 'string') return raw;
  const text = response.text;
  if (typeof text === 'string') return text;
  return '';
}

function extractParseStatus(response: Record<string, unknown>): string | undefined {
  const status = response.parse_status;
  return typeof status === 'string' ? status : undefined;
}

function extractReasoningText(response: Record<string, unknown>): string | undefined {
  const text = response.reasoning_text;
  return typeof text === 'string' ? text : undefined;
}

function updateItemInMatrix(
  matrix: CompareRunMatrix,
  nextItem: RunItemSummary,
): CompareRunMatrix {
  const nextItemsBySample: CompareRunMatrix['items_by_sample'] = {};
  for (const sampleId of matrix.sample_ids) {
    const row = matrix.items_by_sample[sampleId] ?? {};
    const nextRow: Record<string, RunItemSummary> = {};
    for (const [label, item] of Object.entries(row)) {
      nextRow[label] = item.run_item_id === nextItem.run_item_id ? nextItem : item;
    }
    nextItemsBySample[sampleId] = nextRow;
  }
  return { ...matrix, items_by_sample: nextItemsBySample };
}


