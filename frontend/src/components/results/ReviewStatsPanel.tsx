import { useMemo } from 'react';

import { useI18n } from '../../i18n';
import type { RunItemSummary } from '../../types';

// item.review is typed as Record<string, unknown> on RunItemSummary, so each
// field is read defensively here rather than via the (label-dropping)
// extractReview helper used elsewhere in ResultsView.

// ponytail: variant key collapses to model_id for non-compare runs; config_label
// (compare runs) wins so a shared model across prompt/config variants stays split.
function variantKeyOf(item: RunItemSummary): string {
  return item.compare_axes?.config_label ?? item.compare_axes?.task_version_id ?? item.model_id ?? '—';
}

const HEADING_CLASS = 'text-[11px] font-semibold uppercase tracking-wider text-ink-muted';

interface VariantBucket {
  total: number;
  acceptedN: number;
  rejectedN: number;
  ratingSum: number;
  ratingCount: number;
  modelIds: Set<string>;
}

export function ReviewStatsPanel({ items }: { items: RunItemSummary[] }) {
  const { t } = useI18n();

  const agg = useMemo(() => {
    let acceptedN = 0;
    let rejectedN = 0;
    let ratingSum = 0;
    let ratingCount = 0;
    const ratingDist = [0, 0, 0, 0, 0]; // index 0 => 1 star
    const labelCounts = new Map<string, number>();
    const variants = new Map<string, VariantBucket>();

    for (const item of items) {
      const review = item.review;
      const accepted = typeof review?.accepted === 'boolean' ? review.accepted : null;
      if (accepted === true) acceptedN++;
      else if (accepted === false) rejectedN++;

      const rawRating = review?.rating;
      const rating =
        typeof rawRating === 'number' && Number.isFinite(rawRating) && rawRating >= 1 && rawRating <= 5
          ? rawRating
          : null;
      if (rating != null) {
        ratingSum += rating;
        ratingCount++;
        if (Number.isInteger(rating)) ratingDist[rating - 1]++;
      }

      const rawLabels = review?.labels;
      const labels = Array.isArray(rawLabels)
        ? rawLabels.filter((x): x is string => typeof x === 'string')
        : [];
      for (const label of labels) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }

      const variant = variantKeyOf(item);
      const modelId = item.model_id ?? '—';
      let bucket = variants.get(variant);
      if (!bucket) {
        bucket = { total: 0, acceptedN: 0, rejectedN: 0, ratingSum: 0, ratingCount: 0, modelIds: new Set() };
        variants.set(variant, bucket);
      }
      bucket.total++;
      if (accepted === true) bucket.acceptedN++;
      else if (accepted === false) bucket.rejectedN++;
      if (rating != null) {
        bucket.ratingSum += rating;
        bucket.ratingCount++;
      }
      bucket.modelIds.add(modelId);
    }

    const total = items.length;
    const judgedN = acceptedN + rejectedN;
    const undecidedN = total - judgedN;
    const passRate = judgedN > 0 ? acceptedN / judgedN : null;
    const avgRating = ratingCount > 0 ? ratingSum / ratingCount : null;
    const maxDist = Math.max(1, ...ratingDist);

    const topLabels = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const maxLabel = topLabels.length ? Math.max(1, topLabels[0][1]) : 1;

    const variantEntries = [...variants.entries()]
      .map(([variant, b]) => {
        const judged = b.acceptedN + b.rejectedN;
        return {
          variant,
          modelDisplay: [...b.modelIds].sort().join(', '),
          total: b.total,
          acceptedN: b.acceptedN,
          rejectedN: b.rejectedN,
          undecidedN: b.total - judged,
          passRate: judged > 0 ? b.acceptedN / judged : null,
          avgRating: b.ratingCount > 0 ? b.ratingSum / b.ratingCount : null,
        };
      })
      .sort((a, b) => b.total - a.total);

    const realVariantCount = new Set(items.map(variantKeyOf).filter((v) => v !== '—')).size;

    return {
      total,
      acceptedN,
      rejectedN,
      undecidedN,
      judgedN,
      passRate,
      ratingCount,
      avgRating,
      ratingDist,
      maxDist,
      topLabels,
      maxLabel,
      variantEntries,
      showVariantTable: realVariantCount >= 2,
    };
  }, [items]);

  const hasSignal =
    agg.acceptedN + agg.rejectedN > 0 || agg.ratingCount > 0 || agg.topLabels.length > 0;

  return (
    <section className="panel space-y-4 p-4">
      {!hasSignal ? (
        <p className="text-xs text-ink-muted">{t('results.reviewStats.noReviews')}</p>
      ) : (
        <>
          <h2 className={HEADING_CLASS}>{t('results.reviewStats.title')}</h2>

          {/* metric row */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <span className="text-ink">
              <span className="text-ink-dim">{t('results.reviewStats.total')}:</span>{' '}
              <span className="font-semibold">{agg.total}</span>
            </span>

            <span className="text-ink">
              <span className="text-ink-dim">{t('results.reviewStats.passRate')}:</span>{' '}
              <span className="font-semibold text-accent">
                {agg.passRate != null ? `${Math.round(agg.passRate * 100)}%` : '—'}
              </span>
              <span className="ml-1 text-[10px] text-ink-dim">
                {agg.acceptedN}/{agg.judgedN} {t('results.reviewStats.judged')}
              </span>
            </span>

            <span className="text-ink">
              <span className="text-ink-dim">{t('results.reviewStats.accepted')}:</span>{' '}
              <span className="font-semibold text-emerald-400">{agg.acceptedN}</span>
            </span>

            <span className="text-ink">
              <span className="text-ink-dim">{t('results.reviewStats.rejected')}:</span>{' '}
              <span className="font-semibold text-danger">{agg.rejectedN}</span>
            </span>

            <span className="text-ink">
              <span className="text-ink-dim">{t('results.reviewStats.undecided')}:</span>{' '}
              <span className="font-semibold text-ink-muted">{agg.undecidedN}</span>
            </span>

            <span className="text-ink">
              <span className="text-ink-dim">{t('results.reviewStats.avgRating')}:</span>{' '}
              <span className="font-semibold text-amber-400">
                ★ {agg.avgRating != null ? agg.avgRating.toFixed(1) : '—'}
              </span>
              <span className="ml-1 text-[10px] text-ink-dim">
                {agg.ratingCount} {t('results.reviewStats.rated')}
              </span>
            </span>
          </div>

          {/* rating distribution */}
          {agg.ratingCount > 0 && (
            <div className="space-y-1.5">
              <h3 className={HEADING_CLASS}>{t('results.reviewStats.ratingDist')}</h3>
              {agg.ratingDist.map((count, i) => {
                const star = i + 1;
                const pct = (count / agg.maxDist) * 100;
                return (
                  <div key={star} className="flex items-center gap-2 text-xs">
                    <span className="w-6 text-amber-400">★{star}</span>
                    <div className="h-2 flex-1 rounded bg-surface-800">
                      <div className="h-2 rounded bg-amber-500" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-8 text-right font-mono text-ink-muted">{count}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* label frequency */}
          {agg.topLabels.length > 0 && (
            <div className="space-y-1.5">
              <h3 className={HEADING_CLASS}>{t('results.reviewStats.labelFreq')}</h3>
              {agg.topLabels.map(([label, count]) => {
                const pct = (count / agg.maxLabel) * 100;
                return (
                  <div key={label} className="flex items-center gap-2 text-xs">
                    <span className="w-28 shrink-0 truncate text-ink-dim" title={label}>
                      {label}
                    </span>
                    <div className="h-2 flex-1 rounded bg-surface-800">
                      <div className="h-2 rounded bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-8 text-right font-mono text-ink-muted">{count}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* by-variant breakdown */}
          {agg.showVariantTable && agg.variantEntries.length > 0 && (
            <div className="space-y-1.5">
              <h3 className={HEADING_CLASS}>{t('results.reviewStats.byVariant')}</h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-800 text-ink-dim">
                    <th className="px-2 py-1.5 text-left">{t('results.reviewStats.variant')}</th>
                    <th className="px-2 py-1.5 text-right">{t('results.reviewStats.total')}</th>
                    <th className="px-2 py-1.5 text-right">{t('results.reviewStats.accepted')}</th>
                    <th className="px-2 py-1.5 text-right">{t('results.reviewStats.rejected')}</th>
                    <th className="px-2 py-1.5 text-right">{t('results.reviewStats.undecided')}</th>
                    <th className="px-2 py-1.5 text-right">{t('results.reviewStats.passRate')}</th>
                    <th className="px-2 py-1.5 text-right">{t('results.reviewStats.avgRating')}</th>
                  </tr>
                </thead>
                <tbody>
                  {agg.variantEntries.map((row) => (
                    <tr key={row.variant} className="border-b border-surface-800/50">
                      <td className="px-2 py-1.5 text-left">
                        <div className="font-medium text-ink">{row.variant}</div>
                        <div className="text-[10px] font-mono text-ink-dim">{row.modelDisplay}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-ink">{row.total}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-emerald-400">
                        {row.acceptedN}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-danger">
                        {row.rejectedN}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-ink-muted">
                        {row.undecidedN}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-ink">
                        {row.passRate != null ? `${Math.round(row.passRate * 100)}%` : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-ink">
                        {row.avgRating != null ? row.avgRating.toFixed(1) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
