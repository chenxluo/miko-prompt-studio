import type { BBox, ImageRef } from '../types';

/**
 * Safely read response.boxes (null/undefined = parser disabled, [] = no
 * matches). Tolerates malformed entries — anything without numeric xyxy
 * coordinates is dropped.
 */
export function extractBoxes(
  response: Record<string, unknown> | null | undefined,
): BBox[] {
  if (!response) return [];
  const raw = response.boxes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((box): box is BBox => {
    if (!box || typeof box !== 'object') return false;
    const record = box as Record<string, unknown>;
    return (
      typeof record.x1 === 'number' &&
      typeof record.y1 === 'number' &&
      typeof record.x2 === 'number' &&
      typeof record.y2 === 'number'
    );
  });
}

/**
 * Read the first input image from internal_request_snapshot.images.
 * V1 simplification: parsed boxes always attach to the first image.
 * Mirrors the resolved-uri logic in CompareOverlay.extractImagesFromSnapshot.
 */
export function extractFirstInputImage(
  snapshot: Record<string, unknown> | null | undefined,
): ImageRef | null {
  if (!snapshot) return null;
  const images = snapshot.images;
  if (!Array.isArray(images) || images.length === 0) return null;

  const entries = images
    .filter((img): img is Record<string, unknown> => Boolean(img) && typeof img === 'object')
    .map((img) => ({
      img,
      resolved: (img.resolved ?? null) as Record<string, unknown> | null,
      order: typeof img.order === 'number' ? img.order : 0,
    }))
    .sort((a, b) => a.order - b.order);

  const first = entries.find(
    ({ img, resolved }) =>
      typeof resolved?.uri === 'string' ||
      typeof resolved?.path === 'string' ||
      typeof img.path === 'string',
  );
  if (!first) return null;

  const { img, resolved } = first;
  return {
    path:
      (typeof resolved?.path === 'string' ? resolved.path : null) ??
      (typeof img.path === 'string' ? img.path : null),
    uri: typeof resolved?.uri === 'string' ? resolved.uri : null,
    mime_type: typeof img.mime_type === 'string' ? img.mime_type : null,
    role: typeof img.role === 'string' ? img.role : undefined,
    order: first.order,
  };
}

/** Clamp a coordinate into [0,1] (model output may overshoot the edges). */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
