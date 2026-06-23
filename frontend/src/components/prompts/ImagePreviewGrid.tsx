import { ImageIcon, X } from 'lucide-react';
import { useState } from 'react';

import { resolveImageSrc } from '../../components/lab/ImagePanel';
import type { ImageRef } from '../../types';

interface ImagePreviewGridProps {
  images: ImageRef[];
  maxVisible?: number;
  size?: 'sm' | 'md';
}

export function ImagePreviewGrid({
  images,
  maxVisible = 4,
  size = 'sm',
}: ImagePreviewGridProps) {
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);

  const validImages = images.filter((img) => img && (img.uri || img.path));
  if (validImages.length === 0) return null;

  const visible = validImages.slice(0, maxVisible);
  const remaining = validImages.length - visible.length;

  const sizeClasses =
    size === 'sm'
      ? 'h-14 w-14'
      : 'h-20 w-20';

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {visible.map((image, index) => {
          const src = resolveImageSrc(image);
          const name = image.role || `Image ${index + 1}`;
          const tooltip = image.display_name ?? name;
          return (
            <button
              key={`${src}-${index}`}
              type="button"
              onClick={() => setPreview({ src, name })}
              className={`${sizeClasses} overflow-hidden rounded-md border border-surface-700 bg-surface-950 transition-colors hover:border-surface-500`}
              title={tooltip}
            >
              {src ? (
                <img
                  src={src}
                  alt={name}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-ink-dim">
                  <ImageIcon size={14} />
                </div>
              )}
            </button>
          );
        })}
        {remaining > 0 && (
          <div className={`${sizeClasses} flex items-center justify-center rounded-md border border-surface-700 bg-surface-950 text-xs text-ink-dim`}>
            +{remaining}
          </div>
        )}
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-surface-950/90 p-6 backdrop-blur"
          onClick={() => setPreview(null)}
          role="dialog"
          aria-modal="true"
        >
          <div className="absolute left-4 top-4 text-xs text-ink-muted">{preview.name}</div>
          <button
            type="button"
            onClick={() => setPreview(null)}
            className="absolute right-4 top-4 rounded-md bg-surface-800 p-2 text-ink hover:bg-surface-700"
          >
            <X size={18} />
          </button>
          <img
            src={preview.src}
            alt={preview.name}
            className="max-h-full max-w-full rounded-lg object-contain shadow-panel"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
