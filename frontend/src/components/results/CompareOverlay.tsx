import { Check, Columns3, ImageIcon, Loader2, Star, X, XCircle } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

import { resolveImageSrc } from '../lab/ImagePanel';
import { ParsedOutputView } from './ParsedOutputView';
import { ReasoningBlock } from './ReasoningBlock';
import type { I18n } from '../../i18n';
import { useI18n } from '../../i18n';
import type { ImageRef, RequestImage, RunItemSummary } from '../../types';

export interface CompareOverlayProps {
  items: RunItemSummary[];
  savingReview: boolean;
  onAccepted: (item: RunItemSummary, value: boolean | null) => void;
  onRating: (item: RunItemSummary, value: number) => void;
  onClose: () => void;
  t: I18n['t'];
}

export function CompareOverlay({
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
                className="flex h-full min-w-[20rem] flex-1 flex-col overflow-hidden rounded-lg border border-surface-700 bg-surface-900"
              >
                {/* Image */}
                <div className="h-40 shrink-0 bg-surface-950">
                  {src ? (
                    <img src={src} alt="" className="h-full w-full object-contain" />
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

export function ReviewToggleButton({ active, onClick, disabled, icon, label, color }: ReviewToggleButtonProps) {
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

export interface ReviewState {
  accepted: boolean | null;
  rating: number | null;
  notes: string;
}

export function extractReview(review: Record<string, unknown>): ReviewState {
  const accepted = review.accepted;
  const rating = review.rating;
  const notes = review.notes;
  return {
    accepted: typeof accepted === 'boolean' ? accepted : null,
    rating: typeof rating === 'number' ? rating : null,
    notes: typeof notes === 'string' ? notes : '',
  };
}

export function ReviewBadge({ review }: { review: ReviewState }) {
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

export function StatusBadge({ status }: { status: string }) {
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

export function extractImagesFromSnapshot(
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
