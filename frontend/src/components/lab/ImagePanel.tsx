import {
  ArrowLeft,
  ArrowRight,
  ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Plus,
  Settings,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';

import * as api from '../../api/client';
import { useI18n } from '../../i18n';
import { useLabStore } from '../../store/labStore';
import type { ImageRef, ImageSlotSpec } from '../../types';

interface PreviewState {
  index: number;
  src: string;
}

export function ImagePanel() {
  const images = useLabStore((state) => state.images);
  const imageResolutionEnabled = useLabStore((state) => state.imageResolutionEnabled);
  const imageResolutionTarget = useLabStore((state) => state.imageResolutionTarget);
  const templateImageSlotSpecs = useLabStore((state) => state.templateImageSlotSpecs);
  const addImage = useLabStore((state) => state.addImage);
  const addImageToSlot = useLabStore((state) => state.addImageToSlot);
  const removeImage = useLabStore((state) => state.removeImage);
  const moveImageToSlot = useLabStore((state) => state.moveImageToSlot);
  const addSlot = useLabStore((state) => state.addSlot);
  const removeSlot = useLabStore((state) => state.removeSlot);
  const updateSlot = useLabStore((state) => state.updateSlot);
  const setImageResolutionEnabled = useLabStore((state) => state.setImageResolutionEnabled);
  const setImageResolutionTarget = useLabStore((state) => state.setImageResolutionTarget);

  const { t } = useI18n();

  const [isDragging, setIsDragging] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [pendingSlotId, setPendingSlotId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const imagesBySlot = useMemo(() => {
    const map = new Map<string, ImageRef[]>();
    for (const spec of templateImageSlotSpecs) {
      map.set(spec.slot_id, []);
    }
    for (const image of images) {
      const slotId = image.slot_id;
      const list = map.get(slotId ?? '') ?? [];
      list.push(image);
      map.set(slotId ?? '', list);
    }
    return map;
  }, [images, templateImageSlotSpecs]);

  const handleUpload = useCallback(
    async (files: FileList | null, targetSlotId: string | null) => {
      if (!files || files.length === 0) return;

      const imageFiles = Array.from(files).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (imageFiles.length === 0) {
        setUploadError(t('image.uploadImageOnly'));
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
              const state = useLabStore.getState();
              if (targetSlotId) {
                const spec = state.templateImageSlotSpecs.find(
                  (s) => s.slot_id === targetSlotId,
                );
                const count = state.images.filter(
                  (img) => img.slot_id === targetSlotId,
                ).length;
                const max = spec?.max_count;
                if (max == null || count < max) {
                  state.addImageToSlot(imageRef, targetSlotId);
                } else {
                  state.addImage(imageRef);
                }
              } else {
                state.addImage(imageRef);
              }
            } catch (err) {
              const message =
                err instanceof Error ? err.message : t('image.uploadFailed', { name: file.name });
              setUploadError(message);
            }
          }),
        );
      } finally {
        setUploadingCount((count) => Math.max(0, count - imageFiles.length));
      }
    },
    [addImage, addImageToSlot, t],
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
      void handleUpload(event.dataTransfer.files, null);
    },
    [handleUpload],
  );

  const handleFileSelect = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void handleUpload(event.target.files, pendingSlotId);
      event.target.value = '';
      setPendingSlotId(null);
    },
    [handleUpload, pendingSlotId],
  );

  const handleSlotUploadClick = useCallback((slotId: string) => {
    setPendingSlotId(slotId);
    fileInputRef.current?.click();
  }, []);

  const handleHeaderUpload = useCallback(() => {
    setPendingSlotId(null);
    fileInputRef.current?.click();
  }, []);

  const openPreview = useCallback(
    (index: number) => {
      const image = images[index];
      if (!image) return;
      const src = resolveImageSrc(image);
      setPreview({ index, src });
    },
    [images],
  );

  const openFocus = useCallback((index: number) => {
    setFocusIndex(index);
    setFocusMode(true);
  }, []);

  const handleThumbnailClick = useCallback(
    (index: number) => {
      if (focusMode) {
        openFocus(index);
      } else {
        openPreview(index);
      }
    },
    [focusMode, openFocus, openPreview],
  );

  const closePreview = useCallback(() => {
    setPreview(null);
  }, []);

  const closeFocus = useCallback(() => {
    setFocusMode(false);
    setFocusIndex(null);
  }, []);

  const handleFocusPrev = useCallback(() => {
    setFocusIndex((current) => {
      if (current == null) return current;
      return current > 0 ? current - 1 : images.length - 1;
    });
  }, [images.length]);

  const handleFocusNext = useCallback(() => {
    setFocusIndex((current) => {
      if (current == null) return current;
      return current < images.length - 1 ? current + 1 : 0;
    });
  }, [images.length]);

  useEffect(() => {
    return () => {
      setPreview(null);
    };
  }, []);

  useEffect(() => {
    if (focusIndex != null && focusIndex >= images.length) {
      setFocusIndex(images.length > 0 ? images.length - 1 : null);
    }
  }, [images.length, focusIndex]);

  const filledSlotCount = useMemo(
    () => templateImageSlotSpecs.filter((spec) => (imagesBySlot.get(spec.slot_id)?.length ?? 0) > 0).length,
    [templateImageSlotSpecs, imagesBySlot],
  );

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
            {filledSlotCount}/{templateImageSlotSpecs.length}
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
            onClick={() => (focusMode ? closeFocus() : setFocusMode(true))}
            disabled={images.length === 0}
            className={[
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
              focusMode
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-surface-700 bg-surface-950 text-ink-muted hover:border-surface-600 hover:text-ink',
              images.length === 0 && 'cursor-not-allowed opacity-50',
            ].join(' ')}
            title={focusMode ? t('image.gridMode') : t('image.focusMode')}
          >
            {focusMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {focusMode ? t('image.gridMode') : t('image.focusMode')}
          </button>
          <button
            type="button"
            onClick={handleHeaderUpload}
            className="btn-secondary py-1.5 pl-2.5 pr-3 text-xs"
          >
            <Plus size={14} />
            {t('image.add')}
          </button>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col overflow-hidden">
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-3 z-10 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent bg-accent/10 text-accent">
            <UploadCloud size={28} />
            <span className="text-xs font-medium">{t('image.dropHere')}</span>
          </div>
        )}

        <div className="flex-1 overflow-auto p-3">
          {focusMode ? (
            <FocusModeView
              images={images}
              specs={templateImageSlotSpecs}
              focusIndex={focusIndex ?? 0}
              onSelect={setFocusIndex}
              onPrev={handleFocusPrev}
              onNext={handleFocusNext}
              onExit={closeFocus}
            />
          ) : (
            <>
              {templateImageSlotSpecs.length === 0 ? (
                <div className="rounded-md border border-dashed border-surface-700 p-6 text-center text-xs text-ink-dim">
                  {t('image.noSlots')}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {templateImageSlotSpecs.map((spec) => (
                    <SlotCard
                      key={spec.slot_id}
                      spec={spec}
                      slotImages={imagesBySlot.get(spec.slot_id) ?? []}
                      allImages={images}
                      allSpecs={templateImageSlotSpecs}
                      onUpload={handleSlotUploadClick}
                      onRemoveSlot={removeSlot}
                      onUpdateSlot={updateSlot}
                      onMoveImage={moveImageToSlot}
                      onClickImage={handleThumbnailClick}
                      onRemoveImage={removeImage}
                    />
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={addSlot}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-surface-700 bg-surface-800/30 px-3 py-2 text-xs font-medium text-ink-muted transition-colors hover:border-surface-600 hover:bg-surface-800/50 hover:text-ink"
              >
                <Plus size={14} />
                {t('image.addSlot')}
              </button>

              <button
                type="button"
                onClick={handleHeaderUpload}
                className={[
                  'mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs font-medium transition-colors',
                  isDragging
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-surface-700 bg-surface-800/30 text-ink-muted hover:border-surface-600 hover:bg-surface-800/50 hover:text-ink',
                ].join(' ')}
              >
                <UploadCloud size={14} />
                {t('image.dropHere')}
              </button>
            </>
          )}

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
        </div>
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

interface SlotCardProps {
  spec: ImageSlotSpec;
  slotImages: ImageRef[];
  allImages: ImageRef[];
  allSpecs: ImageSlotSpec[];
  onUpload: (slotId: string) => void;
  onRemoveSlot: (slotId: string) => void;
  onUpdateSlot: (slotId: string, patch: Partial<ImageSlotSpec>) => void;
  onMoveImage: (imageIndex: number, slotId: string) => void;
  onClickImage: (imageIndex: number) => void;
  onRemoveImage: (imageIndex: number) => void;
}

function SlotCard({
  spec,
  slotImages,
  allImages,
  allSpecs,
  onUpload,
  onRemoveSlot,
  onUpdateSlot,
  onMoveImage,
  onClickImage,
  onRemoveImage,
}: SlotCardProps) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const count = slotImages.length;
  const max = spec.max_count ?? null;
  const min = spec.min_count ?? 0;
  const overfilled = max != null && count > max;
  const underfilled = (spec.required ?? true) && count < min;
  const label = getSlotLabel(spec, t);

  return (
    <div className="flex flex-col rounded-lg border border-surface-700 bg-surface-900/50">
      <div className="relative flex-1">
        {count === 0 ? (
          <div className="group relative aspect-video w-full rounded-t-lg border-2 border-dashed border-surface-700 bg-surface-950/50">
            <button
              type="button"
              onClick={() => onUpload(spec.slot_id)}
              className="flex h-full w-full flex-col items-center justify-center gap-2 text-ink-dim transition-colors hover:text-accent"
            >
              <UploadCloud size={24} />
              <span className="text-xs font-medium">{t('image.clickToUpload')}</span>
            </button>
            <div className="absolute right-1 top-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={() => setSettingsOpen((v) => !v)}
                className="rounded bg-surface-950/80 p-1 text-ink-muted hover:text-accent"
                aria-label={t('image.slotSettings')}
                title={t('image.slotSettings')}
              >
                <Settings size={12} />
              </button>
              <button
                type="button"
                onClick={() => onRemoveSlot(spec.slot_id)}
                className="rounded bg-surface-950/80 p-1 text-ink-muted hover:text-danger"
                aria-label={t('image.removeSlot')}
                title={t('image.removeSlot')}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ) : (
          <div className="group relative aspect-video w-full overflow-hidden rounded-t-lg bg-surface-950">
            <SlotImageGrid
              images={slotImages}
              allImages={allImages}
              onClickImage={onClickImage}
              onMoveImage={onMoveImage}
              onRemoveImage={onRemoveImage}
              otherSpecs={allSpecs.filter((s) => s.slot_id !== spec.slot_id)}
            />

            {/* Hover actions */}
            <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-1 bg-gradient-to-b from-surface-950/80 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
              <span
                className={[
                  'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                  overfilled
                    ? 'bg-danger/20 text-danger'
                    : underfilled
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-emerald-500/20 text-emerald-400',
                ].join(' ')}
              >
                {count}/{formatMaxCount(max)}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setSettingsOpen((v) => !v)}
                  className="rounded bg-surface-950/80 p-1 text-ink-muted hover:text-accent"
                  aria-label={t('image.slotSettings')}
                  title={t('image.slotSettings')}
                >
                  <Settings size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveSlot(spec.slot_id)}
                  className="rounded bg-surface-950/80 p-1 text-ink-muted hover:text-danger"
                  aria-label={t('image.removeSlot')}
                  title={t('image.removeSlot')}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-surface-800 px-2.5 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium text-ink">{label}</span>
          <span className="text-[10px] text-ink-dim">
            {spec.required ?? true ? t('image.required') : t('image.optional')}
          </span>
        </div>
        <span
          className={[
            'flex-shrink-0 text-[10px]',
            overfilled
              ? 'text-danger'
              : underfilled
                ? 'text-amber-400'
                : 'text-emerald-400',
          ].join(' ')}
        >
          {underfilled
            ? t('image.underfilled', { count, min })
            : overfilled
              ? t('image.overfilled', { count, max: formatMaxCount(max) })
              : t('image.filled', { count, max: formatMaxCount(max) })}
        </span>
      </div>

      {settingsOpen && (
        <SlotSettingsPanel
          spec={spec}
          hasImages={count > 0}
          onUpdate={(patch) => onUpdateSlot(spec.slot_id, patch)}
        />
      )}
    </div>
  );
}

interface SlotImageGridProps {
  images: ImageRef[];
  allImages: ImageRef[];
  otherSpecs: ImageSlotSpec[];
  onClickImage: (imageIndex: number) => void;
  onMoveImage: (imageIndex: number, slotId: string) => void;
  onRemoveImage: (imageIndex: number) => void;
}

function SlotImageGrid({
  images,
  allImages,
  otherSpecs,
  onClickImage,
  onMoveImage,
  onRemoveImage,
}: SlotImageGridProps) {
  const { t } = useI18n();
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);

  if (images.length === 1) {
    const image = images[0];
    const globalIndex = allImages.indexOf(image);
    return (
      <div className="group relative h-full w-full">
        <button
          type="button"
          onClick={() => onClickImage(globalIndex)}
          className="h-full w-full"
          title={image.display_name ?? image.role ?? ''}
        >
          <img
            src={resolveImageSrc(image)}
            alt={image.role ?? ''}
            className="h-full w-full object-contain"
            loading="lazy"
          />
        </button>
        <div className="absolute right-1 top-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {otherSpecs.length > 0 && (
            <MoveImageMenu
              imageIndex={globalIndex}
              otherSpecs={otherSpecs}
              onMove={onMoveImage}
              onClose={() => setMenuOpenFor(null)}
              isOpen={menuOpenFor === image.role}
              onToggle={() =>
                setMenuOpenFor((current) => (current === image.role ? null : (image.role ?? null)))
              }
            />
          )}
          <button
            type="button"
            onClick={() => onRemoveImage(globalIndex)}
            className="rounded bg-surface-950/80 p-1 text-ink-muted hover:text-danger"
            aria-label={t('image.remove')}
            title={t('image.remove')}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full w-full grid-cols-2 gap-1 p-1">
      {images.slice(0, 4).map((image, index) => {
        const globalIndex = allImages.indexOf(image);
        const isMore = index === 3 && images.length > 4;
        return (
          <div key={`${image.path ?? ''}-${image.uri ?? ''}-${index}`} className="relative aspect-video">
            <button
              type="button"
              onClick={() => onClickImage(globalIndex)}
              className="h-full w-full overflow-hidden rounded bg-surface-900"
              title={image.display_name ?? image.role ?? ''}
            >
              <img
                src={resolveImageSrc(image)}
                alt={image.role ?? ''}
                className="h-full w-full object-cover"
                loading="lazy"
              />
              {isMore && (
                <span className="absolute inset-0 flex items-center justify-center bg-surface-950/70 text-xs font-semibold text-ink">
                  +{images.length - 3}
                </span>
              )}
            </button>
            {!isMore && (
              <div className="absolute right-0.5 top-0.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                {otherSpecs.length > 0 && (
                  <MoveImageMenu
                    imageIndex={globalIndex}
                    otherSpecs={otherSpecs}
                    onMove={onMoveImage}
                    onClose={() => setMenuOpenFor(null)}
                    isOpen={menuOpenFor === `${image.role ?? ''}-${index}`}
                    onToggle={() =>
                      setMenuOpenFor((current) =>
                        current === `${image.role ?? ''}-${index}` ? null : `${image.role ?? ''}-${index}`,
                      )
                    }
                  />
                )}
                <button
                  type="button"
                  onClick={() => onRemoveImage(globalIndex)}
                  className="rounded bg-surface-950/80 p-0.5 text-ink-muted hover:text-danger"
                  aria-label={t('image.remove')}
                  title={t('image.remove')}
                >
                  <Trash2 size={10} />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface MoveImageMenuProps {
  imageIndex: number;
  otherSpecs: ImageSlotSpec[];
  onMove: (imageIndex: number, slotId: string) => void;
  onClose: () => void;
  isOpen: boolean;
  onToggle: () => void;
}

function MoveImageMenu({
  imageIndex,
  otherSpecs,
  onMove,
  onClose,
  isOpen,
  onToggle,
}: MoveImageMenuProps) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (!buttonRef.current?.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        className="rounded bg-surface-950/80 p-1 text-ink-muted hover:text-accent"
        aria-label={t('image.moveTo')}
        title={t('image.moveTo')}
      >
        <MoreHorizontal size={12} />
      </button>
      {isOpen && (
        <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-md border border-surface-700 bg-surface-900 py-1 shadow-panel">
          <div className="px-2 py-1 text-[10px] font-medium text-ink-dim">{t('image.moveTo')}</div>
          {otherSpecs.map((spec) => (
            <button
              key={spec.slot_id}
              type="button"
              onClick={() => {
                onMove(imageIndex, spec.slot_id);
                onClose();
              }}
              className="w-full px-2 py-1 text-left text-xs text-ink hover:bg-surface-800"
            >
              {getSlotLabel(spec, t)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface SlotSettingsPanelProps {
  spec: ImageSlotSpec;
  hasImages: boolean;
  onUpdate: (patch: Partial<ImageSlotSpec>) => void;
}

function SlotSettingsPanel({ spec, hasImages, onUpdate }: SlotSettingsPanelProps) {
  const { t } = useI18n();

  return (
    <div className="border-t border-surface-800 bg-surface-950/50 p-3">
      <div className="grid gap-2.5">
        <div>
          <label className="mb-1 block text-[10px] text-ink-dim">{t('prompt.roleHint')}</label>
          <input
            type="text"
            value={spec.role_hint ?? ''}
            onChange={(event) => onUpdate({ role_hint: event.target.value || null })}
            disabled={hasImages}
            placeholder={t('prompt.roleHint')}
            className="w-full rounded-md border border-surface-700 bg-surface-900 px-2 py-1.5 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          {hasImages && (
            <p className="mt-1 text-[10px] text-ink-dim">{t('image.roleHintLocked')}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-[10px] text-ink-dim">{t('prompt.imageSlotLabel')}</label>
          <input
            type="text"
            value={spec.label ?? ''}
            onChange={(event) => onUpdate({ label: event.target.value })}
            placeholder={t('prompt.imageSlotLabel')}
            className="w-full rounded-md border border-surface-700 bg-surface-900 px-2 py-1.5 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-[10px] text-ink-dim">{t('prompt.imageSlotDescription')}</label>
          <input
            type="text"
            value={spec.description ?? ''}
            onChange={(event) => onUpdate({ description: event.target.value })}
            placeholder={t('prompt.imageSlotDescription')}
            className="w-full rounded-md border border-surface-700 bg-surface-900 px-2 py-1.5 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={spec.required ?? true}
            onChange={(event) => onUpdate({ required: event.target.checked })}
            className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
          />
          {t('prompt.required')}
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[10px] text-ink-dim">
            {t('prompt.minCount')}
            <input
              type="number"
              min={0}
              value={spec.min_count ?? 1}
              onChange={(event) => onUpdate({ min_count: Number(event.target.value) })}
              className="rounded-md border border-surface-700 bg-surface-900 px-2 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] text-ink-dim">
            {t('prompt.maxCount')}
            <input
              type="number"
              min={1}
              value={spec.max_count ?? ''}
              onChange={(event) =>
                onUpdate({
                  max_count:
                    event.target.value === '' ? null : Number(event.target.value),
                })
              }
              placeholder={t('prompt.unlimited')}
              className="rounded-md border border-surface-700 bg-surface-900 px-2 py-1.5 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
          </label>
        </div>
      </div>
    </div>
  );
}

interface FocusModeViewProps {
  images: ImageRef[];
  specs: ImageSlotSpec[];
  focusIndex: number;
  onSelect: (index: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onExit: () => void;
}

function FocusModeView({
  images,
  specs,
  focusIndex,
  onSelect,
  onPrev,
  onNext,
  onExit,
}: FocusModeViewProps) {
  const { t } = useI18n();
  const image = images[focusIndex];
  const src = image ? resolveImageSrc(image) : '';
  const slot = image?.slot_id ? specs.find((s) => s.slot_id === image.slot_id) : undefined;
  const title = slot ? getSlotLabel(slot, t) : image?.role ?? t('image.fallback', { n: focusIndex + 1 });

  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-surface-700 bg-surface-950">
        {image ? (
          <img
            src={src}
            alt={image.role ?? t('image.fallback', { n: focusIndex + 1 })}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="flex items-center justify-center py-12 text-ink-dim">
            {t('prompt.noImages')}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md bg-surface-800 p-2">
        <button
          type="button"
          onClick={onPrev}
          disabled={images.length <= 1}
          className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1.5 text-xs text-ink-muted transition-colors hover:bg-surface-700 disabled:opacity-40"
          aria-label={t('image.prevImage')}
        >
          <ArrowLeft size={14} />
          {t('image.prevImage')}
        </button>

        <div className="flex flex-col items-center gap-0.5">
          <span className="text-xs font-medium text-ink">{title}</span>
          <span className="text-[10px] text-ink-dim">
            {t('image.imageOf', { current: focusIndex + 1, total: images.length })}
          </span>
        </div>

        <button
          type="button"
          onClick={onNext}
          disabled={images.length <= 1}
          className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1.5 text-xs text-ink-muted transition-colors hover:bg-surface-700 disabled:opacity-40"
          aria-label={t('image.nextImage')}
        >
          {t('image.nextImage')}
          <ArrowRight size={14} />
        </button>
      </div>

      {image?.display_name && (
        <p
          className="truncate text-center text-[10px] text-ink-dim"
          title={image.display_name}
        >
          {image.display_name}
        </p>
      )}

      <div className="flex gap-2 overflow-x-auto rounded-md bg-surface-900/50 p-2">
        {images.map((thumb, index) => {
          const thumbSrc = resolveImageSrc(thumb);
          const selected = index === focusIndex;
          return (
            <button
              key={`${thumb.path ?? ''}-${thumb.uri ?? ''}-${index}`}
              type="button"
              onClick={() => onSelect(index)}
              className={[
                'relative h-14 w-20 flex-shrink-0 overflow-hidden rounded-md bg-surface-950',
                selected
                  ? 'ring-2 ring-accent'
                  : 'border border-surface-700 hover:border-surface-500',
              ].join(' ')}
              title={thumb.display_name ?? thumb.role ?? t('image.fallback', { n: index + 1 })}
            >
              <img
                src={thumbSrc}
                alt={thumb.role ?? t('image.fallback', { n: index + 1 })}
                className="h-full w-full object-cover"
                loading="lazy"
              />
              {selected && <span className="absolute inset-0 bg-accent/10" />}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onExit}
        className="inline-flex items-center justify-center gap-1 rounded-md border border-surface-700 px-3 py-1.5 text-xs text-ink-muted transition-colors hover:bg-surface-800"
      >
        <Minimize2 size={14} />
        {t('image.gridMode')}
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

function getSlotLabel(
  spec: ImageSlotSpec,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return (spec.label?.trim() || spec.role_hint?.trim() || t('image.unnamedSlot'));
}

function formatMaxCount(max: number | null | undefined): string {
  if (max == null) return '∞';
  return String(max);
}

