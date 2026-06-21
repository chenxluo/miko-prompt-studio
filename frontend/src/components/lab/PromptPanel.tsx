import { FileText, Terminal } from 'lucide-react';
import { useCallback, useMemo, useState, type ChangeEvent } from 'react';

import { useI18n } from '../../i18n';
import { useLabStore } from '../../store/labStore';
import type { OutputContract, OutputMode } from '../../types';

export function PromptPanel() {
  const { t } = useI18n();

  const systemPrompt = useLabStore((state) => state.systemPrompt);
  const userPrompt = useLabStore((state) => state.userPrompt);
  const formatInstruction = useLabStore((state) => state.formatInstruction);
  const outputContract = useLabStore((state) => state.outputContract);

  const setSystemPrompt = useLabStore((state) => state.setSystemPrompt);
  const setUserPrompt = useLabStore((state) => state.setUserPrompt);
  const setFormatInstruction = useLabStore((state) => state.setFormatInstruction);
  const setOutputMode = useLabStore((state) => state.setOutputMode);
  const setOutputContract = useLabStore((state) => state.setOutputContract);

  const [jsonError, setJsonError] = useState<string | null>(null);

  const outputModes = useMemo<{ value: OutputMode; label: string }[]>(
    () => [
      { value: 'free_text', label: t('prompt.mode.freeText') },
      { value: 'soft_sections', label: t('prompt.mode.softSections') },
      { value: 'loose_json', label: t('prompt.mode.looseJson') },
      { value: 'strict_json', label: t('prompt.mode.strictJson') },
      { value: 'custom', label: t('prompt.mode.custom') },
    ],
    [t],
  );

  const sectionNames = useMemo(
    () => extractSectionNames(outputContract),
    [outputContract],
  );

  const jsonSchemaString = useMemo(() => {
    if (!outputContract.json_schema) return '';
    try {
      return JSON.stringify(outputContract.json_schema, null, 2);
    } catch {
      return '';
    }
  }, [outputContract.json_schema]);

  const handleModeChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const mode = event.target.value as OutputMode;
      setOutputMode(mode);
    },
    [setOutputMode],
  );

  const handleSectionNamesChange = useCallback(
    (value: string) => {
      const sections = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const parser =
        sections.length > 0
          ? { type: 'sections', options: { sections } }
          : null;
      setOutputContract({
        ...outputContract,
        parser,
      });
    },
    [outputContract, setOutputContract],
  );

  const handleJsonSchemaChange = useCallback(
    (value: string) => {
      if (!value.trim()) {
        setJsonError(null);
        setOutputContract({
          ...outputContract,
          json_schema: null,
        });
        return;
      }
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        setJsonError(null);
        setOutputContract({
          ...outputContract,
          json_schema: parsed,
        });
      } catch {
        setJsonError(t('prompt.invalidJsonSchema'));
      }
    },
    [outputContract, setOutputContract, t],
  );

  return (
    <section className="panel flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-surface-800 px-4 py-3">
        <FileText size={16} className="text-accent" />
        <span className="text-sm font-semibold text-ink">{t('prompt.title')}</span>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
            <Terminal size={12} />
            {t('prompt.systemPrompt')}
          </label>
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows={4}
            className="min-h-[5rem] resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
            <Terminal size={12} />
            {t('prompt.userPrompt')}
          </label>
          <textarea
            value={userPrompt}
            onChange={(event) => setUserPrompt(event.target.value)}
            rows={4}
            className="min-h-[5rem] resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
          <p className="text-xs text-ink-dim">{t('prompt.imageRefHint')}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted">
            {t('prompt.formatInstruction')}
          </label>
          <textarea
            value={formatInstruction}
            onChange={(event) => setFormatInstruction(event.target.value)}
            rows={2}
            className="min-h-[3rem] resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted">
            {t('prompt.outputContractMode')}
          </label>
          <select
            value={outputContract.mode ?? 'free_text'}
            onChange={handleModeChange}
            className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
          >
            {outputModes.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
        </div>

        {outputContract.mode === 'soft_sections' && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-muted">
              {t('prompt.sectionNames')}
            </label>
            <input
              type="text"
              value={sectionNames}
              onChange={(event) => handleSectionNamesChange(event.target.value)}
              placeholder={t('prompt.sectionNamesPlaceholder')}
              className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
          </div>
        )}

        {(outputContract.mode === 'loose_json' ||
          outputContract.mode === 'strict_json') && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-muted">
              {t('prompt.jsonSchema')}
            </label>
            <textarea
              defaultValue={jsonSchemaString}
              onChange={(event) => handleJsonSchemaChange(event.target.value)}
              rows={6}
              className="min-h-[6rem] resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
            {jsonError && (
              <p className="text-xs text-danger">{jsonError}</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function extractSectionNames(contract: OutputContract): string {
  const parser = contract.parser;
  if (!parser || parser.type !== 'sections') return '';
  const sections = parser.options?.sections;
  if (Array.isArray(sections)) {
    return sections
      .filter((section): section is string => typeof section === 'string')
      .join(', ');
  }
  return '';
}
