import { Loader2, X } from 'lucide-react';
import { useState } from 'react';

import { createTask } from '../../api/client';
import { useI18n } from '../../i18n';
import { buildPromptWithImageSlots, useLabStore } from '../../store/labStore';

interface SaveTaskDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SaveTaskDialog({ isOpen, onClose }: SaveTaskDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const state = useLabStore.getState();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('task.nameRequired'));
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      await createTask({
        name: trimmedName,
        provider_config_id: state.selectedProviderConfigId,
        model_id: state.modelId,
        model_parameters: state.modelParameters as Record<string, unknown>,
        system_prompt: state.systemPrompt,
        user_prompt: buildPromptWithImageSlots(state.userPrompt, state.imageSlots),
        format_instruction: state.formatInstruction,
        output_contract: state.outputContract as Record<string, unknown>,
        pricing_profile_id: state.activePricing?.pricing_profile_id ?? null,
        image_resolution_enabled: state.imageResolutionEnabled,
        image_resolution_target: state.imageResolutionTarget,
        notes,
      });
      setMessage(t('task.saved'));
      setName('');
      setNotes('');
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
          <h2 className="text-sm font-semibold text-ink">{t('task.saveAsTask')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-muted hover:bg-surface-800 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
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
