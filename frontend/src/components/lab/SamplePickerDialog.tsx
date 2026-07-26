import {
  AlertCircle,
  Check,
  Database,
  ImageIcon,
  Loader2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import * as api from '../../api/client';
import { useI18n } from '../../i18n';
import { toStableVarString } from '../../store/labStore';
import type { ImageRef } from '../../types';

import { resolveImageSrc } from './ImagePanel';

interface SamplePickerDialogProps {
  open: boolean;
  onClose: () => void;
  onApply: (sample: api.SampleListItem) => void;
}

export function SamplePickerDialog({ open, onClose, onApply }: SamplePickerDialogProps) {
  const { t } = useI18n();

  const [sampleSets, setSampleSets] = useState<api.SampleSetListItem[]>([]);
  const [isLoadingSets, setIsLoadingSets] = useState(false);
  const [setsError, setSetsError] = useState<string | null>(null);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);

  // Samples are paged in (PAGE_SIZE at a time) so 5k-row sets don't block the
  // dialog. We append, never overwrite, on "load more" so the user keeps both
  // already-rendered rows and any selection they made.
  const PAGE_SIZE = 40;
  const [samples, setSamples] = useState<api.SampleListItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingSamples, setIsLoadingSamples] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [samplesError, setSamplesError] = useState<string | null>(null);
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);
  const [samplesRetryKey, setSamplesRetryKey] = useState(0);

  const closeBtnRef = useRef<HTMLButtonElement>(null);
  // Mirror of selectedSetId that loadMore can read inside async callbacks to
  // detect "set switched while this request was in flight".
  const selectedSetIdRef = useRef<string | null>(null);
  const requestVersionRef = useRef(0);
  useEffect(() => {
    selectedSetIdRef.current = selectedSetId;
  }, [selectedSetId]);

  // Load sample sets when the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsLoadingSets(true);
    setSetsError(null);
    api
      .listSampleSets()
      .then((sets) => {
        if (cancelled) return;
        setSampleSets(sets);
        setSelectedSetId((current) => current ?? sets[0]?.sample_set_id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setSetsError(err instanceof Error ? err.message : t('samplePicker.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingSets(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);
  const selectedSet = useMemo(
    () => sampleSets.find((s) => s.sample_set_id === selectedSetId) ?? null,
    [sampleSets, selectedSetId],
  );
  // Total rows declared by the set; 0 means "unknown" → fall back to last-page
  // length heuristic to decide whether more pages might exist.
  const declaredTotal = selectedSet?.record_ids?.length ?? 0;

  // Reset the paged list whenever the user switches sets (or opens fresh).
  // Race protection: every effect run gets its own `cancelled` flag and only
  // commits state if it is still the latest run, so a slow first page can't
  // overwrite a newer set's data.
  useEffect(() => {
    const requestVersion = ++requestVersionRef.current;
    if (!open || !selectedSetId) {
      setSamples([]);
      setHasMore(true);
      setSamplesError(null);
      setIsLoadingSamples(false);
      setIsLoadingMore(false);
      return;
    }
    let cancelled = false;
    setIsLoadingSamples(true);
    setIsLoadingMore(false);
    setSamplesError(null);
    setSamples([]);
    setHasMore(true);
    setSelectedSampleId(null);
    api
      .listSamples(selectedSetId, PAGE_SIZE, 0)
      .then((records) => {
        if (cancelled || requestVersion !== requestVersionRef.current) return;
        setSamples(records);
        setHasMore(
          records.length === PAGE_SIZE
            && (declaredTotal === 0 || PAGE_SIZE < declaredTotal),
        );
      })
      .catch((err) => {
        if (cancelled || requestVersion !== requestVersionRef.current) return;
        setSamplesError(err instanceof Error ? err.message : t('samplePicker.loadFailed'));
      })
      .finally(() => {
        if (!cancelled && requestVersion === requestVersionRef.current) setIsLoadingSamples(false);
      });
    return () => {
      cancelled = true;
    };
    // declaredTotal is intentionally not a dep — changing it shouldn't refetch;
    // we only re-derive `hasMore` from it inside the response handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedSetId, t, samplesRetryKey]);

  // Append the next page; failures keep previously-loaded rows intact so the
  // user can retry without losing context.
  const loadMore = useCallback(() => {
    if (!selectedSetId || isLoadingMore || isLoadingSamples || !hasMore) return;
    const offset = samples.length;
    const requestVersion = requestVersionRef.current;
    setIsLoadingMore(true);
    setSamplesError(null);
    api
      .listSamples(selectedSetId, PAGE_SIZE, offset)
      .then((records) => {
        if (
          selectedSetId !== selectedSetIdRef.current
          || requestVersion !== requestVersionRef.current
        ) return;
        setSamples((prev) => {
          // Dedup by sample_id in case a stale request lands after a newer one.
          const seen = new Set(prev.map((s) => s.sample_id));
          const next = records.filter((r) => !seen.has(r.sample_id));
          return [...prev, ...next];
        });
        setHasMore(
          records.length === PAGE_SIZE
            && (declaredTotal === 0 || offset + records.length < declaredTotal),
        );
      })
      .catch((err) => {
        if (
          selectedSetId !== selectedSetIdRef.current
          || requestVersion !== requestVersionRef.current
        ) return;
        setSamplesError(err instanceof Error ? err.message : t('samplePicker.loadFailed'));
      })
      .finally(() => {
        if (
          selectedSetId === selectedSetIdRef.current
          && requestVersion === requestVersionRef.current
        ) setIsLoadingMore(false);
      });
  }, [selectedSetId, isLoadingMore, isLoadingSamples, hasMore, samples.length, declaredTotal, t]);

  const applySample = useCallback(
    (sample: api.SampleListItem) => {
      onApply(sample);
      onClose();
    },
    [onApply, onClose],
  );

  const selectedSample = useMemo(
    () => samples.find((s) => s.sample_id === selectedSampleId) ?? null,
    [samples, selectedSampleId],
  );

  // Esc to close + move focus into the dialog when it opens.
  useEffect(() => {
    if (!open) return;
    closeBtnRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('samplePicker.title')}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <Database size={16} className="text-accent" />
            <div>
              <h2 className="text-sm font-semibold text-ink">{t('samplePicker.title')}</h2>
              <p className="text-[10px] leading-tight text-ink-dim">{t('samplePicker.description')}</p>
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label={t('samplePicker.close')}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden sm:grid-cols-[14rem_1fr]">
          {/* Sample sets */}
          <div className="flex min-h-0 flex-col border-b border-surface-800 sm:border-b-0 sm:border-r">
            <div className="shrink-0 border-b border-surface-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              {t('samplePicker.sampleSets')}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {isLoadingSets ? (
                <div className="flex items-center gap-2 px-2 py-3 text-xs text-ink-muted">
                  <Loader2 size={14} className="animate-spin" />
                  {t('samplePicker.loading')}
                </div>
              ) : setsError ? (
                <div className="flex items-start gap-2 rounded-md bg-danger/10 px-2 py-2 text-xs text-danger">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span>{setsError}</span>
                </div>
              ) : sampleSets.length === 0 ? (
                <div className="px-2 py-3 text-xs text-ink-dim">{t('samplePicker.noSets')}</div>
              ) : (
                <ul className="flex flex-col gap-1">
                  {sampleSets.map((set) => (
                    <li key={set.sample_set_id}>
                      <button
                        type="button"
                        onClick={() => setSelectedSetId(set.sample_set_id)}
                        aria-pressed={selectedSetId === set.sample_set_id}
                        className={[
                          'flex w-full flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors',
                          selectedSetId === set.sample_set_id
                            ? 'border-accent/50 bg-accent/10'
                            : 'border-transparent hover:bg-surface-800/60',
                        ].join(' ')}
                      >
                        <span className="line-clamp-1 text-xs font-medium text-ink">
                          {set.name || set.sample_set_id}
                        </span>
                        <span className="text-[10px] text-ink-dim">
                          {(set.record_ids ?? []).length} ·{' '}
                          {set.created_at ? new Date(set.created_at).toLocaleDateString() : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Samples */}
          <div className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-surface-800 px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                {t('samplePicker.samples')}
              </span>
              <span className="text-[10px] text-ink-dim">
                {t('samplePicker.loadedCount', {
                  loaded: samples.length,
                  total: declaredTotal > 0 ? declaredTotal : samples.length,
                })}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {!selectedSetId ? (
                <div className="px-2 py-3 text-xs text-ink-dim">{t('samplePicker.selectSetHint')}</div>
              ) : isLoadingSamples ? (
                <div className="flex items-center gap-2 px-2 py-3 text-xs text-ink-muted">
                  <Loader2 size={14} className="animate-spin" />
                  {t('samplePicker.loading')}
                </div>
              ) : samplesError && samples.length === 0 ? (
                <div className="flex flex-col items-start gap-2">
                  <div className="flex items-start gap-2 rounded-md bg-danger/10 px-2 py-2 text-xs text-danger">
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                    <span>{samplesError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSamplesRetryKey((key) => key + 1)}
                    className="rounded-md border border-surface-700 bg-surface-950 px-3 py-1.5 text-xs text-ink-muted hover:border-surface-600 hover:text-ink"
                  >
                    {t('samplePicker.retry')}
                  </button>
                </div>
              ) : samples.length === 0 ? (
                <div className="px-2 py-3 text-xs text-ink-dim">{t('samplePicker.noSamples')}</div>
              ) : (
                <>
                  <ul className="flex flex-col gap-1.5">
                    {samples.map((sample) => (
                      <SampleRow
                        key={sample.sample_id}
                        sample={sample}
                        selected={sample.sample_id === selectedSampleId}
                        onSelect={() => setSelectedSampleId(sample.sample_id)}
                        onApplySample={() => applySample(sample)}
                      />
                    ))}
                  </ul>
                  {hasMore ? (
                    <div className="mt-2 flex flex-col items-center gap-1">
                      {samplesError ? (
                        <div className="flex items-start gap-1.5 text-[10px] text-danger">
                          <AlertCircle size={12} className="mt-0.5 shrink-0" />
                          <span>{samplesError}</span>
                        </div>
                      ) : null}
                      <button
                        type="button"
                        onClick={loadMore}
                        disabled={isLoadingMore}
                        className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-950 px-3 py-1.5 text-[11px] text-ink-muted transition-colors hover:border-surface-600 hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isLoadingMore ? (
 <>
                            <Loader2 size={12} className="animate-spin" />
                            {t('samplePicker.loadingMore')}
                          </>
                        ) : (
                          t('samplePicker.loadMore')
                        )}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-surface-800 px-4 py-3">
          <span className="hidden text-[10px] text-ink-dim sm:inline">
            {t('samplePicker.confirmReplace')}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-950 px-3 py-1.5 text-xs text-ink-muted transition-colors hover:border-surface-600 hover:text-ink"
            >
              {t('samplePicker.cancel')}
            </button>
            <button
              type="button"
              onClick={() => selectedSample && applySample(selectedSample)}
              disabled={!selectedSample}
              className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check size={14} />
              {t('samplePicker.apply')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SampleRowProps {
  sample: api.SampleListItem;
  selected: boolean;
  onSelect: () => void;
  onApplySample: () => void;
}

function SampleRow({ sample, selected, onSelect, onApplySample }: SampleRowProps) {
  const { t } = useI18n();
  const images = extractImages(sample);
  const vars = extractVars(sample);
  const firstImage = images[0];

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onApplySample}
        aria-pressed={selected}
        className={[
          'flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors',
          selected
            ? 'border-accent/50 bg-accent/10'
            : 'border-surface-800 bg-surface-950/40 hover:border-surface-600 hover:bg-surface-800/40',
        ].join(' ')}
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-surface-700 bg-surface-950">
          {firstImage ? (
            <img
              src={resolveImageSrc(firstImage)}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <ImageIcon size={16} className="text-ink-dim" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-ink">{sample.sample_id}</span>
            {selected && <Check size={12} className="shrink-0 text-accent" />}
          </div>
          <div className="mt-0.5 text-[10px] text-ink-dim">
            {images.length > 0
              ? t('samplePicker.imageCount', { count: images.length })
              : t('samplePicker.noImages')}
          </div>
          {vars.length > 0 ? (
            <div className="mt-1 line-clamp-2 break-all text-[10px] leading-snug text-ink-muted">
              {vars
                .map(([k, v]) => t('samplePicker.varSummary', { key: k, value: v }))
                .join('  ·  ')}
            </div>
          ) : (
            <div className="mt-1 text-[10px] text-ink-dim">{t('samplePicker.noVariables')}</div>
          )}
        </div>
      </button>
    </li>
  );
}

function extractImages(sample: api.SampleListItem): ImageRef[] {
  const images = sample.data?.images;
  return Array.isArray(images) ? (images as ImageRef[]) : [];
}

function extractVars(sample: api.SampleListItem): Array<[string, string]> {
  const vars = sample.data?.vars;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return [];
  const MAX_VAR_CHARS = 60;
  return Object.entries(vars as Record<string, unknown>)
    .slice(0, 3)
    .map(([k, v]) => {
      const raw = toStableVarString(v);
      const value = raw.length > MAX_VAR_CHARS ? `${raw.slice(0, MAX_VAR_CHARS)}…` : raw;
      return [k, value];
    });
}
