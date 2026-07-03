import {
  Bookmark,
  Check,
  Clock,
  Coins,
  Cpu,
  ImageIcon,
  Loader2,
  Search,
  Square,
  SquareCheck,
  Star,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';

import { resolveImageUrl } from '../components/lab/ImagePanel';
import { useI18n } from '../i18n';
import { useLabStore } from '../store/labStore';
import { useSnapshotStore } from '../store/snapshotStore';
import type {
  ImageRef,
  ModelParameters,
  ResultSnapshot,
  ResultSnapshotDetail,
  RunItemSummary,
} from '../types';

export function SnapshotsView() {
  const { t } = useI18n();
  const {
    snapshots,
    selectedSnapshot,
    isLoading,
    error,
    loadSnapshots,
    selectSnapshot,
    updateSnapshot,
    deleteSnapshot,
  } = useSnapshotStore();

  const [search, setSearch] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [selectedTag, setSelectedTag] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Bulk management state
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [isBatchMode, setIsBatchMode] = useState(false);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const snapshot of snapshots) {
      for (const tag of snapshot.tags ?? []) {
        if (tag.trim()) set.add(tag.trim());
      }
    }
    return Array.from(set).sort();
  }, [snapshots]);

  const filteredSnapshots = useMemo(() => {
    const query = search.trim().toLowerCase();
    return snapshots.filter((snapshot) => {
      if (query && !snapshot.name.toLowerCase().includes(query)) return false;
      if (starredOnly && !snapshot.starred) return false;
      if (selectedTag && !(snapshot.tags ?? []).includes(selectedTag)) return false;
      return true;
    });
  }, [snapshots, search, starredOnly, selectedTag]);

  async function handleToggleStar(snapshot: ResultSnapshot) {
    await updateSnapshot(snapshot.snapshot_id, { starred: !snapshot.starred });
  }

  async function handleOpen(snapshot: ResultSnapshot) {
    await selectSnapshot(snapshot.snapshot_id);
  }

  async function handleClose() {
    await selectSnapshot(null);
  }

  async function handleDelete(snapshot: ResultSnapshot) {
    if (!window.confirm(t('snapshot.confirmDelete'))) return;
    setDeletingId(snapshot.snapshot_id);
    const ok = await deleteSnapshot(snapshot.snapshot_id);
    if (ok) {
      await selectSnapshot(null);
      setSelection((prev) => {
        const next = new Set(prev);
        next.delete(snapshot.snapshot_id);
        return next;
      });
    }
    setDeletingId(null);
  }

  function toggleSelection(snapshotId: string) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(snapshotId)) next.delete(snapshotId);
      else next.add(snapshotId);
      return next;
    });
  }

  function selectAll(filtered: ResultSnapshot[]) {
    setSelection(new Set(filtered.map((s) => s.snapshot_id)));
  }

  function clearSelection() {
    setSelection(new Set());
  }

  async function handleBatchDelete() {
    if (selection.size === 0) return;
    if (!window.confirm(t('snapshot.confirmBatchDelete', { count: selection.size }))) return;
    const ids = Array.from(selection);
    setDeletingId('__batch__');
    try {
      await Promise.all(ids.map((id) => deleteSnapshot(id)));
      setSelection(new Set());
      if (snapshots.length - selection.size === 0) setIsBatchMode(false);
    } catch (err) {
      // Handled by the snapshot store; reload to be safe.
      await loadSnapshots();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="flex items-center justify-between border-b border-surface-800 bg-surface-900/50 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
            {t('snapshot.title')}
          </h1>
          <p className="mt-1 text-xs text-ink-dim">{t('snapshot.description')}</p>
        </div>
        {snapshots.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setIsBatchMode((v) => !v);
              if (isBatchMode) clearSelection();
            }}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs ${
              isBatchMode
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-surface-700 text-ink-muted hover:bg-surface-800'
            }`}
          >
            {isBatchMode ? <SquareCheck size={14} /> : <Square size={14} />}
            {t('snapshot.batchMode')}
          </button>
        )}
      </header>

      <section className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-dim"
            />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('snapshot.search')}
              className="w-full rounded-md border border-surface-700 bg-surface-900 py-2 pl-9 pr-3 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={starredOnly}
              onChange={(event) => setStarredOnly(event.target.checked)}
              className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
            />
            {t('snapshot.filterStarred')}
          </label>

          <div className="flex items-center gap-2">
            <Tag size={14} className="text-ink-dim" />
            <select
              value={selectedTag}
              onChange={(event) => setSelectedTag(event.target.value)}
              className="rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
            >
              <option value="">{t('snapshot.allTags')}</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </div>
        </div>

        {isBatchMode && filteredSnapshots.length > 0 && (
          <div className="mb-4 flex items-center justify-between rounded-md border border-surface-700 bg-surface-900/50 px-3 py-2">
            <div className="flex items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() =>
                  selection.size === filteredSnapshots.length
                    ? clearSelection()
                    : selectAll(filteredSnapshots)
                }
                className="inline-flex items-center gap-1 text-ink-muted hover:text-ink"
              >
                {selection.size === filteredSnapshots.length ? (
                  <SquareCheck size={14} />
                ) : (
                  <Square size={14} />
                )}
                {selection.size === filteredSnapshots.length
                  ? t('snapshot.deselectAll')
                  : t('snapshot.selectAll')}
              </button>
              <span className="text-ink-dim">
                {t('snapshot.selectedCount', { count: selection.size })}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleBatchDelete()}
              disabled={selection.size === 0 || deletingId === '__batch__'}
              className="inline-flex items-center gap-1 rounded-md border border-danger/40 px-2.5 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              <Trash2 size={12} />
              {t('snapshot.batchDelete')}
            </button>
          </div>
        )}

        {isLoading && snapshots.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-ink-muted">
            <Loader2 size={16} className="mr-2 animate-spin" />
            {t('snapshot.loading')}
          </div>
        ) : filteredSnapshots.length === 0 ? (
          <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
            {snapshots.length === 0 ? t('snapshot.empty') : t('snapshot.search')}
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredSnapshots.map((snapshot) => (
              <SnapshotListCard
                key={snapshot.snapshot_id}
                snapshot={snapshot}
                isBatchMode={isBatchMode}
                isSelected={selection.has(snapshot.snapshot_id)}
                isDeleting={deletingId === snapshot.snapshot_id}
                onToggleStar={() => void handleToggleStar(snapshot)}
                onToggleSelect={() => toggleSelection(snapshot.snapshot_id)}
                onOpen={() => void handleOpen(snapshot)}
                onDelete={() => void handleDelete(snapshot)}
              />
            ))}
          </div>
        )}
      </section>

      {selectedSnapshot && (
        <SnapshotDetailDrawer
          detail={selectedSnapshot}
          onClose={handleClose}
          onDelete={(snapshot) => void handleDelete(snapshot)}
          deletingId={deletingId}
        />
      )}
    </div>
  );
}

interface SnapshotListCardProps {
  snapshot: ResultSnapshot;
  isBatchMode: boolean;
  isSelected: boolean;
  isDeleting: boolean;
  onToggleStar: () => void;
  onToggleSelect: () => void;
  onOpen: () => void;
  onDelete: () => void;
}

function SnapshotListCard({
  snapshot,
  isBatchMode,
  isSelected,
  isDeleting,
  onToggleStar,
  onToggleSelect,
  onOpen,
  onDelete,
}: SnapshotListCardProps) {
  const { t } = useI18n();
  const createdAt = snapshot.created_at
    ? new Date(snapshot.created_at).toLocaleString()
    : '—';

  function handleCardClick(event: React.MouseEvent<HTMLElement>) {
    if (isBatchMode) {
      onToggleSelect();
      return;
    }
    // Only open detail when clicking non-interactive areas.
    const target = event.target as HTMLElement;
    if (
      target.closest('button') ||
      target.closest('input') ||
      target.closest('select') ||
      target.closest('a')
    ) {
      return;
    }
    onOpen();
  }

  return (
    <article
      className={`panel p-4 transition-colors hover:border-surface-600 ${
        isBatchMode && isSelected ? 'border-accent/50 bg-accent/5' : ''
      }`}
      onClick={handleCardClick}
      role={isBatchMode ? 'button' : undefined}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {isBatchMode && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleSelect();
              }}
              className="mt-0.5 shrink-0 text-ink-muted hover:text-ink"
            >
              {isSelected ? (
                <SquareCheck size={16} className="text-accent" />
              ) : (
                <Square size={16} />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-ink">{snapshot.name}</h2>
              {snapshot.starred && (
                <Star size={12} className="fill-accent text-accent" />
              )}
            </div>
          </button>
        </div>

        <div className="flex shrink-0 items-start gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleStar();
            }}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-accent"
            aria-label={t('snapshot.starred')}
          >
            <Star
              size={16}
              className={snapshot.starred ? 'fill-accent text-accent' : ''}
            />
          </button>
          {!isBatchMode && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
              className="btn-primary px-3 py-2 text-xs"
            >
              {t('snapshot.edit')}
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            disabled={isDeleting}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-danger/50 hover:text-danger disabled:opacity-50"
          >
            {isDeleting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
            {t('snapshot.delete')}
          </button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-0 text-xs text-ink-dim md:pl-7">
        <span className="flex items-center gap-1">
          <Clock size={12} />
          {createdAt}
        </span>
        {snapshot.provider_id && (
          <span className="rounded bg-surface-800 px-1.5 py-0.5">
            {t('snapshot.provider')}: {snapshot.provider_id}
          </span>
        )}
        {snapshot.model_id && (
          <span className="rounded bg-surface-800 px-1.5 py-0.5">
            {t('snapshot.model')}: {snapshot.model_id}
          </span>
        )}
      </div>

      {snapshot.tags && snapshot.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-0 md:pl-7">
          {snapshot.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-surface-800 px-2 py-0.5 text-[10px] text-ink-muted"
            >
              <Tag size={10} />
              {tag}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

interface SnapshotDetailDrawerProps {
  detail: ResultSnapshotDetail;
  onClose: () => void;
  onDelete: (snapshot: ResultSnapshot) => void;
  deletingId: string | null;
}

function SnapshotDetailDrawer({
  detail,
  onClose,
  onDelete,
  deletingId,
}: SnapshotDetailDrawerProps) {
  const { t } = useI18n();
  const { snapshot, run_item } = detail;

  return (
    <div
      className="fixed inset-0 z-50 flex bg-surface-950/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={snapshot.name}
    >
      {/* Left side: images used in this run */}
      <SnapshotImagesPanel detail={detail} />

      <div
        className="ml-auto flex h-full w-full max-w-2xl animate-fade-in flex-col border-l border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <Bookmark size={16} className="text-accent" />
            <span className="text-sm font-semibold text-ink">{snapshot.name}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
            aria-label={t('common.cancel')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <SnapshotMetadataEditor snapshot={snapshot} />

          <div className="mt-6">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
              {t('snapshot.runResult')}
            </h3>
            {run_item ? (
              <SnapshotResultDisplay item={run_item} />
            ) : (
              <div className="panel p-4 text-sm text-ink-dim">
                {t('snapshot.noResult')}
              </div>
            )}
          </div>

          <div className="mt-6 flex gap-2">
            <LoadIntoLabButton detail={detail} />
            <button
              type="button"
              onClick={() => onDelete(snapshot)}
              disabled={deletingId === snapshot.snapshot_id}
              className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-danger/50 hover:text-danger disabled:opacity-50"
            >
              {deletingId === snapshot.snapshot_id ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Trash2 size={14} />
              )}
              {t('snapshot.delete')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SnapshotMetadataEditor({ snapshot }: { snapshot: ResultSnapshot }) {
  const { t } = useI18n();
  const updateSnapshot = useSnapshotStore((state) => state.updateSnapshot);
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState({
    name: snapshot.name,
    description: snapshot.description ?? '',
    tags: (snapshot.tags ?? []).join(', '),
    notes: snapshot.notes ?? '',
    starred: snapshot.starred ?? false,
    accepted: snapshot.accepted ?? null,
    rating: snapshot.rating ?? null,
  });

  useEffect(() => {
    setForm({
      name: snapshot.name,
      description: snapshot.description ?? '',
      tags: (snapshot.tags ?? []).join(', '),
      notes: snapshot.notes ?? '',
      starred: snapshot.starred ?? false,
      accepted: snapshot.accepted ?? null,
      rating: snapshot.rating ?? null,
    });
  }, [snapshot]);

  async function handleSave() {
    if (!form.name.trim()) {
      window.alert(t('snapshot.nameRequired'));
      return;
    }
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      notes: form.notes.trim() || undefined,
      starred: form.starred,
      accepted: form.accepted,
      rating: form.rating,
    };
    await updateSnapshot(snapshot.snapshot_id, payload);
    setIsEditing(false);
  }

  const createdAt = snapshot.created_at
    ? new Date(snapshot.created_at).toLocaleString()
    : '—';
  const updatedAt = snapshot.updated_at
    ? new Date(snapshot.updated_at).toLocaleString()
    : '—';

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {t('snapshot.metadata')}
        </h3>
        {isEditing ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              className="btn-primary px-2 py-1 text-xs"
            >
              <Check size={12} />
              {t('common.confirm')}
            </button>
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1 text-xs text-ink-muted hover:bg-surface-800"
            >
              {t('snapshot.cancel')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1 text-xs text-ink-muted hover:bg-surface-800"
          >
            {t('snapshot.edit')}
          </button>
        )}
      </div>

      {isEditing ? (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-ink-muted">
              {t('snapshot.name')}
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">
              {t('snapshot.descriptionLabel')}
            </label>
            <input
              type="text"
              value={form.description}
              onChange={(event) =>
                setForm({ ...form, description: event.target.value })
              }
              className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">
              {t('snapshot.tags')}
            </label>
            <input
              type="text"
              value={form.tags}
              onChange={(event) => setForm({ ...form, tags: event.target.value })}
              placeholder={t('snapshot.tagsHint')}
              className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">
              {t('snapshot.notes')}
            </label>
            <textarea
              value={form.notes}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
              rows={3}
              className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={form.starred}
                onChange={(event) =>
                  setForm({ ...form, starred: event.target.checked })
                }
                className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
              />
              {t('snapshot.starred')}
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={form.accepted === true}
                onChange={(event) =>
                  setForm({ ...form, accepted: event.target.checked ? true : null })
                }
                className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
              />
              {t('snapshot.accepted')}
            </label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-muted">{t('snapshot.rating')}</span>
              <input
                type="number"
                min={1}
                max={5}
                value={form.rating ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  setForm({
                    ...form,
                    rating: value === '' ? null : Number(value),
                  });
                }}
                className="w-16 rounded-md border border-surface-700 bg-surface-950 px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-ink-dim">
            {snapshot.provider_id && (
              <span>
                {t('snapshot.provider')}: {snapshot.provider_id}
              </span>
            )}
            {snapshot.model_id && (
              <span>
                {t('snapshot.model')}: {snapshot.model_id}
              </span>
            )}
          </div>
          {snapshot.description && (
            <p className="text-ink-muted">{snapshot.description}</p>
          )}
          {snapshot.tags && snapshot.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {snapshot.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full bg-surface-800 px-2 py-0.5 text-[10px] text-ink-muted"
                >
                  <Tag size={10} />
                  {tag}
                </span>
              ))}
            </div>
          )}
          {snapshot.notes && (
            <p className="whitespace-pre-wrap text-ink-dim">{snapshot.notes}</p>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-ink-dim">
            <span>
              {t('snapshot.createdAt')}: {createdAt}
            </span>
            <span>
              {t('snapshot.updatedAt')}: {updatedAt}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {snapshot.starred && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
                <Star size={10} className="fill-accent" />
                {t('snapshot.starred')}
              </span>
            )}
            {snapshot.accepted === true && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400">
                <Check size={10} />
                {t('snapshot.accepted')}
              </span>
            )}
            {snapshot.rating !== null && snapshot.rating !== undefined && (
              <span className="rounded-full bg-surface-800 px-2 py-0.5 text-[10px] text-ink-muted">
                {t('snapshot.rating')}: {snapshot.rating}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LoadIntoLabButton({ detail }: { detail: ResultSnapshotDetail }) {
  const { t } = useI18n();
  const providerConfigs = useLabStore((state) => state.providerConfigs);
  const setSystemPrompt = useLabStore((state) => state.setSystemPrompt);
  const setUserPrompt = useLabStore((state) => state.setUserPrompt);
  const setSelectedProviderConfigId = useLabStore(
    (state) => state.setSelectedProviderConfigId,
  );
  const setModelId = useLabStore((state) => state.setModelId);
  const setModelParameters = useLabStore((state) => state.setModelParameters);
  const setOutputContract = useLabStore((state) => state.setOutputContract);
  const setImages = useLabStore((state) => state.setImages);
  const setImageSlots = useLabStore((state) => state.setImageSlots);
  const loadProviderConfigs = useLabStore((state) => state.loadProviderConfigs);

  async function handleLoad() {
    await loadProviderConfigs();

    const config = detail.run_session.config_snapshot;
    const prompt = config?.prompt_version;
    const modelConfig = config?.model_config_snapshot;

    if (prompt) {
      setSystemPrompt(prompt.system_prompt ?? '');
      setUserPrompt(prompt.user_template ?? '');
    }

    if (config?.output_contract) {
      setOutputContract(config.output_contract);
    }

    const providerId = detail.snapshot.provider_id ?? modelConfig?.provider_id;
    const modelId = detail.snapshot.model_id ?? modelConfig?.model_id;

    if (providerId) {
      const matched =
        providerConfigs.find((c) => c.provider_config_id === providerId) ??
        providerConfigs.find((c) => c.adapter_id === providerId);
      if (matched) {
        setSelectedProviderConfigId(matched.provider_config_id);
      }
    }

    if (modelId) {
      setModelId(modelId);
    }

    if (modelConfig?.parameters) {
      setModelParameters(modelConfig.parameters as ModelParameters);
    }

    // Restore images from the snapshot's persisted request copy.
    const requestSnapshot = detail.snapshot.internal_request_snapshot;
    const images = extractSnapshotImages(requestSnapshot);
    setImages(images);
    setImageSlots([]);

    window.dispatchEvent(new CustomEvent('miko:navigate', { detail: 'lab' }));
  }

  return (
    <button
      type="button"
      onClick={() => void handleLoad()}
      className="btn-primary px-3 py-2 text-xs"
    >
      <Upload size={14} />
      {t('snapshot.loadIntoLab')}
    </button>
  );
}

function SnapshotResultDisplay({ item }: { item: RunItemSummary }) {
  const { t } = useI18n();
  const response = item.response;
  const usage = item.usage;
  const cost = item.cost;

  const rawText =
    typeof response.raw_text === 'string' ? response.raw_text : undefined;
  const parsed = response.parsed;
  const parseStatus =
    typeof response.parse_status === 'string' ? response.parse_status : undefined;
  const reasoningText = extractReasoningText(response);

  return (
    <div className="space-y-4">
      {reasoningText && (
        <div className="rounded-md border border-accent/20 bg-accent/5 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-accent">
            <span>✨</span>
            {t('result.reasoning')}
          </div>
          <div className="markdown-body text-xs text-ink">
            <ReactMarkdown>{reasoningText}</ReactMarkdown>
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-muted">
          {t('result.raw')}
        </div>
        <pre className="max-h-64 overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
          {rawText ?? t('result.noRawOutput')}
        </pre>
      </div>

      <div>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-muted">
          {t('result.parsed')}
        </div>
        <ParsedSnapshotOutput
          parsed={parsed}
          parseStatus={parseStatus}
          fallbackText={rawText}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-md border border-surface-800 bg-surface-950 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-ink-muted">
            <Cpu size={12} />
            {t('result.usage')}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <SnapshotMetric
              label={t('result.inputTokens')}
              value={typeof usage.input_tokens === 'number' ? usage.input_tokens : 0}
            />
            <SnapshotMetric
              label={t('result.outputTokens')}
              value={typeof usage.output_tokens === 'number' ? usage.output_tokens : 0}
            />
            <SnapshotMetric
              label={t('result.totalTokens')}
              value={
                typeof usage.total_tokens === 'number'
                  ? usage.total_tokens
                  : (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) +
                    (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0)
              }
            />
            <SnapshotMetric
              label={t('result.image')}
              value={typeof usage.image_count === 'number' ? usage.image_count : 0}
              icon={<ImageIcon size={12} className="text-ink-dim" />}
            />
            {typeof usage.reasoning_tokens === 'number' && usage.reasoning_tokens > 0 && (
              <SnapshotMetric
                label={t('result.reasoningTokens')}
                value={typeof usage.reasoning_tokens === 'number' ? usage.reasoning_tokens : 0}
              />
            )}
          </div>
        </div>

        <div className="rounded-md border border-surface-800 bg-surface-950 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-ink-muted">
            <Coins size={12} />
            {t('result.cost')}
          </div>
          <div className="mb-3 text-lg font-semibold text-cost">
            {typeof cost.currency === 'string' ? cost.currency : 'USD'}{' '}
            {typeof cost.estimated_cost === 'number'
              ? cost.estimated_cost.toFixed(6)
              : '0.000000'}
          </div>
          {Boolean(cost.cost_breakdown) && typeof cost.cost_breakdown === 'object' && (
            <div className="grid grid-cols-3 gap-2">
              <SnapshotCostMetric
                label={t('result.inputTokens')}
                value={
                  typeof (cost.cost_breakdown as Record<string, unknown>).input_text ===
                  'number'
                    ? ((cost.cost_breakdown as Record<string, unknown>).input_text as number)
                    : 0
                }
              />
              <SnapshotCostMetric
                label={t('result.outputTokens')}
                value={
                  typeof (cost.cost_breakdown as Record<string, unknown>).output_text ===
                  'number'
                    ? ((cost.cost_breakdown as Record<string, unknown>).output_text as number)
                    : 0
                }
              />
              <SnapshotCostMetric
                label={t('result.image')}
                value={
                  typeof (cost.cost_breakdown as Record<string, unknown>).image_input ===
                  'number'
                    ? ((cost.cost_breakdown as Record<string, unknown>).image_input as number)
                    : 0
                }
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function extractReasoningText(response: Record<string, unknown>): string | undefined {
  const normalized = response.normalized_response;
  if (normalized && typeof normalized === 'object') {
    const value = (normalized as Record<string, unknown>).reasoning_text;
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  const value = response.reasoning_text;
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return undefined;
}

function extractSnapshotImages(
  requestSnapshot: Record<string, unknown> | null | undefined,
): ImageRef[] {
  if (!requestSnapshot) return [];
  const rawImages = requestSnapshot.images;
  if (!Array.isArray(rawImages)) return [];
  return rawImages
    .map((item, index): ImageRef | null => {
      if (!item || typeof item !== 'object') return null;
      const img = item as Record<string, unknown>;
      const resolved =
        img.resolved && typeof img.resolved === 'object'
          ? (img.resolved as Record<string, unknown>)
          : {};
      const uri =
        typeof resolved.uri === 'string'
          ? resolved.uri
          : typeof img.uri === 'string'
            ? img.uri
            : '';
      const path =
        typeof resolved.path === 'string'
          ? resolved.path
          : typeof img.path === 'string'
            ? img.path
            : '';
      const mimeType =
        typeof resolved.mime_type === 'string'
          ? resolved.mime_type
          : typeof img.mime_type === 'string'
            ? img.mime_type
            : 'image/png';
      const width = typeof resolved.width === 'number' ? resolved.width : undefined;
      const height = typeof resolved.height === 'number' ? resolved.height : undefined;
      const fileSize = typeof resolved.file_size === 'number' ? resolved.file_size : undefined;
      const sha256 = typeof resolved.sha256 === 'string' ? resolved.sha256 : undefined;
      return {
        image_id: typeof img.request_image_id === 'string' ? img.request_image_id : `snap_img_${index}`,
        slot_id: typeof img.slot_id === 'string' ? img.slot_id : undefined,
        role: typeof img.role === 'string' ? img.role : 'target',
        path,
        uri,
        mime_type: mimeType,
        order: typeof img.order === 'number' ? img.order : index,
        display_name: `图片 ${index + 1}`,
        metadata: {
          width,
          height,
          file_size: fileSize,
          sha256,
        },
      };
    })
    .filter((img): img is ImageRef => img !== null && Boolean(img.uri || img.path));
}

function SnapshotImagesPanel({ detail }: { detail: ResultSnapshotDetail }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);

  const images = useMemo(() => {
    // Prefer the persisted snapshot copy; fall back to the run item copy.
    const requestSnapshot =
      detail.snapshot.internal_request_snapshot ??
      detail.run_item?.internal_request_snapshot ??
      {};
    const imgs = (requestSnapshot as Record<string, unknown>).images;
    if (Array.isArray(imgs)) return imgs;
    return [];
  }, [detail]);

  if (images.length === 0) return null;

  return (
    <>
      <div
        className="hidden h-full w-64 flex-col border-r border-surface-700 bg-surface-900/90 p-3 md:flex"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          <ImageIcon size={12} />
          {t('snapshot.imagesUsed')}
        </div>
        <div className="flex-1 space-y-2 overflow-auto">
          {images.map((image, index) => {
            const record = image && typeof image === 'object' ? (image as Record<string, unknown>) : {};
            const src = resolveImageUrl(
              typeof record.uri === 'string'
                ? record.uri
                : typeof record.path === 'string'
                  ? record.path
                  : '',
            );
            const name =
              typeof record.role === 'string'
                ? record.role
                : `${t('image.fallback', { n: index + 1 })}`;
            const tooltip =
              typeof record.display_name === 'string'
                ? record.display_name
                : name;
            return (
              <button
                key={`${src}-${index}`}
                type="button"
                onClick={() => setPreview({ src, name })}
                className="w-full rounded-md border border-surface-800 bg-surface-950 p-2 text-left transition-colors hover:border-surface-600"
                title={tooltip}
              >
                <div className="aspect-square w-full overflow-hidden rounded bg-surface-900">
                  {src ? (
                    <img
                      src={src}
                      alt={name}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-ink-dim">
                      <ImageIcon size={16} />
                    </div>
                  )}
                </div>
                <p className="mt-1 truncate text-[10px] text-ink-dim">{name}</p>
              </button>
            );
          })}
        </div>
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
            src={resolveImageUrl(preview.src)}
            alt={preview.name}
            className="max-h-full max-w-full rounded-lg object-contain shadow-panel"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

function ParsedSnapshotOutput({
  parsed,
  parseStatus,
  fallbackText,
}: {
  parsed: unknown;
  parseStatus: string | undefined;
  fallbackText: string | undefined;
}) {
  const { t } = useI18n();

  if (parseStatus === 'not_parsed' || parseStatus === 'parse_failed') {
    const text = typeof parsed === 'string' ? parsed : fallbackText;
    if (text) {
      return (
        <div className="markdown-body overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 text-sm text-ink">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      );
    }
    return (
      <div className="rounded-md border border-surface-800 bg-surface-950 p-3 text-xs text-ink-dim">
        {t('result.notParsed')}
      </div>
    );
  }

  if (parseStatus === 'parsed' && parsed !== undefined) {
    return (
      <pre className="overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
        {formatParsedOutput(parsed)}
      </pre>
    );
  }

  return (
    <div className="rounded-md border border-surface-800 bg-surface-950 p-3 text-xs text-ink-dim">
      {t('result.notParsed')}
    </div>
  );
}

function formatParsedOutput(parsed: unknown): string {
  if (typeof parsed === 'string') return parsed;
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(parsed);
  }
}

function SnapshotMetric({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded bg-surface-900 px-2 py-1.5">
      <div className="flex items-center gap-1 text-xs text-ink-dim">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold text-ink">{value.toLocaleString()}</div>
    </div>
  );
}

function SnapshotCostMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-surface-900 px-2 py-1.5">
      <div className="text-xs text-ink-dim">{label}</div>
      <div className="text-xs font-semibold text-ink">{value.toFixed(6)}</div>
    </div>
  );
}
