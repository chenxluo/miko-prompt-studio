import {
  ArrowLeft,
  FileImage,
  Loader2,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import * as api from '../api/client';
import { ImportDialog } from '../components/samples/ImportDialog';
import { useI18n } from '../i18n';
import type { ImageRef } from '../types';

interface SampleSetViewModel {
  sample_set_id: string;
  name: string;
  description: string;
  record_ids: string[];
  metadata: Record<string, unknown>;
  created_at: string;
}

export function SamplesView() {
  const { t } = useI18n();
  const [sampleSets, setSampleSets] = useState<SampleSetViewModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);

  useEffect(() => {
    void refreshSampleSets();
  }, []);

  const filteredSets = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sampleSets;
    return sampleSets.filter(
      (set) =>
        set.name.toLowerCase().includes(query) ||
        set.description.toLowerCase().includes(query),
    );
  }, [sampleSets, search]);

  async function refreshSampleSets() {
    setIsLoading(true);
    setError(null);
    try {
      const items = await api.listSampleSets();
      setSampleSets(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('samples.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDelete(set: SampleSetViewModel) {
    if (!window.confirm(t('samples.confirmDelete'))) return;
    setDeletingId(set.sample_set_id);
    setError(null);
    try {
      await api.deleteSampleSet(set.sample_set_id);
      setSampleSets((current) =>
        current.filter((item) => item.sample_set_id !== set.sample_set_id),
      );
      if (selectedSetId === set.sample_set_id) {
        setSelectedSetId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('samples.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }

  function handleImported(sampleSetId: string) {
    setIsImportOpen(false);
    void refreshSampleSets();
    setSelectedSetId(sampleSetId);
  }

  if (selectedSetId) {
    return (
      <SampleSetDetail
        sampleSetId={selectedSetId}
        onBack={() => setSelectedSetId(null)}
        onDelete={handleDelete}
        deletingId={deletingId}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="flex items-center justify-between border-b border-surface-800 bg-surface-900/50 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
            {t('samples.title')}
          </h1>
          <p className="mt-1 text-xs text-ink-dim">{t('samples.description')}</p>
        </div>
        <button
          type="button"
          onClick={() => setIsImportOpen(true)}
          className="btn-primary px-3 py-2 text-xs"
        >
          <Plus size={14} />
          {t('samples.import')}
        </button>
      </header>

      <section className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="mb-4">
          <div className="relative max-w-md">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-dim"
            />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('samples.search')}
              className="w-full rounded-md border border-surface-700 bg-surface-900 py-2 pl-9 pr-3 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        {isLoading && sampleSets.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-ink-muted">
            <Loader2 size={16} className="mr-2 animate-spin" />
            {t('samples.loading')}
          </div>
        ) : filteredSets.length === 0 ? (
          <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
            {sampleSets.length === 0 ? t('samples.empty') : t('samples.noResults')}
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredSets.map((set) => (
              <SampleSetCard
                key={set.sample_set_id}
                sampleSet={set}
                isDeleting={deletingId === set.sample_set_id}
                onOpen={() => setSelectedSetId(set.sample_set_id)}
                onDelete={() => void handleDelete(set)}
              />
            ))}
          </div>
        )}
      </section>

      {isImportOpen && (
        <ImportDialog
          onClose={() => setIsImportOpen(false)}
          onImported={handleImported}
        />
      )}
    </div>
  );
}

interface SampleSetCardProps {
  sampleSet: SampleSetViewModel;
  isDeleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}

function SampleSetCard({
  sampleSet,
  isDeleting,
  onOpen,
  onDelete,
}: SampleSetCardProps) {
  const { t } = useI18n();
  const createdAt = sampleSet.created_at
    ? new Date(sampleSet.created_at).toLocaleString()
    : '—';

  return (
    <article className="panel p-4 transition-colors hover:border-surface-600">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            <FileImage size={16} className="shrink-0 text-accent" />
            <h2 className="truncate text-sm font-semibold text-ink">
              {sampleSet.name}
            </h2>
          </div>
          {sampleSet.description && (
            <p className="mt-1 line-clamp-2 text-xs text-ink-muted">
              {sampleSet.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-dim">
            <span>
              {t('samples.recordCount', { count: sampleSet.record_ids.length })}
            </span>
            <span>{t('samples.createdAt')}: {createdAt}</span>
          </div>
        </button>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="btn-primary px-3 py-2 text-xs"
          >
            {t('samples.view')}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-danger/50 hover:text-danger disabled:opacity-50"
          >
            {isDeleting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
            {t('samples.delete')}
          </button>
        </div>
      </div>
    </article>
  );
}

interface SampleSetDetailProps {
  sampleSetId: string;
  onBack: () => void;
  onDelete: (set: SampleSetViewModel) => void;
  deletingId: string | null;
}

function SampleSetDetail({
  sampleSetId,
  onBack,
  onDelete,
  deletingId,
}: SampleSetDetailProps) {
  const { t } = useI18n();
  const [sampleSet, setSampleSet] = useState<SampleSetViewModel | null>(null);
  const [records, setRecords] = useState<api.SampleListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const [set, items] = await Promise.all([
          api.getSampleSet(sampleSetId),
          api.listSamples(sampleSetId, 1000),
        ]);
        if (cancelled) return;
        setSampleSet(set);
        setRecords(items);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('samples.detailFailed'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [sampleSetId, t]);

  const createdAt = sampleSet?.created_at
    ? new Date(sampleSet.created_at).toLocaleString()
    : '—';

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="flex items-center justify-between border-b border-surface-800 bg-surface-900/50 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
            aria-label={t('samples.back')}
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
              {sampleSet?.name ?? t('samples.title')}
            </h1>
            {sampleSet && (
              <p className="mt-1 text-xs text-ink-dim">
                {sampleSet.description || t('samples.recordCount', { count: records.length })}
                {' · '}
                {t('samples.createdAt')}: {createdAt}
              </p>
            )}
          </div>
        </div>
        {sampleSet && (
          <button
            type="button"
            onClick={() => onDelete(sampleSet)}
            disabled={deletingId === sampleSet.sample_set_id}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-danger/50 hover:text-danger disabled:opacity-50"
          >
            {deletingId === sampleSet.sample_set_id ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
            {t('samples.delete')}
          </button>
        )}
      </header>

      <section className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-sm text-ink-muted">
            <Loader2 size={16} className="mr-2 animate-spin" />
            {t('samples.loading')}
          </div>
        ) : records.length === 0 ? (
          <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
            {t('samples.noRecords')}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-surface-700">
            <div className="max-h-[calc(100vh-12rem)] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 z-10 bg-surface-900">
                  <tr className="border-b border-surface-700 text-ink-muted">
                    <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                      {t('samples.column.sampleId')}
                    </th>
                    <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                      {t('samples.column.images')}
                    </th>
                    <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                      {t('samples.column.vars')}
                    </th>
                    <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                      {t('samples.column.metadata')}
                    </th>
                    <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                      {t('samples.column.tags')}
                    </th>
                    <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                      {t('samples.column.notes')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-800">
                  {records.map((record) => (
                    <tr
                      key={record.sample_id}
                      className="bg-surface-950 transition-colors hover:bg-surface-900/50"
                    >
                      <td className="px-4 py-3 align-top font-mono text-ink">
                        {record.sample_id}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <ImageThumbnails data={record.data} />
                      </td>
                      <td className="px-4 py-3 align-top text-ink-muted">
                        <pre className="max-w-xs overflow-auto rounded bg-surface-900 p-2 font-mono text-[10px]">
                          {stringifyJson(extractVars(record.data))}
                        </pre>
                      </td>
                      <td className="px-4 py-3 align-top text-ink-muted">
                        <pre className="max-w-xs overflow-auto rounded bg-surface-900 p-2 font-mono text-[10px]">
                          {stringifyJson(extractMetadata(record.data))}
                        </pre>
                      </td>
                      <td className="px-4 py-3 align-top text-ink-muted">
                        {(record.tags ?? []).length > 0
                          ? record.tags.join(', ')
                          : '—'}
                      </td>
                      <td className="px-4 py-3 align-top text-ink-muted">
                        {record.notes || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ImageThumbnails({ data }: { data: Record<string, unknown> }) {
  const { t } = useI18n();
  const images = extractImages(data);
  if (images.length === 0) return <span className="text-ink-dim">—</span>;

  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image, index) => {
        const src = resolveImageSrc(image);
        const label = image.role ?? t('samples.imageFallback', { n: index + 1 });
        return (
          <div
            key={`${image.image_id ?? image.path ?? image.uri ?? index}`}
            className="h-12 w-12 overflow-hidden rounded border border-surface-700 bg-surface-900"
            title={image.display_name ?? label}
          >
            {src ? (
              <img
                src={src}
                alt={label}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-ink-dim">
                <FileImage size={14} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function resolveImageSrc(image: ImageRef): string | null {
  if (image.path) return `file:///${image.path}`;
  if (image.uri) return image.uri;
  return null;
}

function extractImages(data: Record<string, unknown>): ImageRef[] {
  const raw = data.images;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is ImageRef =>
      item !== null && typeof item === 'object' && (item.path || item.uri),
  );
}

function extractVars(data: Record<string, unknown>): Record<string, unknown> | null {
  const raw = data.vars;
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return null;
}

function extractMetadata(data: Record<string, unknown>): Record<string, unknown> | null {
  const raw = data.metadata;
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return null;
}

function stringifyJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
