import { Braces, Check, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { useI18n } from '../../i18n';
import { useSettingsStore } from '../../store/settingsStore';
import type { PromptListItem } from '../../types';

interface PromptEditorProps {
  prompt?: PromptListItem | null;
  onSaved?: () => void;
  onCancel?: () => void;
}

export function PromptEditor({ prompt, onSaved, onCancel }: PromptEditorProps) {
  const { t } = useI18n();
  const savePrompt = useSettingsStore((state) => state.savePrompt);
  const isLoading = useSettingsStore((state) => state.isLoading);
  const storeError = useSettingsStore((state) => state.error);
  const userTemplateRef = useRef<HTMLTextAreaElement>(null);

  const [name, setName] = useState(prompt?.name ?? '');
  const [systemPrompt, setSystemPrompt] = useState(
    prompt?.latest_version?.system_prompt ?? '',
  );
  const [userTemplate, setUserTemplate] = useState(
    prompt?.latest_version?.user_template ?? '',
  );
  const [formatInstruction, setFormatInstruction] = useState(
    prompt?.latest_version?.format_instruction ?? '',
  );
  const [notes, setNotes] = useState(prompt?.latest_version?.notes ?? '');
  const [conditionalName, setConditionalName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const error = localError ?? storeError;

  const hasChanges = useMemo(() => {
    const version = prompt?.latest_version;
    return (
      name !== (prompt?.name ?? '') ||
      systemPrompt !== (version?.system_prompt ?? '') ||
      userTemplate !== (version?.user_template ?? '') ||
      formatInstruction !== (version?.format_instruction ?? '') ||
      notes !== (version?.notes ?? '')
    );
  }, [prompt, name, systemPrompt, userTemplate, formatInstruction, notes]);

  function handleInsertConditional() {
    const textarea = userTemplateRef.current;
    if (!textarea) return;

    const name = conditionalName.trim();
    if (!name) {
      textarea.focus();
      return;
    }

    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const before = userTemplate.slice(0, start);
    const selected = userTemplate.slice(start, end);
    const after = userTemplate.slice(end);
    const open = `{{#vars.${name}}}`;
    const close = `{{/vars.${name}}}`;
    const nextValue = before + open + selected + close + after;

    setUserTemplate(nextValue);

    const caret = selected.length > 0 ? start + open.length + selected.length + close.length : start + open.length;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
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
        format_instruction: formatInstruction,
        notes,
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
          <div className="flex items-center justify-between">
            <label className="block text-xs font-medium text-ink-muted">
              {t('prompt.userTemplate')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={conditionalName}
                onChange={(event) => setConditionalName(event.target.value)}
                placeholder={t('prompt.conditionalVarName')}
                className="w-28 rounded-md border border-surface-700 bg-surface-950 px-2 py-1.5 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={handleInsertConditional}
                className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1.5 text-xs text-ink-muted hover:bg-surface-800"
                title={t('prompt.insertConditional')}
              >
                <Braces size={12} />
                {t('prompt.insertConditional')}
              </button>
            </div>
          </div>
          <textarea
            ref={userTemplateRef}
            value={userTemplate}
            onChange={(event) => setUserTemplate(event.target.value)}
            rows={6}
            placeholder={t('prompt.userTemplatePlaceholder')}
            className="min-h-[6rem] w-full resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
          <p className="text-xs text-ink-dim">{t('prompt.userTemplateHint')}</p>
        </div>

        <div className="space-y-3">
          <label className="block text-xs font-medium text-ink-muted">
            {t('prompt.formatInstruction')}
          </label>
          <textarea
            value={formatInstruction}
            onChange={(event) => setFormatInstruction(event.target.value)}
            rows={3}
            className="min-h-[4rem] w-full resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
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
