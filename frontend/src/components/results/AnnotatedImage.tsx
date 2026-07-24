import { ImageOff, Loader2, Maximize2 } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '../../i18n';
import type { BBox, ImageRef } from '../../types';
import { resolveImageSrc } from '../lab/ImagePanel';
import { BBoxFullscreenModal } from './BBoxFullscreenModal';
import { BBoxOverlay } from './BBoxOverlay';

interface AnnotatedImageProps {
  image: ImageRef;
  boxes?: BBox[] | null;
  alt?: string;
  /** Max rendered height of the image (px number or any CSS length). */
  maxHeight?: number | string;
  /** Show the hover fullscreen trigger and zoom-on-click (default true). */
  enableFullscreen?: boolean;
  /** Render without the bordered frame, for embedding in existing containers. */
  framed?: boolean;
  className?: string;
}

/**
 * Renders an input image with its bbox overlay.
 *
 * Alignment approach: the overlay never stretches across a letterboxed
 * container. Instead, an inline-block wrapper shrinks to fit the <img>'s
 * rendered size (max-w / max-height constrained, aspect ratio preserved),
 * and BBoxOverlay absolutely fills that wrapper — so the overlay always
 * matches the actual image pixels, with no letterbox math or resize
 * observers needed.
 */
export function AnnotatedImage({
  image,
  boxes,
  alt,
  maxHeight = 320,
  enableFullscreen = true,
  framed = true,
  className,
}: AnnotatedImageProps) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  const src = resolveImageSrc(image);
  const visibleBoxes = boxes ?? [];
  const canFullscreen = enableFullscreen && loaded && !failed && Boolean(src);

  return (
    <div
      className={[
        'flex w-full justify-center',
        framed ? 'rounded-md border border-surface-800 bg-surface-950 p-2' : '',
        className ?? '',
      ].join(' ').trim()}
    >
      {failed || !src ? (
        <div className="flex flex-col items-center gap-2 py-8 text-ink-dim">
          <ImageOff size={20} />
          <span className="text-xs">{t('result.annotatedImageFailed')}</span>
        </div>
      ) : (
        <div
          className={[
            'group relative inline-block max-w-full',
            canFullscreen ? 'cursor-zoom-in' : '',
          ].join(' ').trim()}
          onClick={canFullscreen ? () => setFullscreenOpen(true) : undefined}
        >
          {!loaded && (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={18} className="animate-spin text-ink-dim" />
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
            style={{ maxHeight }}
          />
          {loaded && visibleBoxes.length > 0 && <BBoxOverlay boxes={visibleBoxes} />}
          {canFullscreen && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setFullscreenOpen(true);
              }}
              title={t('result.bbox.openFullscreen')}
              aria-label={t('result.bbox.openFullscreen')}
              className="absolute right-1 top-1 rounded-md bg-surface-950/80 p-1.5 text-ink-muted opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Maximize2 size={14} />
            </button>
          )}
        </div>
      )}

      {fullscreenOpen && (
        <BBoxFullscreenModal
          image={image}
          boxes={visibleBoxes}
          alt={alt}
          onClose={() => setFullscreenOpen(false)}
        />
      )}
    </div>
  );
}
