import { useI18n } from '../../i18n';
import type { BBox } from '../../types';
import { PALETTE } from './BBoxOverlay';

interface BBoxDetailPanelProps {
  boxes: BBox[];
  /** Externally controlled hover highlight (row <-> image sync). */
  hoveredIndex?: number | null;
  onHover?: (index: number | null) => void;
}

/**
 * Compact read-only list of parsed bounding boxes. Row colors match the
 * overlay palette (same index formula as BBoxOverlay) so each row maps
 * visually to its rectangle on the image.
 */
export function BBoxDetailPanel({ boxes, hoveredIndex, onHover }: BBoxDetailPanelProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-0.5 p-2">
      {boxes.map((box, index) => {
        const color = PALETTE[index % PALETTE.length];
        const label =
          typeof box.label === 'string' && box.label.trim() ? box.label.trim() : null;
        const rawMatch =
          typeof box.raw_match === 'string' && box.raw_match ? box.raw_match : null;

        return (
          <div
            key={index}
            className={[
              'rounded-md px-2 py-1.5 transition-colors',
              hoveredIndex === index ? 'bg-surface-800' : 'hover:bg-surface-800/60',
            ].join(' ')}
            onMouseEnter={() => onHover?.(index)}
            onMouseLeave={() => onHover?.(null)}
          >
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: color }}
              />
              <span className="shrink-0 font-mono text-[10px] text-ink-dim">
                #{index + 1}
              </span>
              {label ? (
                <span className="truncate text-xs text-ink" title={label}>
                  {label}
                </span>
              ) : (
                <span className="text-xs italic text-ink-dim">
                  {t('result.bbox.unlabeled')}
                </span>
              )}
            </div>
            <div className="mt-0.5 pl-[26px] font-mono text-[10px] text-ink-muted">
              {formatCoord(box.x1)}, {formatCoord(box.y1)} → {formatCoord(box.x2)},{' '}
              {formatCoord(box.y2)}
            </div>
            {rawMatch && (
              <div
                className="truncate pl-[26px] font-mono text-[10px] text-ink-dim"
                title={rawMatch}
              >
                {rawMatch}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatCoord(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : '—';
}
