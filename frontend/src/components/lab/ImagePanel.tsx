import {
  ImageIcon,
  Loader2,
  Plus,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';

import * as api from '../../api/client';
import { useI18n } from '../../i18n';
import { useLabStore } from '../../store/labStore';
import type { ImageRef } from '../../types';

interface PreviewState {
  index: number;
  src: string;
}

export function ImagePanel() {
  const images = useLabStore((state) => state.images);
  const imageResolutionEnabled = useLabStore((state) => state.imageResolutionEnabled);
  const imageResolutionTarget = useLabStore((state) => state.imageResolutionTarget);
  const addImage = useLabStore((state) => state.addImage);
  const removeImage = useLabStore((state) => state.removeImage);
  const setImageResolutionEnabled = useLabStore((state) => state.setImageResolutionEnabled);
  const setImageResolutionTarget = useLabStore((state) => state.setImageResolutionTarget);

  const { t } = useI18n();

  const [isDragging, setIsDragging] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const handleUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;

      const imageFiles = Array.from(files).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (imageFiles.length === 0) {
        setUploadError('请上传图片文件');
        return;
      }

      setUploadError(null);
      setUploadingCount((count) => count + imageFiles.length);

      try {
        await Promise.all(
          imageFiles.map(async (file) => {
            try {
              const uploaded = await api.uploadImage(file);
              const imageRef: ImageRef = {
                path: uploaded.path,
                uri: uploaded.url,
                mime_type: uploaded.mime_type,
                display_name: uploaded.filename ?? file.name,
                metadata: {
                  file_size: uploaded.size,
                },
              };
              addImage(imageRef);
            } catch (err) {
              const message =
                err instanceof Error ? err.message : `上传 ${file.name} 失败`;
              setUploadError(message);
            }
          }),
        );
      } finally {
        setUploadingCount((count) => Math.max(0, count - imageFiles.length));
      }
    },
    [addImage],
  );

  const handleDragEnter = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragCounterRef.current += 1;
    if (event.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      setIsDragging(false);
      dragCounterRef.current = 0;
    }
  }, []);

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      void handleUpload(event.dataTransfer.files);
    },
    [handleUpload],
  );

  const handleFileSelect = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void handleUpload(event.target.files);
      event.target.value = '';
    },
    [handleUpload],
  );

  const updateRole = useCallback(
    (index: number, role: string) => {
      const updated = images.map((img, i) =>
        i === index ? { ...img, role } : img,
      );
      useLabStore.setState({ images: updated });
    },
    [images],
  );

  const openPreview = useCallback(
    (index: number) => {
      const image = images[index];
      if (!image) return;
      const src = resolveImageSrc(image);
      setPreview({ index, src });
    },
    [images],
  );

  const closePreview = useCallback(() => {
    setPreview(null);
  }, []);

  useEffect(() => {
    return () => {
      setPreview(null);
    };
  }, []);

  return (
    <section
      className="panel relative flex flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-800 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <ImageIcon size={16} className="text-accent" />
          <span className="text-sm font-semibold text-ink">{t('image.title')}</span>
          <span className="rounded-full bg-surface-800 px-2 py-0.5 text-xs text-ink-muted">
            {images.length}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={imageResolutionEnabled}
              onChange={(event) => setImageResolutionEnabled(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
            />
            {t('image.resolutionEnabled')}
          </label>
          <select
            value={imageResolutionTarget}
            onChange={(event) => setImageResolutionTarget(Number(event.target.value))}
            disabled={!imageResolutionEnabled}
            className="rounded-md border border-surface-700 bg-surface-950 px-2 py-1.5 text-xs text-ink focus:border-accent focus:outline-none disabled:opacity-50"
            title={t('image.resolutionTarget')}
          >
            {[512, 768, 1024, 1536].map((target) => (
              <option key={target} value={target}>
                {target}×{target}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="btn-secondary py-1.5 pl-2.5 pr-3 text-xs"
          >
            <Plus size={14} />
            {t('image.add')}
          </button>
        </div>
      </div>

      <div className="relative flex-1 overflow-auto p-3">
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-3 z-10 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent bg-accent/10 text-accent">
            <UploadCloud size={28} />
            <span className="text-xs font-medium">{t('image.dropHere')}</span>
          </div>
        )}

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={[
            'flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs font-medium transition-colors',
            isDragging
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-surface-700 bg-surface-800/30 text-ink-muted hover:border-surface-600 hover:bg-surface-800/50 hover:text-ink',
          ].join(' ')}
        >
          <UploadCloud size={14} />
          {t('image.dropHere')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        {uploadError && (
          <div className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
            {uploadError}
          </div>
        )}

        {uploadingCount > 0 && (
          <div className="mt-3 flex items-center gap-2 text-xs text-ink-muted">
            <Loader2 size={14} className="animate-spin" />
            {t('image.uploading', { count: uploadingCount })}
          </div>
        )}

        {images.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            {images.map((image, index) => (
              <ImageThumbnail
                key={`${image.path ?? index}-${index}`}
                image={image}
                index={index}
                onRemove={() => removeImage(index)}
                onPreview={() => openPreview(index)}
                onRoleChange={(role) => updateRole(index, role)}
              />
            ))}
          </div>
        )}
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/90 p-6 backdrop-blur"
          onClick={closePreview}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            onClick={closePreview}
            className="absolute right-4 top-4 rounded-md bg-surface-800 p-2 text-ink hover:bg-surface-700"
          >
            <X size={18} />
          </button>
          <img
            src={preview.src}
            alt="Preview"
            className="max-h-full max-w-full rounded-lg object-contain shadow-panel"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </section>
  );
}

interface ImageThumbnailProps {
  image: ImageRef;
  index: number;
  onRemove: () => void;
  onPreview: () => void;
  onRoleChange: (role: string) => void;
}

function ImageThumbnail({
  image,
  index,
  onRemove,
  onPreview,
  onRoleChange,
}: ImageThumbnailProps) {
  const { t } = useI18n();
  const src = resolveImageSrc(image);
  const dimensions = formatDimensions(image.metadata);

  return (
    <div className="group flex flex-col gap-2 rounded-md bg-surface-800 p-2">
      <button
        type="button"
        onClick={onPreview}
        className="relative aspect-video w-full overflow-hidden rounded-md bg-surface-950"
      >
        <img
          src={src}
          alt={image.display_name ?? t('image.fallback', { n: index + 1 })}
          className="h-full w-full object-contain"
          loading="lazy"
        />
      </button>

      <div className="space-y-2">
        <input
          type="text"
          value={image.role ?? ''}
          onChange={(event) => onRoleChange(event.target.value)}
          placeholder={t('image.role')}
          className="w-full rounded border border-surface-700 bg-surface-900 px-2 py-1 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
        />
        <p
          className="truncate text-xs text-ink-dim"
          title={image.display_name ?? undefined}
        >
          {image.display_name ?? t('image.fallback', { n: index + 1 })}
        </p>
        {dimensions && <p className="text-xs text-ink-dim">{dimensions}</p>}
      </div>

      <button
        type="button"
        onClick={onRemove}
        className="flex items-center justify-center gap-1 rounded bg-danger/10 px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/20"
      >
        <Trash2 size={12} />
        {t('image.remove')}
      </button>
    </div>
  );
}

export function resolveImageSrc(image: ImageRef): string {
  if (image.uri) {
    // If it's a relative URL (starts with /), prepend the API base URL
    if (image.uri.startsWith('/')) {
      return `${api.getBaseUrl()}${image.uri}`;
    }
    return image.uri;
  }
  if (!image.path) return '';
  if (/^https?:\/\//.test(image.path)) return image.path;
  // If path looks like a URL path (starts with /api/), prepend base URL
  if (image.path.startsWith('/api/')) {
    return `${api.getBaseUrl()}${image.path}`;
  }
  return ''; // Don't try to use filesystem paths — they won't work in the browser
}

function formatDimensions(metadata?: ImageRef['metadata']): string | null {
  if (!metadata) return null;
  const width = metadata.width;
  const height = metadata.height;
  if (typeof width === 'number' && typeof height === 'number') {
    return `${width} × ${height}`;
  }
  return null;
}
