import {
  BookOpen,
  Edit3,
  Loader2,
  Plus,
  Search,
  Square,
  SquareCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import * as api from '../api/client';
import { PromptEditor } from '../components/prompts/PromptEditor';
import { useI18n } from '../i18n';
import { useLabStore } from '../store/labStore';
import type { PromptListItem } from '../types';

export function PromptsView() {
  const { t } = useI18n();
  const [prompts, setPrompts] = useState<PromptListItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptListItem | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<PromptListItem | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Bulk management state
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [search, setSearch] = useState('');
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  async function loadPrompts() {
    setIsLoading(true);
    setError(null);
    try {
      const items = await api.listPrompts();
      setPrompts(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('prompt.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadPrompts();
  }, []);

  function handleSaved() {
    void loadPrompts();
    setEditingPrompt(null);
    setIsCreating(false);
  }

  function handleLoadIntoLab(prompt: PromptListItem) {
    useLabStore.getState().loadPrompt(prompt);
    window.dispatchEvent(new CustomEvent('miko:navigate', { detail: 'lab' }));
  }

  function toggleSelection(promptId: string) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(promptId)) next.delete(promptId);
      else next.add(promptId);
      return next;
    });
  }

  function selectAll(filtered: PromptListItem[]) {
    setSelection(new Set(filtered.map((p) => p.prompt_id)));
  }

  function clearSelection() {
    setSelection(new Set());
  }

  async function handleDeletePrompt(promptId: string) {
    if (!window.confirm(t('prompt.confirmDelete'))) return;
    setDeletingIds((prev) => new Set(prev).add(promptId));
    try {
      await api.deletePrompt(promptId);
      setPrompts((prev) => prev.filter((p) => p.prompt_id !== promptId));
      setSelectedPrompt((current) =>
        current?.prompt_id === promptId ? null : current,
      );
      setSelection((prev) => {
        const next = new Set(prev);
        next.delete(promptId);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('prompt.deleteFailed'));
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(promptId);
        return next;
      });
    }
  }

  async function handleBatchDelete() {
    if (selection.size === 0) return;
    if (!window.confirm(t('prompt.confirmBatchDelete', { count: selection.size }))) return;
    const ids = Array.from(selection);
    setDeletingIds((prev) => new Set([...prev, ...ids]));
    try {
      await Promise.all(ids.map((id) => api.deletePrompt(id)));
      setPrompts((prev) => prev.filter((p) => !selection.has(p.prompt_id)));
      setSelectedPrompt((current) =>
        current && selection.has(current.prompt_id) ? null : current,
      );
      setSelection(new Set());
      if (prompts.length - selection.size === 0) setIsBatchMode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('prompt.deleteFailed'));
      await loadPrompts();
    } finally {
      setDeletingIds(new Set());
    }
  }

  const filteredPrompts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return prompts;
    return prompts.filter((p) => p.name.toLowerCase().includes(query));
  }, [prompts, search]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="flex items-center justify-between border-b border-surface-800 bg-surface-900/50 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
            {t('nav.prompts')}
          </h1>
          <p className="mt-1 text-xs text-ink-dim">{t('prompt.libraryDescription')}</p>
        </div>
        <div className="flex items-center gap-2">
          {prompts.length > 0 && (
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
              {t('prompt.batchMode')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsCreating(true)}
            className="btn-primary inline-flex items-center gap-1.5 px-3 py-2 text-xs"
          >
            <Plus size={14} />
            {t('prompt.createPrompt')}
          </button>
        </div>
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
              placeholder={t('prompt.search')}
              className="w-full rounded-md border border-surface-700 bg-surface-900 py-2 pl-9 pr-3 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        {isBatchMode && filteredPrompts.length > 0 && (
          <div className="mb-4 flex items-center justify-between rounded-md border border-surface-700 bg-surface-900/50 px-3 py-2">
            <div className="flex items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() =>
                  selection.size === filteredPrompts.length
                    ? clearSelection()
                    : selectAll(filteredPrompts)
                }
                className="inline-flex items-center gap-1 text-ink-muted hover:text-ink"
              >
                {selection.size === filteredPrompts.length ? (
                  <SquareCheck size={14} />
                ) : (
                  <Square size={14} />
                )}
                {selection.size === filteredPrompts.length
                  ? t('prompt.deselectAll')
                  : t('prompt.selectAll')}
              </button>
              <span className="text-ink-dim">
                {t('prompt.selectedCount', { count: selection.size })}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleBatchDelete()}
              disabled={selection.size === 0 || deletingIds.size > 0}
              className="inline-flex items-center gap-1 rounded-md border border-danger/40 px-2.5 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              <Trash2 size={12} />
              {t('prompt.batchDelete')}
            </button>
          </div>
        )}

        {isLoading && prompts.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-ink-muted">
            <Loader2 size={16} className="mr-2 animate-spin" />
            {t('prompt.loading')}
          </div>
        ) : filteredPrompts.length === 0 ? (
          <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
            {prompts.length === 0 ? t('prompt.emptyLibrary') : t('prompt.search')}
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredPrompts.map((prompt) => (
              <PromptListCard
                key={prompt.prompt_id}
                prompt={prompt}
                isBatchMode={isBatchMode}
                isSelected={selection.has(prompt.prompt_id)}
                isDeleting={deletingIds.has(prompt.prompt_id)}
                onToggleSelect={() => toggleSelection(prompt.prompt_id)}
                onClick={() => setSelectedPrompt(prompt)}
                onEdit={() => setEditingPrompt(prompt)}
                onLoad={() => handleLoadIntoLab(prompt)}
                onDelete={() => void handleDeletePrompt(prompt.prompt_id)}
              />
            ))}
          </div>
        )}
      </section>

      {selectedPrompt && !editingPrompt && !isCreating && (
        <PromptDetailDrawer
          prompt={selectedPrompt}
          onClose={() => setSelectedPrompt(null)}
          onEdit={() => setEditingPrompt(selectedPrompt)}
          onLoad={() => handleLoadIntoLab(selectedPrompt)}
          onDelete={() => void handleDeletePrompt(selectedPrompt.prompt_id)}
        />
      )}

      {(editingPrompt || isCreating) && (
        <div className="fixed inset-0 z-50 flex justify-end bg-surface-950/60 backdrop-blur-sm">
          <div className="h-full w-full max-w-2xl animate-fade-in border-l border-surface-700 bg-surface-900 shadow-panel">
            <PromptEditor
              prompt={editingPrompt}
              onSaved={handleSaved}
              onCancel={() => {
                setEditingPrompt(null);
                setIsCreating(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function PromptListCard({
  prompt,
  isBatchMode,
  isSelected,
  isDeleting,
  onToggleSelect,
  onClick,
  onEdit,
  onLoad,
  onDelete,
}: {
  prompt: PromptListItem;
  isBatchMode: boolean;
  isSelected: boolean;
  isDeleting: boolean;
  onToggleSelect: () => void;
  onClick: () => void;
  onEdit: () => void;
  onLoad: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();

  return (
    <article
      className={`panel p-4 transition-colors hover:border-surface-600 ${
        isBatchMode && isSelected ? 'border-accent/50 bg-accent/5' : ''
      }`}
      onClick={(event) => {
        if (isBatchMode) {
          event.preventDefault();
          event.stopPropagation();
          onToggleSelect();
        }
      }}
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
          <button type="button" onClick={onClick} className="min-w-0 flex-1 text-left">
            <div className="flex items-center gap-2">
              <BookOpen size={14} className="text-accent" />
              <h2 className="truncate text-sm font-semibold text-ink">{prompt.name}</h2>
            </div>
            {prompt.description && (
              <p className="mt-1 truncate text-xs text-ink-dim">{prompt.description}</p>
            )}
          </button>
        </div>

        <div className="flex shrink-0 items-start gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onLoad();
            }}
            className="btn-primary px-3 py-2 text-xs"
          >
            <Upload size={12} />
            {t('prompt.loadIntoLab')}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
            className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:bg-surface-800"
          >
            <Edit3 size={12} />
            {t('prompt.edit')}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            disabled={isDeleting}
            className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-danger/50 hover:text-danger disabled:opacity-50"
          >
            {isDeleting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
            {t('prompt.delete')}
          </button>
        </div>
      </div>
    </article>
  );
}

function PromptDetailDrawer({
  prompt,
  onClose,
  onEdit,
  onLoad,
  onDelete,
}: {
  prompt: PromptListItem;
  onClose: () => void;
  onEdit: () => void;
  onLoad: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const version = prompt.latest_version;
  const systemPrompt = version?.system_prompt ?? '';
  const userTemplate = version?.user_template ?? '';

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-surface-950/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex h-full w-full max-w-2xl animate-fade-in flex-col border-l border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-accent" />
            <span className="text-sm font-semibold text-ink">{prompt.name}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-auto p-4">
          {systemPrompt && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                {t('prompt.systemPrompt')}
              </h3>
              <pre className="overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
                {systemPrompt}
              </pre>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
              {t('prompt.userTemplate')}
            </h3>
            <pre className="overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
              {userTemplate || t('prompt.noUserTemplate')}
            </pre>
          </div>
        </div>

        <div className="flex shrink-0 gap-2 border-t border-surface-800 px-4 py-3">
          <button
            type="button"
            onClick={onLoad}
            className="btn-primary inline-flex items-center gap-1.5 px-3 py-2 text-xs"
          >
            <Upload size={12} />
            {t('prompt.loadIntoLab')}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:bg-surface-800"
          >
            <Edit3 size={12} />
            {t('prompt.edit')}
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:border-danger/50 hover:text-danger"
          >
            <Trash2 size={12} />
            {t('prompt.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
