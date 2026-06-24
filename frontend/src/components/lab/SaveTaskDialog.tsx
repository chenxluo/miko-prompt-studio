import { Loader2, Tag, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { createTask, createTaskVersion, savePrompt } from '../../api/client';
import { useI18n } from '../../i18n';
import {
  buildImagePreprocessConfig,
  buildPromptWithImageSlots,
  useLabStore,
} from '../../store/labStore';
import type { ImagePreprocessConfig, ImageSlotSpec, VariableSpec } from '../../types';

export interface SaveTaskDialogPrefill {
  prompt_id?: string | null;
  prompt_version_id?: string | null;
  system_prompt?: string;
  user_template?: string;
  format_instruction?: string;
  image_slot_specs?: ImageSlotSpec[];
  variable_specs?: VariableSpec[];
  provider_config_id?: string | null;
  model_id?: string;
  model_parameters?: Record<string, unknown>;
  output_contract?: Record<string, unknown>;
  image_preprocess_config?: ImagePreprocessConfig | null;
  pricing_profile_id?: string | null;
  notes?: string;
}

interface SaveTaskDialogProps {
  isOpen: boolean;
  onClose: () => void;
  prefill?: SaveTaskDialogPrefill | null;
}

export function SaveTaskDialog({ isOpen, onClose, prefill }: SaveTaskDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState(prefill?.notes ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAddingVersion = Boolean(useLabStore.getState().activeTaskId);

  useEffect(() => {
    if (isOpen) {
      setNotes(prefill?.notes ?? '');
      setMessage(null);
      setError(null);
    }
  }, [isOpen, prefill?.notes]);

  const resetForm = () => {
    setName('');
    setDescription('');
    setTags('');
    setNotes(prefill?.notes ?? '');
  };

  async function resolvePromptIds(): Promise<
    { promptId: string; promptVersionId: string } | { error: string }
  > {
    const state = useLabStore.getState();

    // When prefill explicitly provides both IDs, trust them (e.g. loading
    // from an external source that already persisted a prompt version).
    if (prefill?.prompt_id && prefill?.prompt_version_id) {
      return { promptId: prefill.prompt_id, promptVersionId: prefill.prompt_version_id };
    }

    // Always create a NEW prompt version with the current (possibly edited)
    // prompt text.  Reusing activePromptVersionId would silently ignore the
    // user's edits because the old PromptVersion row still holds the old text.
    const trimmedName = name.trim() || t('task.untitled');
    const saved = await savePrompt({
      name: trimmedName,
      system_prompt: prefill?.system_prompt ?? state.systemPrompt,
      user_template:
        prefill?.user_template ?? buildPromptWithImageSlots(state.userPrompt, state.imageSlots),
      format_instruction: prefill?.format_instruction ?? state.formatInstruction,
      notes,
    });
    return { promptId: saved.prompt_id, promptVersionId: saved.prompt_version_id };
  }

  const handleSave = async () => {
    const state = useLabStore.getState();
    const trimmedName = name.trim();
    if (!isAddingVersion && !trimmedName) {
      setError(t('task.nameRequired'));
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    try {
      const promptResult = await resolvePromptIds();
      if ('error' in promptResult) {
        setError(promptResult.error);
        return;
      }

      const modelParameters =
        prefill?.model_parameters ??
        (state.modelParameters as Record<string, unknown>);
      const outputContract =
        prefill?.output_contract ??
        (state.outputContract as Record<string, unknown>);
      const imagePreprocessConfig =
        prefill?.image_preprocess_config ??
        buildImagePreprocessConfig(state.imageResolutionEnabled, state.imageResolutionTarget);

      const versionPayload = {
        prompt_id: promptResult.promptId,
        prompt_version_id: promptResult.promptVersionId,
        provider_config_id: prefill?.provider_config_id ?? state.selectedProviderConfigId,
        model_id: prefill?.model_id ?? state.modelId,
        model_parameters: modelParameters,
        output_contract: outputContract,
        image_preprocess_config: imagePreprocessConfig ?? {},
        pricing_profile_id:
          prefill?.pricing_profile_id ?? state.activePricing?.pricing_profile_id ?? null,
        notes,
        image_slot_specs: prefill?.image_slot_specs ?? state.templateImageSlotSpecs,
        variable_specs: prefill?.variable_specs ?? state.templateVariableSpecs,
      };

      if (state.activeTaskId) {
        const newVersion = await createTaskVersion(state.activeTaskId, versionPayload);
        // Update active version so subsequent operations (e.g. save snapshot) link to the new version
        useLabStore.setState({
          activeTaskVersionId: newVersion.task_version_id,
        });
        setMessage(t('task.versionSaved'));
      } else {
        const newTask = await createTask({
          name: trimmedName,
          description: description.trim() || undefined,
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          version: versionPayload,
        });
        useLabStore.setState({
          activeTaskId: newTask.task_id,
          activeTaskVersionId: newTask.current_version?.task_version_id ?? null,
        });
        setMessage(t('task.saved'));
      }

      resetForm();
      window.setTimeout(onClose, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('task.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-surface-700 bg-surface-900 p-4 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">
            {isAddingVersion ? t('task.saveNewVersion') : t('task.saveAsTask')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-muted hover:bg-surface-800 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          {!isAddingVersion && (
            <>
              <label className="flex flex-col gap-1 text-xs text-ink-muted">
                {t('task.name')}
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                  autoFocus
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-ink-muted">
                {t('task.descriptionLabel')}
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-ink-muted">
                <span className="inline-flex items-center gap-1">
                  <Tag size={12} />
                  {t('task.tags')}
                </span>
                <input
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder={t('task.tagsHint')}
                  className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                />
              </label>
            </>
          )}
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            {t('task.notes')}
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={4}
              className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>
        </div>

        {(error || message) && (
          <p className={['mt-3 text-xs', error ? 'text-danger' : 'text-accent'].join(' ')}>
            {error ?? message}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:text-ink"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving}
            className="btn-primary px-3 py-2 text-xs disabled:opacity-50"
          >
            {isSaving && <Loader2 size={14} className="animate-spin" />}
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
