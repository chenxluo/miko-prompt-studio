import type { CSSProperties } from 'react';

import type { BBox } from '../../types';

/**
 * Cyclic palette for distinguishing multiple boxes.
 * First box always uses the app accent (teal); the rest rotate through
 * harmonious dark-theme hues. Keep in sync with html_export rendering.
 */
export const PALETTE = ['#2dd4bf', '#fbbf24', '#38bdf8', '#a78bfa'];

/** Text color printed on top of the solid label badge (matches surface-900). */
const BADGE_TEXT_COLOR = '#0f172a';

interface BBoxOverlayProps {
  boxes: BBox[];
}

interface NormalizedBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string | null;
  color: string;
}

/**
 * Read-only SVG overlay for normalized ([0,1] xyxy) bounding boxes.
 *
 * Alignment contract: this component absolutely fills its parent, so the
 * parent element MUST wrap the displayed image tightly (i.e. its rendered
 * size equals the image's rendered size — see AnnotatedImage). Normalized
 * bbox coordinates then map 1:1 onto percentages / the unit viewBox.
 */
export function BBoxOverlay({ boxes }: BBoxOverlayProps) {
  const normalized = boxes
    .map((box, index) => normalizeBox(box, PALETTE[index % PALETTE.length]))
    .filter((box): box is NormalizedBox => box !== null);

  if (normalized.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0">
      <svg
        className="pointer-events-auto absolute inset-0 h-full w-full"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {normalized.map((box, index) => (
          <g key={index} className="group">
            <rect
              x={box.x1}
              y={box.y1}
              width={box.x2 - box.x1}
              height={box.y2 - box.y1}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              className="transition-[fill-opacity] duration-150 [fill-opacity:0.08] group-hover:[fill-opacity:0.22]"
              style={{ fill: box.color, stroke: box.color }}
            />
          </g>
        ))}
      </svg>
      {normalized.map((box, index) =>
        box.label ? <BoxLabel key={index} box={box} /> : null,
      )}
    </div>
  );
}

/**
 * Small badge anchored to the box's top-left corner. Sits just above the
 * stroke when there is headroom, otherwise flips inside the box so it never
 * clips outside the image. Long labels are truncated (full text in title).
 */
function BoxLabel({ box }: { box: NormalizedBox }) {
  const nearTop = box.y1 < 0.09;
  const nearRight = box.x1 > 0.55;

  const vertical: CSSProperties = nearTop
    ? { top: `${box.y1 * 100}%`, marginTop: 3 }
    : { top: `${box.y1 * 100}%`, transform: 'translateY(calc(-100% - 3px))' };

  const horizontal: CSSProperties = nearRight
    ? { right: `${(1 - box.x2) * 100}%` }
    : { left: `${box.x1 * 100}%` };

  return (
    <span
      className="absolute max-w-[55%] truncate rounded-sm px-1.5 py-0.5 text-[11px] font-medium leading-tight"
      style={{
        ...vertical,
        ...horizontal,
        backgroundColor: box.color,
        color: BADGE_TEXT_COLOR,
      }}
      title={box.label ?? undefined}
    >
      {box.label}
    </span>
  );
}

/** Clamp coordinates into [0,1] (model output may overshoot the edges). */
function normalizeBox(box: BBox, color: string): NormalizedBox | null {
  const x1 = clamp01(box.x1);
  const y1 = clamp01(box.y1);
  const x2 = clamp01(box.x2);
  const y2 = clamp01(box.y2);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  const label = typeof box.label === 'string' && box.label.trim() ? box.label.trim() : null;
  return { x1, y1, x2, y2, label, color };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
