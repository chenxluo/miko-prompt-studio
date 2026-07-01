import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Columns3,
  ImageIcon,
  Loader2,
  Search,
  Star,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import * as api from '../api/client';
import type { UpdateReviewPayload } from '../api/payloads';
import { resolveImageSrc } from '../components/lab/ImagePanel';
import { CollapsibleSection } from '../components/results/CollapsibleSection';
import { ParsedOutputView } from '../components/results/ParsedOutputView';
import { ReasoningBlock } from '../components/results/ReasoningBlock';
import { RunSelector } from '../components/results/RunSelector';
import type { I18n } from '../i18n';
import { useI18n } from '../i18n';
import type { ImageRef, RequestImage, RunItemSummary } from '../types';

interface ResultsViewProps {
  initialRunId?: string | null;
}

type StatusFilter = 'all' | 'succeeded' | 'failed';

export function ResultsView({ initialRunId }: ResultsViewProps) {
  const { t } = useI18n();

  const [runs, setRuns] = useState<api.RunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId ?? null);
  const [items, setItems] = useState<RunItemSummary[]>([]);

  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const [savingReview, setSavingReview] = useState(false);

  // Compare mode state
  const [compareMode, setCompareMode] = useState(false);
  const [compareSelection, setCompareSelection] = useState<Set<string>>(new Set());
  const [showCompare, setShowCompare] = useState(false);

  // Keep selected run in sync with external navigation.
  useEffect(() => {
    if (initialRunId && initialRunId !== selectedRunId) {
      setSelectedRunId(initialRunId);
    }
  }, [initialRunId]);

  // Load the list of runs once on mount.
  useEffect(() => {
    setLoadingRuns(true);
    setError(null);
    api
      .listRuns({ limit: 1000 })
      .then((response) => {
        setRuns(response.runs);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('results.loadFailed'));
      })
      .finally(() => setLoadingRuns(false));
  }, [t]);

  // Load items when the selected run changes.
  useEffect(() => {
    if (!selectedRunId) {
      setItems([]);
      return;
    }

    setLoadingItems(true);
    setError(null);
    api
      .getRun(selectedRunId)
      .then((detail) => {
        setItems(detail.items);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('results.loadFailed'));
      })
      .finally(() => setLoadingItems(false));
  }, [selectedRunId, t]);

  const filteredItems = useMemo(() => {
    let result = items;
    if (statusFilter !== 'all') {
      result = result.filter((item) => item.status === statusFilter);
    }
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter((item) => item.sample_id.toLowerCase().includes(query));
    }
    return result;
  }, [items, statusFilter, searchQuery]);

  const stats = useMemo(() => {
    const total = filteredItems.length;
    const succeeded = filteredItems.filter((item) => item.status === 'succeeded').length;
    const failed = filteredItems.filter((item) => item.status === 'failed').length;
    const avgLatencyMs =
      total > 0
        ? filteredItems.reduce((sum, item) => sum + (item.latency_ms ?? 0), 0) / total
        : 0;
    return { total, succeeded, failed, avgLatencyMs };
  }, [filteredItems]);

  const detailItem = useMemo(
    () => filteredItems.find((item) => item.run_item_id === detailItemId) ?? null,
    [filteredItems, detailItemId],
  );

  const detailIndex = useMemo(
    () => (detailItem ? filteredItems.findIndex((item) => item.run_item_id === detailItem.run_item_id) : -1),
    [detailItem, filteredItems],
  );

  const openDetail = useCallback((item: RunItemSummary) => {
    setDetailItemId(item.run_item_id);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailItemId(null);
  }, []);

  const goToDetail = useCallback(
    (direction: -1 | 1) => {
      if (filteredItems.length === 0) return;
      const nextIndex =
        detailIndex >= 0
          ? (detailIndex + direction + filteredItems.length) % filteredItems.length
          : direction === 1
            ? 0
            : filteredItems.length - 1;
      setDetailItemId(filteredItems[nextIndex].run_item_id);
    },
    [detailIndex, filteredItems],
  );

  // Keyboard navigation for the detail overlay.
  useEffect(() => {
    if (!detailItem) return;

    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDetail();
      } else if (event.key === 'ArrowLeft') {
        goToDetail(-1);
      } else if (event.key === 'ArrowRight') {
        goToDetail(1);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [detailItem, closeDetail, goToDetail]);

  const updateReview = useCallback(
    async (item: RunItemSummary, payload: UpdateReviewPayload) => {
      if (!selectedRunId) return;
      setSavingReview(true);

      const nextReview: Record<string, unknown> = {
        ...item.review,
        ...payload,
        reviewed_at: new Date().toISOString(),
      };

      setItems((prev) =>
        prev.map((it) => (it.run_item_id === item.run_item_id ? { ...it, review: nextReview } : it)),
      );

      try {
        await api.updateReview(selectedRunId, item.run_item_id, payload);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('results.reviewSaveFailed'));
        // Roll back on failure.
        setItems((prev) =>
          prev.map((it) => (it.run_item_id === item.run_item_id ? item : it)),
        );
      } finally {
        setSavingReview(false);
      }
    },
    [selectedRunId, t],
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

  const handleNotesBlur = useCallback(
    (item: RunItemSummary, value: string) => {
      const current = extractReview(item.review).notes;
      if (value === current) return;
      void updateReview(item, { notes: value });
    },
    [updateReview],
  );

  const toggleCompareSelection = useCallback((item: RunItemSummary) => {
    setCompareSelection((prev) => {
      const next = new Set(prev);
      if (next.has(item.run_item_id)) {
        next.delete(item.run_item_id);
      } else if (next.size < 3) {
        next.add(item.run_item_id);
      }
      return next;
    });
  }, []);

  const exitCompareMode = useCallback(() => {
    setCompareMode(false);
    setCompareSelection(new Set());
    setShowCompare(false);
  }, []);

  const compareItems = useMemo(
    () => filteredItems.filter((item) => compareSelection.has(item.run_item_id)),
    [filteredItems, compareSelection],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="relative z-20 flex flex-col gap-4 border-b border-surface-800 bg-surface-900/50 px-6 py-4 backdrop-blur">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
            {t('results.title')}
          </h1>
          <p className="mt-1 text-xs text-ink-dim">{t('results.selectRun')}</p>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
            <RunSelector
              runs={runs}
              selectedRunId={selectedRunId}
              onSelect={setSelectedRunId}
              disabled={loadingRuns}
              t={t}
            />

            <div className="flex items-center gap-1 rounded-md border border-surface-700 bg-surface-900 p-1">
              {(['all', 'succeeded', 'failed'] as StatusFilter[]).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setStatusFilter(filter)}
                  className={`rounded px-2.5 py-1.5 text-xs transition-colors ${
                    statusFilter === filter
                      ? 'bg-accent/10 text-accent'
                      : 'text-ink-muted hover:bg-surface-800 hover:text-ink'
                  }`}
                >
                  {filter === 'all' ? t('results.statusAll') : t(`results.${filter}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-dim"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('results.searchPlaceholder')}
              className="w-full rounded-md border border-surface-700 bg-surface-900 py-2 pl-9 pr-3 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none sm:w-64"
            />
          </div>

          {items.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (compareMode) {
                  exitCompareMode();
                } else {
                  setCompareMode(true);
                }
              }}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs transition-colors ${
                compareMode
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-surface-700 text-ink-muted hover:bg-surface-800 hover:text-ink'
              }`}
            >
              <Columns3 size={14} />
              {compareMode ? t('results.exitCompare') : t('results.compare')}
            </button>
          )}
        </div>

        {compareMode && (
          <div className="flex items-center gap-3 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
            <span className="text-ink-muted">
              {t('results.selected', { count: compareSelection.size })}
            </span>
            {compareSelection.size >= 3 && (
              <span className="text-amber-400">{t('results.maxSelected')}</span>
            )}
            {compareSelection.size >= 2 && (
              <button
                type="button"
                onClick={() => setShowCompare(true)}
                className="btn-primary ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
              >
                <Columns3 size={12} />
                {t('results.viewComparison')}
              </button>
            )}
          </div>
        )}
      </header>

      <section className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {loadingItems && items.length === 0 && (
          <div className="flex h-48 items-center justify-center text-xs text-ink-muted">
            <Loader2 size={16} className="mr-2 animate-spin" />
            {t('task.loading')}
          </div>
        )}

        {!selectedRunId && !loadingRuns && (
          <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
            {t('results.noRunSelected')}
          </div>
        )}

        {selectedRunId && !loadingItems && items.length > 0 && (
          <div className="animate-fade-in space-y-5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
              <span className="text-ink">
                <span className="text-ink-dim">{t('results.total')}:</span>{' '}
                <span className="font-semibold">{stats.total}</span>
              </span>
              <span className="text-ink">
                <span className="text-ink-dim">{t('results.succeeded')}:</span>{' '}
                <span className="font-semibold text-emerald-400">{stats.succeeded}</span>
              </span>
              <span className="text-ink">
                <span className="text-ink-dim">{t('results.failed')}:</span>{' '}
                <span className="font-semibold text-danger">{stats.failed}</span>
              </span>
              <span className="text-ink">
                <span className="text-ink-dim">{t('results.avgLatency')}:</span>{' '}
                <span className="font-mono">{formatLatency(stats.avgLatencyMs)}</span>
              </span>
            </div>

            {filteredItems.length === 0 ? (
              <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
                {t('samples.noResults')}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {filteredItems.map((item) => (
                  <ResultCard
                    key={item.run_item_id}
                    item={item}
                    selected={compareMode && compareSelection.has(item.run_item_id)}
                    compareMode={compareMode}
                    maxReached={compareMode && compareSelection.size >= 3 && !compareSelection.has(item.run_item_id)}
                    onClick={() => {
                      if (compareMode) {
                        toggleCompareSelection(item);
                      } else {
                        openDetail(item);
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {detailItem && (
        <DetailOverlay
          item={detailItem}
          current={detailIndex + 1}
          total={filteredItems.length}
          onClose={closeDetail}
          onPrev={() => goToDetail(-1)}
          onNext={() => goToDetail(1)}
          savingReview={savingReview}
          onAccepted={handleAccepted}
          onRating={handleRating}
          onNotesBlur={handleNotesBlur}
          t={t}
        />
      )}

      {showCompare && compareItems.length >= 2 && (
        <CompareOverlay
          items={compareItems}
          savingReview={savingReview}
          onAccepted={handleAccepted}
          onRating={handleRating}
          onClose={() => setShowCompare(false)}
          t={t}
        />
      )}
    </div>
  );
}

interface ResultCardProps {
  item: RunItemSummary;
  onClick: () => void;
  selected?: boolean;
  compareMode?: boolean;
  maxReached?: boolean;
}

function ResultCard({ item, onClick, selected, compareMode, maxReached }: ResultCardProps) {
  const images = extractImagesFromSnapshot(item.internal_request_snapshot);
  const firstImage = images[0];
  const src = firstImage ? resolveImageSrc(firstImage) : '';
  const review = extractReview(item.review);
  const previewText = extractRawText(item.response);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={maxReached}
      className={`group flex flex-col overflow-hidden rounded-lg border bg-surface-900 text-left shadow-panel transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        selected
          ? 'border-accent ring-2 ring-accent/30'
          : 'border-surface-700 hover:border-accent/50'
      }`}
    >
      <div className="relative h-48 w-full bg-surface-950">
        {src ? (
          <img
            src={src}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ink-dim">
            <ImageIcon size={24} />
          </div>
        )}
        <div className="absolute right-2 top-2">
          <StatusBadge status={item.status} />
        </div>
        {compareMode && (
          <div className="absolute left-2 top-2">
            <div
              className={`flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                selected
                  ? 'border-accent bg-accent text-surface-950'
                  : 'border-surface-600 bg-surface-950/80 text-transparent'
              }`}
            >
              <Check size={12} />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3">
        <p className="line-clamp-3 text-xs leading-relaxed text-ink-muted">
          {previewText || '—'}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-surface-800 pt-2">
          <span className="truncate font-mono text-[10px] text-ink-dim">{item.sample_id}</span>
          <ReviewBadge review={review} />
        </div>
      </div>
    </button>
  );
}

interface DetailOverlayProps {
  item: RunItemSummary;
  current: number;
  total: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  savingReview: boolean;
  onAccepted: (item: RunItemSummary, value: boolean | null) => void;
  onRating: (item: RunItemSummary, value: number) => void;
  onNotesBlur: (item: RunItemSummary, value: string) => void;
  t: I18n['t'];
}

function DetailOverlay({
  item,
  current,
  total,
  onClose,
  onPrev,
  onNext,
  savingReview,
  onAccepted,
  onRating,
  onNotesBlur,
  t,
}: DetailOverlayProps) {
  const images = extractImagesFromSnapshot(item.internal_request_snapshot);
  const [mainImageIndex, setMainImageIndex] = useState(0);
  const mainImage = images[mainImageIndex] ?? images[0];
  const mainSrc = mainImage ? resolveImageSrc(mainImage) : '';

  const review = extractReview(item.review);
  const [notesDraft, setNotesDraft] = useState(review.notes);

  // Keep the draft in sync when navigating between items.
  useEffect(() => {
    setNotesDraft(review.notes);
    if (images.length > 0 && mainImageIndex >= images.length) {
      setMainImageIndex(0);
    }
  }, [item, review.notes, images.length, mainImageIndex]);

  const rawText = extractRawText(item.response);
  const parsed = item.response.parsed;
  const parseStatus = extractParseStatus(item.response);
  const reasoningText = extractReasoningText(item.response);

  const inputTokens = getNumberField(item.usage, 'input_tokens');
  const outputTokens = getNumberField(item.usage, 'output_tokens');
  const totalTokens = getNumberField(item.usage, 'total_tokens');
  const imageCount = getNumberField(item.usage, 'image_count');
  const reasoningTokens = getNumberField(item.usage, 'reasoning_tokens');
  const costCurrency = getStringField(item.cost, 'currency') ?? 'USD';

  const vars = extractVars(item.internal_request_snapshot);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-surface-950/90 backdrop-blur"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex items-center justify-between border-b border-surface-800 bg-surface-900/80 px-4 py-3">
        <div className="flex items-center gap-3 text-sm font-semibold text-ink">
          <StatusBadge status={item.status} />
          <span className="font-mono text-xs text-ink-dim">{item.sample_id}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-muted">
            {t('results.position', { current, total })}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
            aria-label={t('common.cancel')}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col md:flex-row">
          {/* Left panel — input images */}
          <div className="flex h-1/2 flex-col border-b border-surface-800 p-4 md:h-full md:w-2/5 md:border-b-0 md:border-r">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-muted">
              {t('results.inputImages')}
            </h2>
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-surface-800 bg-surface-900/50 p-2">
              {mainSrc ? (
                <img
                  src={mainSrc}
                  alt=""
                  className="max-h-full max-w-full rounded-md object-contain"
                />
              ) : (
                <div className="flex flex-col items-center gap-2 text-ink-dim">
                  <ImageIcon size={32} />
                  <span className="text-xs">{t('results.noImages')}</span>
                </div>
              )}
            </div>

            {images.length > 1 && (
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {images.map((image, index) => {
                  const src = resolveImageSrc(image);
                  return (
                    <button
                      key={`${src}-${index}`}
                      type="button"
                      onClick={() => setMainImageIndex(index)}
                      className={`shrink-0 overflow-hidden rounded-md border transition-colors ${
                        index === mainImageIndex
                          ? 'border-accent ring-1 ring-accent'
                          : 'border-surface-700 hover:border-surface-500'
                      }`}
                    >
                      {src ? (
                        <img
                          src={src}
                          alt=""
                          className="h-14 w-14 object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-14 w-14 items-center justify-center text-ink-dim">
                          <ImageIcon size={14} />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {vars && Object.keys(vars).length > 0 && (
              <div className="mt-4 space-y-2">
                <h3 className="text-xs font-medium text-ink-muted">{t('task.example.vars')}</h3>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  {Object.entries(vars).map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt className="text-ink-dim">{key}</dt>
                      <dd className="truncate text-ink">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>

          {/* Right panel — response */}
          <div className="flex h-1/2 flex-col md:h-full md:w-3/5">
            <div className="flex-1 space-y-4 overflow-auto p-5">
              <section>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                  {t('result.parsed')}
                </h2>
                <ParsedOutputView
                  parsed={parsed}
                  parseStatus={parseStatus}
                  fallbackText={rawText}
                />
              </section>

              <ReasoningBlock reasoningText={reasoningText} />

              <CollapsibleSection title={t('result.raw')} icon={<span className="font-mono text-[10px]">{'{}'}</span>}>
                <pre className="max-h-96 overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
                  {rawText || t('result.noRawOutput')}
                </pre>
              </CollapsibleSection>

              <CollapsibleSection title={t('results.metadata')}>
                <div className="rounded-md border border-surface-800 bg-surface-950 p-3 text-xs">
                  <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2">
                    <dt className="text-ink-dim">{t('results.model')}</dt>
                    <dd className="text-ink">{item.model_id ?? '—'}</dd>

                    <dt className="text-ink-dim">{t('history.providerId')}</dt>
                    <dd className="text-ink">{item.provider_id ?? '—'}</dd>

                    <dt className="text-ink-dim">{t('results.latency')}</dt>
                    <dd className="font-mono text-ink">{formatLatency(item.latency_ms)}</dd>

                    <dt className="text-ink-dim">{t('results.cost')}</dt>
                    <dd className="text-ink">
                      {costCurrency} {item.estimated_cost.toFixed(6)}
                    </dd>

                    <dt className="text-ink-dim">{t('results.tokens')}</dt>
                    <dd className="font-mono text-ink">
                      {(() => {
                        const hasTokens =
                          totalTokens != null || inputTokens != null || outputTokens != null;
                        if (!hasTokens) return '—';
                        const displayTotal =
                          totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0);
                        return (reasoningTokens ?? 0) > 0
                          ? `${displayTotal} (${inputTokens ?? 0} / ${outputTokens ?? 0} / ${reasoningTokens} thinking)`
                          : `${displayTotal} (${inputTokens ?? 0} / ${outputTokens ?? 0})`;
                      })()}
                    </dd>

                    {imageCount !== undefined && (
                      <>
                        <dt className="text-ink-dim">{t('result.image')}</dt>
                        <dd className="text-ink">{imageCount}</dd>
                      </>
                    )}

                    <dt className="text-ink-dim">{t('batch.status')}</dt>
                    <dd className="text-ink">
                      <StatusBadge status={item.status} />
                    </dd>
                  </dl>
                </div>
              </CollapsibleSection>
            </div>

            {/* Review toolbar */}
            <div className="border-t border-surface-800 bg-surface-900/80 p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-muted">{t('results.accepted')}</span>
                    <div className="flex items-center gap-1">
                      <ReviewToggleButton
                        active={review.accepted === true}
                        onClick={() => onAccepted(item, review.accepted === true ? null : true)}
                        disabled={savingReview}
                        icon={<Check size={14} />}
                        label={t('results.accepted')}
                        color="success"
                      />
                      <ReviewToggleButton
                        active={review.accepted === false}
                        onClick={() => onAccepted(item, review.accepted === false ? null : false)}
                        disabled={savingReview}
                        icon={<X size={14} />}
                        label={t('results.rejected')}
                        color="danger"
                      />
                      <ReviewToggleButton
                        active={review.accepted === null}
                        onClick={() => onAccepted(item, null)}
                        disabled={savingReview}
                        icon={<Circle size={14} />}
                        label={t('results.pending')}
                        color="muted"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-muted">{t('results.rating')}</span>
                    <div className="flex items-center gap-0.5">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          onClick={() => onRating(item, star)}
                          disabled={savingReview}
                          className={`rounded p-1 transition-colors ${
                            review.rating !== null && star <= review.rating
                              ? 'text-cost'
                              : 'text-surface-600 hover:text-ink-muted'
                          } disabled:opacity-50`}
                          aria-label={`${t('results.rating')} ${star}`}
                        >
                          <Star size={16} fill={review.rating !== null && star <= review.rating ? 'currentColor' : 'none'} />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex flex-1 items-center gap-2 lg:justify-end">
                  <span className="text-xs text-ink-muted">{t('results.notes')}</span>
                  <input
                    type="text"
                    value={notesDraft}
                    onChange={(event) => setNotesDraft(event.target.value)}
                    onBlur={(event) => onNotesBlur(item, event.target.value)}
                    placeholder={t('results.notesPlaceholder')}
                    disabled={savingReview}
                    className="w-full max-w-md rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none disabled:opacity-50"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom navigation */}
      <div className="flex items-center justify-between border-t border-surface-800 bg-surface-900/80 px-4 py-3">
        <button
          type="button"
          onClick={onPrev}
          className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:border-surface-500 hover:text-ink"
        >
          <ChevronLeft size={14} />
          {t('image.prevImage')}
        </button>
        <span className="text-xs text-ink-muted">{t('results.position', { current, total })}</span>
        <button
          type="button"
          onClick={onNext}
          className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:border-surface-500 hover:text-ink"
        >
          {t('image.nextImage')}
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

interface CompareOverlayProps {
  items: RunItemSummary[];
  savingReview: boolean;
  onAccepted: (item: RunItemSummary, value: boolean | null) => void;
  onRating: (item: RunItemSummary, value: number) => void;
  onClose: () => void;
  t: I18n['t'];
}

function CompareOverlay({
  items,
  savingReview,
  onAccepted,
  onRating,
  onClose,
  t,
}: CompareOverlayProps) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-surface-950/90 backdrop-blur"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex items-center justify-between border-b border-surface-800 bg-surface-900/80 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Columns3 size={16} className="text-accent" />
          {t('results.compare')} · {items.length}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex h-full gap-4 p-4">
          {items.map((item) => {
            const images = extractImagesFromSnapshot(item.internal_request_snapshot);
            const firstImage = images[0];
            const src = firstImage ? resolveImageSrc(firstImage) : '';
            const review = extractReview(item.review);
            const rawText = extractRawText(item.response);
            const parsed = item.response.parsed;
            const parseStatus = extractParseStatus(item.response);
            const reasoningText = extractReasoningText(item.response);

            return (
              <div
                key={item.run_item_id}
                className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-surface-700 bg-surface-900"
              >
                {/* Image */}
                <div className="h-40 shrink-0 bg-surface-950">
                  {src ? (
                    <img src={src} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-ink-dim">
                      <ImageIcon size={24} />
                    </div>
                  )}
                </div>

                {/* sample_id */}
                <div className="border-b border-surface-800 px-3 py-2">
                  <span className="truncate font-mono text-[10px] text-ink-dim">
                    {item.sample_id}
                  </span>
                  <span className="ml-2">
                    <StatusBadge status={item.status} />
                  </span>
                </div>

                {/* Response */}
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  <ParsedOutputView
                    parsed={parsed}
                    parseStatus={parseStatus}
                    fallbackText={rawText}
                  />
                  {reasoningText && <ReasoningBlock reasoningText={reasoningText} />}
                </div>

                {/* Review toolbar */}
                <div className="border-t border-surface-800 p-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onAccepted(item, review.accepted === true ? null : true)}
                      disabled={savingReview}
                      className={`rounded p-1.5 transition-colors disabled:opacity-50 ${
                        review.accepted === true
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'text-ink-muted hover:text-emerald-400'
                      }`}
                    >
                      <Check size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onAccepted(item, review.accepted === false ? null : false)}
                      disabled={savingReview}
                      className={`rounded p-1.5 transition-colors disabled:opacity-50 ${
                        review.accepted === false
                          ? 'bg-danger/10 text-danger'
                          : 'text-ink-muted hover:text-danger'
                      }`}
                    >
                      <X size={14} />
                    </button>
                    <div className="ml-2 flex items-center gap-0.5">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          onClick={() => onRating(item, star)}
                          disabled={savingReview}
                          className={`rounded p-0.5 transition-colors disabled:opacity-50 ${
                            review.rating !== null && star <= review.rating
                              ? 'text-cost'
                              : 'text-surface-600 hover:text-ink-muted'
                          }`}
                        >
                          <Star
                            size={14}
                            fill={review.rating !== null && star <= review.rating ? 'currentColor' : 'none'}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface ReviewToggleButtonProps {
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  color: 'success' | 'danger' | 'muted';
}

function ReviewToggleButton({ active, onClick, disabled, icon, label, color }: ReviewToggleButtonProps) {
  const colorClasses = {
    success: active
      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
      : 'border-surface-700 text-ink-muted hover:border-emerald-500/30 hover:text-emerald-400',
    danger: active
      ? 'border-danger/50 bg-danger/10 text-danger'
      : 'border-surface-700 text-ink-muted hover:border-danger/30 hover:text-danger',
    muted: active
      ? 'border-surface-500 bg-surface-800 text-ink'
      : 'border-surface-700 text-ink-muted hover:border-surface-500 hover:text-ink',
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`inline-flex items-center justify-center rounded-md border p-1.5 transition-colors disabled:opacity-50 ${colorClasses[color]}`}
      aria-label={label}
    >
      {icon}
    </button>
  );
}

function ReviewBadge({ review }: { review: ReviewState }) {
  const { t } = useI18n();
  if (review.accepted === true) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
        <Check size={10} />
        {t('results.accepted')}
      </span>
    );
  }
  if (review.accepted === false) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
        <XCircle size={10} />
        {t('results.rejected')}
      </span>
    );
  }
  return null;
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const normalized = status.toLowerCase();

  if (normalized === 'succeeded' || normalized === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
        <Check size={10} />
        {t('result.succeeded')}
      </span>
    );
  }
  if (normalized === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
        <XCircle size={10} />
        {t('result.failed')}
      </span>
    );
  }
  if (normalized === 'running') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
        <Loader2 size={10} className="animate-spin" />
        {t('result.running')}
      </span>
    );
  }
  if (normalized === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
        {t('result.cancelled')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-800 px-2 py-0.5 text-[10px] font-medium text-ink-muted">
      {t('result.pending')}
    </span>
  );
}

interface ReviewState {
  accepted: boolean | null;
  rating: number | null;
  notes: string;
}

function extractReview(review: Record<string, unknown>): ReviewState {
  const accepted = review.accepted;
  const rating = review.rating;
  const notes = review.notes;
  return {
    accepted: typeof accepted === 'boolean' ? accepted : null,
    rating: typeof rating === 'number' ? rating : null,
    notes: typeof notes === 'string' ? notes : '',
  };
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

function extractVars(snapshot: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!snapshot) return null;
  const prompt = snapshot.prompt as Record<string, unknown> | undefined;
  if (!prompt) return null;
  const renderContext = prompt.render_context as Record<string, unknown> | undefined;
  if (!renderContext) return null;
  const vars = renderContext.vars;
  return typeof vars === 'object' && vars !== null && !Array.isArray(vars)
    ? (vars as Record<string, unknown>)
    : null;
}

function getNumberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' ? value : undefined;
}

function getStringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function formatLatency(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

