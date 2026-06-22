import { Check, ChevronDown, ChevronUp, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useI18n } from '../../i18n';
import { useSettingsStore } from '../../store/settingsStore';
import type { FewShotExample, ImageSlotSpec } from '../../types';
import { ImagePreviewGrid } from './ImagePreviewGrid';

interface PromptEditorProps {
  prompt?: {
    prompt_id: string;
    name: string;
    latest_version?: {
      system_prompt?: string;
      user_template?: string;
      notes?: string;
      image_slot_specs?: ImageSlotSpec[];
      few_shot_examples?: FewShotExample[];
    } | null;
  } | null;
  onSaved?: () => void;
  onCancel?: () => void;
}

export function PromptEditor({ prompt, onSaved, onCancel }: PromptEditorProps) {
  const { t } = useI18n();
  const savePrompt = useSettingsStore((state) => state.savePrompt);
  const isLoading = useSettingsStore((state) => state.isLoading);
  const storeError = useSettingsStore((state) => state.error);

  const [name, setName] = useState(prompt?.name ?? '');
  const [systemPrompt, setSystemPrompt] = useState(
    prompt?.latest_version?.system_prompt ?? '',
  );
  const [userTemplate, setUserTemplate] = useState(
    prompt?.latest_version?.user_template ?? '',
  );
  const [notes, setNotes] = useState(prompt?.latest_version?.notes ?? '');
  const [imageSlotSpecs, setImageSlotSpecs] = useState<ImageSlotSpec[]>(
    prompt?.latest_version?.image_slot_specs ?? [],
  );
  const [fewShotExamples, setFewShotExamples] = useState<FewShotExample[]>(
    prompt?.latest_version?.few_shot_examples ?? [],
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const error = localError ?? storeError;

  const hasChanges = useMemo(() => {
    const version = prompt?.latest_version;
    return (
      name !== (prompt?.name ?? '') ||
      systemPrompt !== (version?.system_prompt ?? '') ||
      userTemplate !== (version?.user_template ?? '') ||
      notes !== (version?.notes ?? '') ||
      !arraysEqual(imageSlotSpecs, version?.image_slot_specs ?? []) ||
      !arraysEqual(fewShotExamples, version?.few_shot_examples ?? [])
    );
  }, [prompt, name, systemPrompt, userTemplate, notes, imageSlotSpecs, fewShotExamples]);

  function arraysEqual(a: unknown[], b: unknown[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((item, index) => JSON.stringify(item) === JSON.stringify(b[index]));
  }

  function handleAddImageSlot() {
    setImageSlotSpecs((current) => [
      ...current,
      {
        slot_id: `slot_${Date.now()}`,
        label: '',
        description: '',
        required: true,
        min_count: 1,
        max_count: 1,
      },
    ]);
  }

  function handleUpdateImageSlot(index: number, patch: Partial<ImageSlotSpec>) {
    setImageSlotSpecs((current) =>
      current.map((spec, i) => (i === index ? { ...spec, ...patch } : spec)),
    );
  }

  function handleDeleteImageSlot(index: number) {
    setImageSlotSpecs((current) => current.filter((_, i) => i !== index));
  }

  function handleMoveImageSlot(index: number, direction: -1 | 1) {
    setImageSlotSpecs((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function handleAddFewShotExample() {
    setFewShotExamples((current) => [
      ...current,
      {
        example_id: `ex_${Date.now()}`,
        title: '',
        enabled: true,
        input_text: '',
        output_text: '',
        parsed_output: null,
        reasoning_text: null,
        images: [],
        source_run_id: null,
        source_run_item_id: null,
        source_attempt_id: null,
        notes: '',
        created_from: 'manual',
      },
    ]);
  }

  function handleUpdateFewShotExample(index: number, patch: Partial<FewShotExample>) {
    setFewShotExamples((current) =>
      current.map((example, i) => (i === index ? { ...example, ...patch } : example)),
    );
  }

  function handleDeleteFewShotExample(index: number) {
    setFewShotExamples((current) => current.filter((_, i) => i !== index));
  }

  async function handleSave() {
    setLocalError(null);
    if (!name.trim()) {
      setLocalError(t('prompt.nameRequired'));
      return;
    }
    try {
      await savePrompt({
        name: name.trim(),
        system_prompt: systemPrompt,
        user_template: userTemplate,
        notes,
        image_slot_specs: imageSlotSpecs,
        few_shot_examples: fewShotExamples,
        prompt_id: prompt?.prompt_id ?? null,
      });
      onSaved?.();
    } catch {
      // error is already captured in storeError
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
        <span className="text-sm font-semibold text-ink">
          {prompt ? t('prompt.editPrompt') : t('prompt.createPrompt')}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
          aria-label={t('common.cancel')}
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
        {error && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <label className="block text-xs font-medium text-ink-muted">
            {t('prompt.name')}
          </label>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('prompt.namePlaceholder')}
            className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>

        <div className="space-y-3">
          <label className="block text-xs font-medium text-ink-muted">
            {t('prompt.systemPrompt')}
          </label>
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows={4}
            className="min-h-[5rem] w-full resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>

        <div className="space-y-3">
          <label className="block text-xs font-medium text-ink-muted">
            {t('prompt.userTemplate')}
          </label>
          <textarea
            value={userTemplate}
            onChange={(event) => setUserTemplate(event.target.value)}
            rows={6}
            placeholder={t('prompt.userTemplatePlaceholder')}
            className="min-h-[6rem] w-full resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
          <p className="text-xs text-ink-dim">{t('prompt.userTemplateHint')}</p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-medium text-ink-muted">
              {t('prompt.imageSlotSpecs')}
            </label>
            <button
              type="button"
              onClick={handleAddImageSlot}
              className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1 text-xs text-ink-muted hover:bg-surface-800"
            >
              <Plus size={12} />
              {t('prompt.addImageSlot')}
            </button>
          </div>

          {imageSlotSpecs.length === 0 ? (
            <div className="rounded-md border border-dashed border-surface-700 p-4 text-center text-xs text-ink-dim">
              {t('prompt.noImageSlots')}
            </div>
          ) : (
            <div className="space-y-2">
              {imageSlotSpecs.map((spec, index) => (
                <div
                  key={spec.slot_id ?? index}
                  className="rounded-md border border-surface-700 bg-surface-950 p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-ink-muted">
                      {t('prompt.imageSlot')} {index + 1}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleMoveImageSlot(index, -1)}
                        disabled={index === 0}
                        className="rounded p-1 text-ink-dim hover:bg-surface-800 disabled:opacity-30"
                        aria-label={t('prompt.moveUp')}
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveImageSlot(index, 1)}
                        disabled={index === imageSlotSpecs.length - 1}
                        className="rounded p-1 text-ink-dim hover:bg-surface-800 disabled:opacity-30"
                        aria-label={t('prompt.moveDown')}
                      >
                        <ChevronDown size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteImageSlot(index)}
                        className="rounded p-1 text-ink-dim hover:bg-danger/10 hover:text-danger"
                        aria-label={t('prompt.deleteImageSlot')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-3">
                    <input
                      type="text"
                      value={spec.label ?? ''}
                      onChange={(event) =>
                        handleUpdateImageSlot(index, { label: event.target.value })
                      }
                      placeholder={t('prompt.imageSlotLabel')}
                      className="w-full rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                    />
                    <input
                      type="text"
                      value={spec.description ?? ''}
                      onChange={(event) =>
                        handleUpdateImageSlot(index, { description: event.target.value })
                      }
                      placeholder={t('prompt.imageSlotDescription')}
                      className="w-full rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                    />
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 text-xs text-ink-muted">
                        <input
                          type="checkbox"
                          checked={spec.required ?? true}
                          onChange={(event) =>
                            handleUpdateImageSlot(index, { required: event.target.checked })
                          }
                          className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
                        />
                        {t('prompt.required')}
                      </label>
                      <label className="flex items-center gap-2 text-xs text-ink-muted">
                        {t('prompt.minCount')}
                        <input
                          type="number"
                          min={0}
                          value={spec.min_count ?? 1}
                          onChange={(event) =>
                            handleUpdateImageSlot(index, {
                              min_count: Number(event.target.value),
                            })
                          }
                          className="w-16 rounded-md border border-surface-700 bg-surface-900 px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
                        />
                      </label>
                      <label className="flex items-center gap-2 text-xs text-ink-muted">
                        {t('prompt.maxCount')}
                        <input
                          type="number"
                          min={1}
                          value={spec.max_count ?? ''}
                          onChange={(event) =>
                            handleUpdateImageSlot(index, {
                              max_count:
                                event.target.value === ''
                                  ? null
                                  : Number(event.target.value),
                            })
                          }
                          placeholder={t('prompt.unlimited')}
                          className="w-16 rounded-md border border-surface-700 bg-surface-900 px-2 py-1 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                        />
                      </label>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-medium text-ink-muted">
              {t('prompt.fewShotExamples')}
            </label>
            <button
              type="button"
              onClick={handleAddFewShotExample}
              className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1 text-xs text-ink-muted hover:bg-surface-800"
            >
              <Plus size={12} />
              {t('prompt.addFewShotExample')}
            </button>
          </div>

          {fewShotExamples.length === 0 ? (
            <div className="rounded-md border border-dashed border-surface-700 p-4 text-center text-xs text-ink-dim">
              {t('prompt.noFewShotExamples')}
            </div>
          ) : (
            <div className="space-y-2">
              {fewShotExamples.map((example, index) => (
                <div
                  key={example.example_id ?? index}
                  className="rounded-md border border-surface-700 bg-surface-950 p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-xs text-ink-muted">
                      <input
                        type="checkbox"
                        checked={example.enabled ?? true}
                        onChange={(event) =>
                          handleUpdateFewShotExample(index, {
                            enabled: event.target.checked,
                          })
                        }
                        className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
                      />
                      {t('prompt.fewShotEnabled')}
                    </label>
                    <button
                      type="button"
                      onClick={() => handleDeleteFewShotExample(index)}
                      className="rounded p-1 text-ink-dim hover:bg-danger/10 hover:text-danger"
                      aria-label={t('prompt.deleteFewShotExample')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                    <div className="grid gap-3">
                      <input
                        type="text"
                        value={example.title ?? ''}
                        onChange={(event) =>
                          handleUpdateFewShotExample(index, { title: event.target.value })
                        }
                        placeholder={t('prompt.fewShotTitle')}
                        className="w-full rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                      />
                      <ImagePreviewGrid images={example.images ?? []} maxVisible={4} />
                      <textarea
                        value={example.input_text ?? ''}
                        onChange={(event) =>
                          handleUpdateFewShotExample(index, {
                            input_text: event.target.value,
                          })
                        }
                        placeholder={t('prompt.fewShotInput')}
                        rows={2}
                        className="w-full resize-y rounded-md border border-surface-700 bg-surface-900 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                      />
                      <textarea
                        value={example.output_text ?? ''}
                        onChange={(event) =>
                          handleUpdateFewShotExample(index, {
                            output_text: event.target.value,
                          })
                        }
                        placeholder={t('prompt.fewShotOutput')}
                        rows={3}
                        className="w-full resize-y rounded-md border border-surface-700 bg-surface-900 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                      />
                    </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <label className="block text-xs font-medium text-ink-muted">
            {t('prompt.notes')}
          </label>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            className="min-h-[4rem] w-full resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-surface-800 px-4 py-3">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:bg-surface-800"
          >
            {t('common.cancel')}
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={isLoading || !hasChanges}
          className="btn-primary px-3 py-2 text-xs disabled:opacity-50"
        >
          {isLoading ? (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-surface-900 border-t-transparent" />
          ) : (
            <Check size={14} />
          )}
          {t('prompt.save')}
        </button>
      </div>
    </div>
  );
}
