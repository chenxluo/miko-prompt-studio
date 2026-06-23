import { Copy, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import * as api from '../../api/client';
import type { FewShotExample, PromptListItem, RunItemSummary } from '../../types';
import { useI18n } from '../../i18n';

interface UseAsFewShotDialogProps {
  runItem: RunItemSummary;
  onClose: () => void;
  onSaved?: () => void;
}

export function UseAsFewShotDialog({ runItem, onClose, onSaved }: UseAsFewShotDialogProps) {
  const { t } = useI18n();
  const [prompts, setPrompts] = useState<PromptListItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 'new' = create a new prompt with this example; 'existing' = update existing prompt
  const [workflow, setWorkflow] = useState<'new' | 'existing'>('existing');

  // existing-prompt state
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [mode, setMode] = useState<'append' | 'replace_latest' | 'replace_selected'>('append');
  const [replaceIndex, setReplaceIndex] = useState(0);

  // new-prompt state
  const [newPromptName, setNewPromptName] = useState('');
  const [copyRunPrompt, setCopyRunPrompt] = useState(true);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [userTemplate, setUserTemplate] = useState('');

  const [title, setTitle] = useState('');

  useEffect(() => {
    setIsLoading(true);
    api
      .listPrompts()
      .then((items) => {
        setPrompts(items);
        if (items.length > 0) {
          setSelectedPromptId(items[0]?.prompt_id ?? '');
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('prompt.loadFailed')))
      .finally(() => setIsLoading(false));
  }, [t]);

  useEffect(() => {
    const runName = runItem.run_id ?? 'result';
    setNewPromptName(`${t('prompt.fewShotExample')} ${new Date().toLocaleString()}`);
    setTitle(`${t('prompt.fewShotExample')} ${new Date().toLocaleString()} (${runName.slice(0, 16)})`);
    const { systemPrompt: sys, userTemplate: user } = extractRunPrompts(runItem);
    setSystemPrompt(sys);
    setUserTemplate(user);
  }, [runItem, t]);

  const selectedPrompt = useMemo(
    () => prompts.find((p) => p.prompt_id === selectedPromptId),
    [prompts, selectedPromptId],
  );

  const existingExamples = selectedPrompt?.latest_version?.few_shot_examples ?? [];

  function extractRunPrompts(item: RunItemSummary): { systemPrompt: string; userTemplate: string } {
    let system = '';
    let user = '';
    const internal = item.internal_request_snapshot;
    if (internal && typeof internal === 'object') {
      const prompt = (internal as Record<string, unknown>).prompt;
      if (prompt && typeof prompt === 'object') {
        const sys = (prompt as Record<string, unknown>).system_prompt;
        const usr = (prompt as Record<string, unknown>).user_prompt;
        if (typeof sys === 'string') system = sys;
        if (typeof usr === 'string') user = usr;
      }
    }
    if (!system || !user) {
      const promptSnapshot = item.prompt_snapshot;
      if (promptSnapshot && typeof promptSnapshot === 'object') {
        const sys = (promptSnapshot as Record<string, unknown>).system_prompt;
        const usr = (promptSnapshot as Record<string, unknown>).user_template;
        if (typeof sys === 'string' && !system) system = sys;
        if (typeof usr === 'string' && !user) user = usr;
      }
    }
    return { systemPrompt: system, userTemplate: user };
  }

  function extractImages(item: RunItemSummary) {
    const internal = item.internal_request_snapshot;
    if (internal && typeof internal === 'object') {
      const images = (internal as Record<string, unknown>).images;
      if (Array.isArray(images)) return images;
    }
    return [];
  }

  function extractReasoningText(item: RunItemSummary): string | null {
    const response = item.response;
    if (!response || typeof response !== 'object') return null;
    const normalized = (response as Record<string, unknown>).normalized_response;
    if (normalized && typeof normalized === 'object') {
      const reasoning = (normalized as Record<string, unknown>).reasoning_text;
      if (typeof reasoning === 'string' && reasoning.trim()) return reasoning;
    }
    const reasoning = (response as Record<string, unknown>).reasoning_text;
    if (typeof reasoning === 'string' && reasoning.trim()) return reasoning;
    return null;
  }

  function buildExample(): FewShotExample {
    const { userTemplate: usr } = extractRunPrompts(runItem);
    return {
      example_id: `ex_${Date.now()}`,
      title: title.trim() || t('prompt.fewShotExample'),
      enabled: true,
      input_text: usr,
      output_text: typeof runItem.response?.raw_text === 'string' ? runItem.response.raw_text : '',
      parsed_output: runItem.response?.parsed ?? null,
      reasoning_text: extractReasoningText(runItem),
      images: extractImages(runItem),
      source_run_id: runItem.run_id,
      source_run_item_id: runItem.run_item_id,
      source_attempt_id: null,
      notes: '',
      created_from: 'run_result',
    };
  }

  async function handleSave() {
    setIsSaving(true);
    setError(null);
    try {
      if (workflow === 'new') {
        if (!newPromptName.trim()) {
          setError(t('prompt.nameRequired'));
          setIsSaving(false);
          return;
        }
        await api.savePrompt({
          name: newPromptName.trim(),
          system_prompt: copyRunPrompt ? systemPrompt : '',
          user_template: copyRunPrompt ? userTemplate : '',
          format_instruction: '',
          notes: '',
          image_slot_specs: [],
          few_shot_examples: [buildExample()],
          prompt_id: null,
        });
      } else {
        if (!selectedPrompt || !selectedPrompt.latest_version) {
          setError(t('prompt.noPrompts'));
          setIsSaving(false);
          return;
        }
        const version = selectedPrompt.latest_version;
        const newExample = buildExample();
        let nextExamples: FewShotExample[];
        if (mode === 'append') {
          nextExamples = [...(version.few_shot_examples ?? []), newExample];
        } else if (mode === 'replace_latest') {
          const base = version.few_shot_examples ?? [];
          nextExamples = base.length === 0 ? [newExample] : [...base.slice(0, -1), newExample];
        } else {
          const base = version.few_shot_examples ?? [];
          nextExamples = base.map((example, index) =>
            index === replaceIndex ? newExample : example,
          );
          if (replaceIndex >= base.length) {
            nextExamples = [...base, newExample];
          }
        }
        await api.savePrompt({
          name: selectedPrompt.name,
          system_prompt: version.system_prompt ?? '',
          user_template: version.user_template ?? '',
          format_instruction: version.format_instruction ?? '',
          notes: version.notes ?? '',
          image_slot_specs: version.image_slot_specs ?? [],
          variable_specs: version.variable_specs ?? [],
          few_shot_examples: nextExamples,
          prompt_id: selectedPrompt.prompt_id,
        });
      }
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('prompt.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-5 py-3">
          <h3 className="text-sm font-semibold text-ink">{t('prompt.useAsFewShotTitle')}</h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted hover:bg-surface-800"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
          {error && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
              <Loader2 size={14} className="mr-2 animate-spin" />
              {t('prompt.loading')}
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <WorkflowButton
                  active={workflow === 'new'}
                  onClick={() => setWorkflow('new')}
                  label={t('prompt.createNewPrompt')}
                />
                <WorkflowButton
                  active={workflow === 'existing'}
                  onClick={() => setWorkflow('existing')}
                  label={t('prompt.updateExistingPrompt')}
                />
              </div>

              {workflow === 'new' ? (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-ink-muted">{t('prompt.newPromptName')}</label>
                    <input
                      type="text"
                      value={newPromptName}
                      onChange={(event) => setNewPromptName(event.target.value)}
                      className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-ink-muted">
                    <input
                      type="checkbox"
                      checked={copyRunPrompt}
                      onChange={(event) => setCopyRunPrompt(event.target.checked)}
                      className="rounded border-surface-600 bg-surface-800 text-accent"
                    />
                    {t('prompt.copyRunPrompt')}
                  </label>
                  {copyRunPrompt && (
                    <>
                      <div>
                        <label className="mb-1 block text-xs text-ink-muted">{t('prompt.systemPrompt')}</label>
                        <textarea
                          value={systemPrompt}
                          onChange={(event) => setSystemPrompt(event.target.value)}
                          rows={4}
                          className="w-full resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-ink-muted">{t('prompt.userTemplate')}</label>
                        <textarea
                          value={userTemplate}
                          onChange={(event) => setUserTemplate(event.target.value)}
                          rows={4}
                          className="w-full resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                        />
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-xs text-ink-muted">{t('prompt.targetPrompt')}</label>
                    <select
                      value={selectedPromptId}
                      onChange={(event) => setSelectedPromptId(event.target.value)}
                      className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                    >
                      <option value="">{t('prompt.selectPrompt')}</option>
                      {prompts.map((prompt) => (
                        <option key={prompt.prompt_id} value={prompt.prompt_id}>
                          {prompt.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-xs text-ink-muted">{t('prompt.fewShotExamples')}</label>
                    <label className="flex items-center gap-2 text-xs text-ink">
                      <input
                        type="radio"
                        name="few-shot-mode"
                        value="append"
                        checked={mode === 'append'}
                        onChange={() => setMode('append')}
                        className="border-surface-600 bg-surface-800 text-accent"
                      />
                      {t('prompt.appendExample')}
                    </label>
                    <label className="flex items-center gap-2 text-xs text-ink">
                      <input
                        type="radio"
                        name="few-shot-mode"
                        value="replace_latest"
                        checked={mode === 'replace_latest'}
                        onChange={() => setMode('replace_latest')}
                        className="border-surface-600 bg-surface-800 text-accent"
                      />
                      {t('prompt.replaceLatest')}
                    </label>
                    {existingExamples.length > 0 && (
                      <label className="flex items-center gap-2 text-xs text-ink">
                        <input
                          type="radio"
                          name="few-shot-mode"
                          value="replace_selected"
                          checked={mode === 'replace_selected'}
                          onChange={() => setMode('replace_selected')}
                          className="border-surface-600 bg-surface-800 text-accent"
                        />
                        {t('prompt.replaceSelected')}
                      </label>
                    )}
                  </div>

                  {mode === 'replace_selected' && existingExamples.length > 0 && (
                    <div>
                      <select
                        value={replaceIndex}
                        onChange={(event) => setReplaceIndex(Number(event.target.value))}
                        className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                      >
                        {existingExamples.map((example, index) => (
                          <option key={example.example_id ?? index} value={index}>
                            {example.title || `${t('prompt.fewShotExample')} ${index + 1}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs text-ink-muted">{t('prompt.exampleTitle')}</label>
                <input
                  type="text"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-surface-800 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:bg-surface-800"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving || isLoading}
            className="btn-primary inline-flex items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-50"
          >
            {isSaving ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Copy size={12} />
            )}
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkflowButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors',
        active
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-surface-700 bg-surface-950 text-ink-muted hover:bg-surface-800',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
