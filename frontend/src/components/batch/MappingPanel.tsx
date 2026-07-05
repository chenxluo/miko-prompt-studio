import { ChevronDown, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '../../i18n';
import type { ImageSlotSpec, VariableSpec } from '../../types';

type MappingNamespace = 'batch' | 'compare';

interface MappingPanelProps {
  variableSpecs: VariableSpec[];
  imageSlotSpecs: ImageSlotSpec[];
  sampleVarsKeys: string[];
  sampleImageRoles: string[];
  variableMapping: Record<string, string>;
  imageRoleMapping: Record<string, string>;
  onChangeVariableMapping: (mapping: Record<string, string>) => void;
  onChangeImageRoleMapping: (mapping: Record<string, string>) => void;
  namespace?: MappingNamespace;
}

export function MappingPanel({
  variableSpecs,
  imageSlotSpecs,
  sampleVarsKeys,
  sampleImageRoles,
  variableMapping,
  imageRoleMapping,
  onChangeVariableMapping,
  onChangeImageRoleMapping,
  namespace = 'batch',
}: MappingPanelProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);

  const hasSpecs = variableSpecs.length > 0 || imageSlotSpecs.length > 0;
  if (!hasSpecs) return null;

  const handleVariableChange = (taskVarId: string, sampleKey: string) => {
    onChangeVariableMapping({
      ...variableMapping,
      [taskVarId]: sampleKey,
    });
  };

  const handleImageRoleChange = (taskRoleHint: string, sampleRole: string) => {
    onChangeImageRoleMapping({
      ...imageRoleMapping,
      [taskRoleHint]: sampleRole,
    });
  };

  const autoSuggest = () => {
    const nextVariableMapping: Record<string, string> = {};
    for (const spec of variableSpecs) {
      const match = findBestMatch(spec.var_id, sampleVarsKeys);
      if (match) nextVariableMapping[spec.var_id] = match;
    }

    const nextImageRoleMapping: Record<string, string> = {};
    for (const spec of imageSlotSpecs) {
      const target = spec.role_hint || spec.slot_id;
      const match = findBestMatch(target, sampleImageRoles);
      if (match) nextImageRoleMapping[target] = match;
    }

    onChangeVariableMapping(nextVariableMapping);
    onChangeImageRoleMapping(nextImageRoleMapping);
  };

  const hasOptions = sampleVarsKeys.length > 0 || sampleImageRoles.length > 0;

  return (
    <div className="rounded-md border border-surface-800 bg-surface-950">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left transition-colors hover:bg-surface-900"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink-muted">{t(`${namespace}.mapping.title`)}</span>
          <span className="text-[10px] text-ink-dim">{t(`${namespace}.mapping.description`)}</span>
        </div>
        <ChevronDown
          size={14}
          className={`shrink-0 text-ink-dim transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div className="space-y-4 border-t border-surface-800 p-3">
          {hasOptions && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={autoSuggest}
                className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-2 py-1.5 text-[10px] text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
              >
                <Sparkles size={12} />
                {t(`${namespace}.mapping.autoSuggest`)}
              </button>
            </div>
          )}

          {variableSpecs.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                {t(`${namespace}.mapping.variables`)}
              </h4>
              {sampleVarsKeys.length === 0 ? (
                <p className="text-[10px] text-ink-dim">{t(`${namespace}.mapping.noSampleKeys`)}</p>
              ) : (
                <div className="grid gap-2">
                  {variableSpecs.map((spec) => (
                    <MappingRow
                      namespace={namespace}
                      key={spec.var_id}
                      label={spec.label || spec.var_id}
                      hint={spec.var_id}
                      options={sampleVarsKeys}
                      value={variableMapping[spec.var_id] || ''}
                      placeholder={t(`${namespace}.mapping.exactMatch`)}
                      onChange={(value) => handleVariableChange(spec.var_id, value)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {imageSlotSpecs.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                {t(`${namespace}.mapping.imageSlots`)}
              </h4>
              {sampleImageRoles.length === 0 ? (
                <p className="text-[10px] text-ink-dim">{t(`${namespace}.mapping.noSampleRoles`)}</p>
              ) : (
                <div className="grid gap-2">
                  {imageSlotSpecs.map((spec) => {
                    const target = spec.role_hint || spec.slot_id;
                    return (
                      <MappingRow
                        namespace={namespace}
                        key={spec.slot_id}
                        label={spec.label || spec.slot_id}
                        hint={target}
                        options={sampleImageRoles}
                        value={imageRoleMapping[target] || ''}
                        placeholder={t(`${namespace}.mapping.exactMatch`)}
                        onChange={(value) => handleImageRoleChange(target, value)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface MappingRowProps {
  namespace: MappingNamespace;
  label: string;
  hint: string;
  options: string[];
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}

function MappingRow({
  namespace,
  label,
  hint,
  options,
  value,
  placeholder,
  onChange,
}: MappingRowProps) {
  const { t } = useI18n();

  return (
    <div className="grid grid-cols-[1fr,auto,1fr] items-center gap-2 text-xs">
      <div className="min-w-0">
        <div className="truncate font-medium text-ink">{label}</div>
        <div className="truncate text-[10px] text-ink-dim">{hint}</div>
      </div>
      <span className="text-[10px] text-ink-dim">{t(`${namespace}.mapping.to`)}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-surface-700 bg-surface-900 px-2 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

function findBestMatch(target: string, candidates: string[]): string | null {
  if (candidates.length === 0) return null;

  const lowerTarget = target.toLowerCase();
  let best: string | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLowerCase();
    let score = 0;

    if (lowerCandidate === lowerTarget) {
      score = 1000;
    } else if (lowerCandidate.includes(lowerTarget) || lowerTarget.includes(lowerCandidate)) {
      score = 500 + Math.min(lowerCandidate.length, lowerTarget.length);
    } else {
      const prefix = commonPrefixLength(lowerCandidate, lowerTarget);
      if (prefix >= 2) score = prefix;
    }

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1;
  }
  return i;
}
