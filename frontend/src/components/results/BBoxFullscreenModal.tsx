import { ImageOff, Loader2, ScanSearch, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useI18n } from '../../i18n';
import type { BBox, ImageRef } from '../../types';
import { clamp01 } from '../../utils/bbox';
import { resolveImageSrc } from '../lab/ImagePanel';
import { BBoxDetailPanel } from './BBoxDetailPanel';
import { BBoxOverlay, PALETTE } from './BBoxOverlay';

interface BBoxFullscreenModalProps {
  image: ImageRef;
  boxes?: BBox[] | null;
  alt?: string;
  onClose: () => void;
}

/**
 * Fullscreen viewer for an annotated image: large image with the bbox
 * overlay on the left, a detail list on the right (stacked below on small
 * screens). Hovering a detail row boosts the matching rectangle via a
 * dedicated highlight layer (BBoxOverlay itself stays untouched).
 *
 * Deliberately composes img + BBoxOverlay directly instead of reusing
 * AnnotatedImage — a fullscreen trigger inside a fullscreen modal would
 * recurse.
 */
export function BBoxFullscreenModal({ image, boxes, alt, onClose }: BBoxFullscreenModalProps) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const src = resolveImageSrc(image);
  const visibleBoxes = boxes ?? [];
  const hoveredBox = hoveredIndex != null ? visibleBoxes[hoveredIndex] : undefined;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-surface-950/95 backdrop-blur"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('result.bbox.detailTitle')}
    >
      <div
        className="flex items-center justify-between border-b border-surface-800 bg-surface-900/80 px-4 py-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ScanSearch size={16} className="text-accent" />
          {t('result.bbox.detailTitle')}
          {visibleBoxes.length > 0 && (
            <span className="rounded-full bg-surface-800 px-2 py-0.5 text-xs text-ink-muted">
              {visibleBoxes.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('result.bbox.closeFullscreen')}
          aria-label={t('result.bbox.closeFullscreen')}
          className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          {failed || !src ? (
            <div className="flex flex-col items-center gap-2 text-ink-dim">
              <ImageOff size={24} />
              <span className="text-xs">{t('result.annotatedImageFailed')}</span>
            </div>
          ) : (
            <div className="relative inline-block max-w-full">
              {!loaded && (
                <div className="flex items-center justify-center py-16">
                  <Loader2 size={20} className="animate-spin text-ink-dim" />
                </div>
              )}
              <img
                src={src}
                alt={alt ?? image.display_name ?? image.role ?? 'input'}
                onLoad={() => setLoaded(true)}
                onError={() => setFailed(true)}
                className={[
                  'block h-auto max-w-full rounded-sm',
                  loaded ? '' : 'absolute inset-0 opacity-0',
                ].join(' ')}
                style={{ maxHeight: '76vh' }}
              />
              {loaded && visibleBoxes.length > 0 && <BBoxOverlay boxes={visibleBoxes} />}
              {loaded && hoveredBox && (
                <HighlightRect
                  box={hoveredBox}
                  color={PALETTE[(hoveredIndex ?? 0) % PALETTE.length]}
                />
              )}
            </div>
          )}
        </div>

        {visibleBoxes.length > 0 && (
          <aside className="shrink-0 overflow-auto border-t border-surface-800 max-md:max-h-56 md:w-80 md:border-l md:border-t-0">
            <BBoxDetailPanel
              boxes={visibleBoxes}
              hoveredIndex={hoveredIndex}
              onHover={setHoveredIndex}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

/**
 * Extra emphasis layer for the row-hovered box: drawn above BBoxOverlay
 * with a stronger fill and thicker stroke, using the same palette color.
 */
function HighlightRect({ box, color }: { box: BBox; color: string }) {
  const x1 = clamp01(box.x1);
  const y1 = clamp01(box.y1);
  const x2 = clamp01(box.x2);
  const y2 = clamp01(box.y2);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect
        x={x1}
        y={y1}
        width={x2 - x1}
        height={y2 - y1}
        strokeWidth={3}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        style={{ fill: color, stroke: color, fillOpacity: 0.28 }}
      />
    </svg>
  );
}
