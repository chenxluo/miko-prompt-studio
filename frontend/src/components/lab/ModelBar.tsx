import {
  Brain,
  ChevronDown,
  ChevronUp,
  Coins,
  Cpu,
  Play,
  Settings,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useLabStore } from '../../store/labStore';
import { useI18n } from '../../i18n';
import { SaveTaskDialog } from './SaveTaskDialog';

export function ModelBar() {
  const { t } = useI18n();
  const providerConfigs = useLabStore((s) => s.providerConfigs);
  const selectedProviderConfigId = useLabStore((s) => s.selectedProviderConfigId);
  const modelId = useLabStore((s) => s.modelId);
  const modelParameters = useLabStore((s) => s.modelParameters);
  const images = useLabStore((s) => s.images);
  const isRunning = useLabStore((s) => s.isRunning);
  const availableModels = useLabStore((s) => s.availableModels);
  const lastResult = useLabStore((s) => s.lastResult);
  const lastRunItem = useLabStore((s) => s.lastRunItem);
  const activePricing = useLabStore((s) => s.activePricing);

  const setSelectedProviderConfigId = useLabStore((s) => s.setSelectedProviderConfigId);
  const setModelId = useLabStore((s) => s.setModelId);
  const setModelParameters = useLabStore((s) => s.setModelParameters);
  const run = useLabStore((s) => s.run);
  const abortRun = useLabStore((s) => s.abortRun);
  const loadProviderConfigs = useLabStore((s) => s.loadProviderConfigs);
  const loadActivePricing = useLabStore((s) => s.loadActivePricing);

  const [parametersOpen, setParametersOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [isSaveTaskOpen, setIsSaveTaskOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const pricingRef = useRef<HTMLDivElement>(null);

  const lastTempRef = useRef<number>(modelParameters.temperature ?? 0.7);
  const lastTopPRef = useRef<number>(modelParameters.top_p ?? 0.9);

  useEffect(() => {
    if (modelParameters.temperature != null) {
      lastTempRef.current = modelParameters.temperature;
    }
  }, [modelParameters.temperature]);

  useEffect(() => {
    if (modelParameters.top_p != null) {
      lastTopPRef.current = modelParameters.top_p;
    }
  }, [modelParameters.top_p]);

  useEffect(() => {
    void loadProviderConfigs();
  }, [loadProviderConfigs]);

  useEffect(() => {
    void loadActivePricing();
  }, [loadActivePricing, selectedProviderConfigId, modelId]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (pricingRef.current && !pricingRef.current.contains(event.target as Node)) {
        setPricingOpen(false);
      }
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setPricingOpen(false);
    }
    if (pricingOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEsc);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [pricingOpen]);

  const selectedConfig = providerConfigs.find(
    (c) => c.provider_config_id === selectedProviderConfigId,
  );

  const costEstimate = resolveCostEstimate(lastResult, lastRunItem);
  const canRun =
    !isRunning && images.length > 0 && !!selectedProviderConfigId && !!modelId.trim();

  const navigateToSettings = () => {
    window.dispatchEvent(new CustomEvent('miko:navigate', { detail: 'settings' }));
  };

  return (
    <div className="panel flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-end gap-3">
        {/* Provider config */}
        <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
            {t('model.providerConfig')}
          </label>
          {providerConfigs.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-surface-700 bg-surface-800/50 px-2.5 py-2">
              <span className="flex-1 truncate text-xs text-ink-dim">
                {t('settings.noProviderConfigs')}
              </span>
              <button
                type="button"
                onClick={navigateToSettings}
                className="flex shrink-0 items-center gap-1 text-xs text-accent hover:underline"
              >
                <Settings size={12} />
                {t('model.manageInSettings')}
              </button>
            </div>
          ) : (
            <select
              value={selectedProviderConfigId ?? ''}
              onChange={(e) => setSelectedProviderConfigId(e.target.value || null)}
              className="w-full truncate rounded-md border border-surface-700 bg-surface-950 px-2.5 py-2 text-xs text-ink focus:border-accent focus:outline-none"
            >
              <option value="" disabled>
                {t('model.providerConfig')}
              </option>
              {providerConfigs.map((config) => (
                <option key={config.provider_config_id} value={config.provider_config_id}>
                  {config.name} ({config.adapter_id})
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Model ID */}
        <div className="flex min-w-[12rem] flex-[2] flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
            {t('model.modelId')}
          </label>
          <div className="flex gap-1.5">
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              disabled={!selectedProviderConfigId}
              className="flex-1 rounded-md border border-surface-700 bg-surface-950 px-2.5 py-2 text-xs text-ink focus:border-accent focus:outline-none disabled:opacity-50"
            >
              {availableModels.length === 0 && <option value="">{t('model.selectOrType')}</option>}
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              {/* Allow custom model not in the cached list */}
              {modelId && !availableModels.includes(modelId) && (
                <option value={modelId}>{modelId}</option>
              )}
            </select>
          </div>
          {selectedConfig && (
            <span className="text-[10px] text-ink-dim">
              {selectedConfig.cached_models.length > 0
                ? t('model.cacheStatus', { count: selectedConfig.cached_models.length })
                : t('model.cacheEmpty')}
              {selectedConfig.models_cached_at
                ? ` · ${t('model.cachedAt', { time: formatCacheTime(selectedConfig.models_cached_at) })}`
                : ''}
            </span>
          )}
          {!selectedConfig?.api_key_set && selectedConfig && (
            <span className="text-[10px] text-cost">
              ⚠ {t('settings.noKeys')}
            </span>
          )}
        </div>

        {/* Parameters toggle */}
        <button
          type="button"
          onClick={() => setParametersOpen((v) => !v)}
          aria-expanded={parametersOpen}
          className={[
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-medium transition-colors',
            parametersOpen
              ? 'border-accent/50 bg-accent/10 text-accent'
              : 'border-surface-700 bg-surface-800 text-ink-muted hover:border-surface-600 hover:text-ink',
          ].join(' ')}
        >
          <SlidersHorizontal size={14} />
          {t('model.parameters')}
        </button>

        <div className="hidden h-6 w-px bg-surface-800 sm:block" />

        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Pricing chip */}
          <div ref={pricingRef} className="relative">
            {activePricing ? (
              <button
                type="button"
                onClick={() => setPricingOpen((v) => !v)}
                aria-expanded={pricingOpen}
                className={[
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] transition-colors',
                  pricingOpen
                    ? 'border-accent/50 bg-accent/10 text-accent'
                    : 'border-surface-700 bg-surface-800 text-ink hover:border-surface-600 hover:text-ink',
                ].join(' ')}
                title={t('pricing.active')}
              >
                <Coins size={12} className="text-accent" />
                <span className="max-w-[12rem] truncate sm:max-w-[16rem]">
                  {formatPricingChip(activePricing, t)}
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={navigateToSettings}
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-surface-600 bg-surface-800/50 px-2.5 py-1.5 text-[11px] text-ink-dim transition-colors hover:border-surface-500 hover:text-ink"
                title={t('pricing.noActive')}
              >
                <Coins size={12} />
                <span className="max-w-[12rem] truncate sm:max-w-[16rem]">
                  {t('pricing.noActive')}
                </span>
              </button>
            )}
            {activePricing && pricingOpen && (
              <div className="absolute right-0 top-full z-10 mt-2 w-64 rounded-md border border-surface-700 bg-surface-900 p-3 shadow-panel animate-fade-in">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-ink">
                  <Cpu size={14} className="text-accent" />
                  {t('pricing.active')}
                </div>
                <div className="space-y-1.5 text-[11px]">
                  <PricingRow label={t('pricing.providerConfig')} value={activePricing.provider_config_id ?? activePricing.provider_id} />
                  <PricingRow label={t('pricing.model')} value={activePricing.model_id} />
                  <PricingRow label={t('pricing.input')} value={`${activePricing.currency} ${activePricing.input_token_price}/1M`} />
                  <PricingRow label={t('pricing.output')} value={`${activePricing.currency} ${activePricing.output_token_price}/1M`} />
                  {activePricing.cached_input_price != null && (
                    <PricingRow label={t('pricing.cached')} value={`${activePricing.currency} ${activePricing.cached_input_price}/1M`} />
                  )}
                  <PricingRow label={t('pricing.image')} value={formatImagePricing(activePricing.image_pricing, activePricing.currency)} />
                  <PricingRow label={t('pricing.discount')} value={`${(activePricing.batch_discount * 100).toFixed(0)}%`} />
                </div>
              </div>
            )}
          </div>

          {costEstimate && (
            <div className="flex items-center gap-1.5 rounded-md bg-surface-800 px-2.5 py-2 text-xs">
              <Cpu size={14} className="text-cost" />
              <span className="text-ink-muted">{t('lab.cost')}:</span>
              <span className="font-medium text-cost">
                {costEstimate.currency} {costEstimate.amount.toFixed(6)}
              </span>
            </div>
          )}

          {/* Run */}
          <button
            type="button"
            onClick={() => setIsSaveTaskOpen(true)}
            className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-xs font-medium text-ink-muted transition-colors hover:border-surface-600 hover:text-ink"
          >
            {t('task.saveAsTask')}
          </button>

          <button
            type="button"
            onClick={isRunning ? abortRun : () => void run()}
            disabled={!isRunning && !canRun}
            className={
              isRunning
                ? 'inline-flex min-w-[6rem] items-center justify-center gap-1.5 rounded-md border border-cost/50 bg-cost/15 px-4 py-2 text-xs font-medium text-cost transition-colors hover:bg-cost/25'
                : 'btn-primary min-w-[6rem] px-4 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50'
            }
          >
            {isRunning ? (
              <>
                <Square size={13} className="fill-current" />
                {t('lab.abort')}
              </>
            ) : (
              <>
                <Play size={14} />
                {t('lab.run')}
              </>
            )}
          </button>
        </div>
      </div>

      <SaveTaskDialog isOpen={isSaveTaskOpen} onClose={() => setIsSaveTaskOpen(false)} />

      {/* Collapsible parameters */}
      {parametersOpen && (
        <div className="grid grid-cols-1 gap-3 border-t border-surface-800 pt-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Temperature */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                {t('model.temperature')}
              </label>
              <ToggleSwitch
                checked={modelParameters.temperature !== null}
                onChange={(checked) =>
                  setModelParameters({
                    ...modelParameters,
                    temperature: checked ? lastTempRef.current : null,
                  })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                disabled={modelParameters.temperature === null}
                value={modelParameters.temperature ?? lastTempRef.current}
                onChange={(e) =>
                  setModelParameters({
                    ...modelParameters,
                    temperature: parseNumber(e.target.value),
                  })
                }
                className="slider flex-1 disabled:opacity-40"
              />
              <span className="w-8 text-right text-xs font-medium text-ink">
                {modelParameters.temperature !== null
                  ? modelParameters.temperature
                  : t('model.paramDefault')}
              </span>
            </div>
          </div>

          {/* Max tokens */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
              {t('model.maxOutputTokens')}
            </label>
            <input
              type="number"
              min={1}
              step={1}
              value={modelParameters.max_output_tokens ?? ''}
              onChange={(e) =>
                setModelParameters({
                  ...modelParameters,
                  max_output_tokens: parseIntOrNull(e.target.value),
                })
              }
              className="rounded-md border border-surface-700 bg-surface-950 px-2.5 py-2 text-xs text-ink focus:border-accent focus:outline-none"
            />
          </div>

          {/* Top P */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                {t('model.topP')}
              </label>
              <ToggleSwitch
                checked={modelParameters.top_p !== null}
                onChange={(checked) =>
                  setModelParameters({
                    ...modelParameters,
                    top_p: checked ? lastTopPRef.current : null,
                  })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                disabled={modelParameters.top_p === null}
                value={modelParameters.top_p ?? lastTopPRef.current}
                onChange={(e) =>
                  setModelParameters({
                    ...modelParameters,
                    top_p: parseNumber(e.target.value),
                  })
                }
                className="slider flex-1 disabled:opacity-40"
              />
              <span className="w-10 text-right text-xs font-medium text-ink">
                {modelParameters.top_p !== null
                  ? modelParameters.top_p
                  : t('model.paramDefault')}
              </span>
            </div>
          </div>

          {/* Stream toggle */}
          <div className="flex items-center gap-2">
            <input
              id="enable-streaming"
              type="checkbox"
              checked={modelParameters.stream ?? false}
              onChange={(e) =>
                setModelParameters({
                  ...modelParameters,
                  stream: e.target.checked,
                })
              }
              className="h-4 w-4 rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
            />
            <label htmlFor="enable-streaming" className="text-xs text-ink-muted">
              {t('model.enableStreaming')}
            </label>
          </div>

          {/* Thinking parameters */}
          <div className="sm:col-span-2 lg:col-span-3">
            <div className="rounded-md border border-surface-800 bg-surface-900/50">
              <button
                type="button"
                onClick={() => setThinkingOpen((v) => !v)}
                className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-ink-muted hover:text-ink"
              >
                <span className="flex items-center gap-1.5">
                  <Brain size={14} />
                  {t('model.thinking')}
                </span>
                {thinkingOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {thinkingOpen && (
                <div className="grid grid-cols-1 gap-3 border-t border-surface-800 px-3 py-3 sm:grid-cols-3">
                  {/* Tri-state thinking control */}
                  <div className="sm:col-span-3">
                    <div className="flex gap-1">
                      {([
                        { value: null, label: t('model.thinkingDefault') },
                        { value: true, label: t('model.thinkingOn') },
                        { value: false, label: t('model.thinkingOff') },
                      ] as const).map((opt) => {
                        const isActive = modelParameters.enable_thinking === opt.value;
                        return (
                          <button
                            key={opt.label}
                            type="button"
                            onClick={() => {
                              // When thinking is disabled or reset to default,
                              // drop effort/budget so they don't linger as
                              // contradictory params. Providers (e.g. Qwen3) treat
                              // a stray reasoning_effort as an implicit thinking-on
                              // signal that overrides enable_thinking=false.
                              const thinkingOff = opt.value !== true;
                              setModelParameters({
                                ...modelParameters,
                                enable_thinking: opt.value,
                                thinking_budget: thinkingOff ? null : modelParameters.thinking_budget,
                                reasoning_effort: thinkingOff ? null : modelParameters.reasoning_effort,
                              });
                            }}
                            className={[
                              'flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                              isActive
                                ? 'border-accent/50 bg-accent/10 text-accent'
                                : 'border-surface-700 bg-surface-800 text-ink-muted hover:border-surface-600 hover:text-ink',
                            ].join(' ')}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {modelParameters.enable_thinking === true && (
                    <>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                          {t('model.thinkingBudget')}
                        </label>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={modelParameters.thinking_budget ?? ''}
                          onChange={(e) =>
                            setModelParameters({
                              ...modelParameters,
                              thinking_budget: parseIntOrNull(e.target.value),
                            })
                          }
                          className="rounded-md border border-surface-700 bg-surface-950 px-2.5 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                          {t('model.reasoningEffort')}
                        </label>
                        <select
                          value={modelParameters.reasoning_effort ?? ''}
                          onChange={(e) =>
                            setModelParameters({
                              ...modelParameters,
                              reasoning_effort: e.target.value || null,
                            })
                          }
                          className="rounded-md border border-surface-700 bg-surface-950 px-2.5 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                        >
                          <option value="">—</option>
                          <option value="minimal">Minimal</option>
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                        </select>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatPricingChip(
  pricing: NonNullable<ReturnType<typeof useLabStore.getState>['activePricing']>,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const imagePricing = pricing.image_pricing ?? {};
  const imageMode = typeof imagePricing.mode === 'string' ? imagePricing.mode : 'token';
  const parts = [
    `${t('pricing.inputShort')} ${pricing.currency}${pricing.input_token_price}/1M`,
    `${t('pricing.outputShort')} ${pricing.currency}${pricing.output_token_price}/1M`,
  ];
  if (imageMode !== 'none') {
    const imagePrice =
      imageMode === 'per_request'
        ? Number(imagePricing.image_per_request_price ?? 0)
        : Number(imagePricing.image_token_price ?? 0);
    const imageUnit = imageMode === 'per_request' ? '/img' : '/1M';
    parts.push(`${t('pricing.imageShort')} ${pricing.currency}${imagePrice}${imageUnit}`);
  }
  parts.push(`${t('pricing.discountShort')} ${(pricing.batch_discount * 100).toFixed(0)}%`);
  return parts.join(' · ');
}

function formatImagePricing(
  imagePricing: Record<string, unknown>,
  currency: string,
): string {
  const mode = typeof imagePricing.mode === 'string' ? imagePricing.mode : 'token';
  if (mode === 'none') return '—';
  if (mode === 'per_request') {
    return `${currency}${Number(imagePricing.image_per_request_price ?? 0)}/img`;
  }
  return `${currency}${Number(imagePricing.image_token_price ?? 0)}/1M img tok`;
}

function PricingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-ink-muted">{label}</span>
      <span className="font-medium text-ink">{value}</span>
    </div>
  );
}

function formatCacheTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = parseFloat(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseIntOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-accent' : 'bg-surface-700',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
          checked ? 'translate-x-3.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  );
}

interface CostEstimateDisplay {
  amount: number;
  currency: string;
}

function resolveCostEstimate(
  lastResult: ReturnType<typeof useLabStore.getState>['lastResult'],
  lastRunItem: ReturnType<typeof useLabStore.getState>['lastRunItem'],
): CostEstimateDisplay | null {
  if (lastRunItem) {
    const cost = lastRunItem.cost;
    const estimated =
      typeof cost.estimated_cost === 'number'
        ? cost.estimated_cost
        : lastRunItem.estimated_cost;
    if (typeof estimated === 'number') {
      return {
        amount: estimated,
        currency: typeof cost.currency === 'string' ? cost.currency : 'USD',
      };
    }
  }

  if (lastResult?.summary?.total_cost_estimated) {
    return {
      amount: lastResult.summary.total_cost_estimated,
      currency: lastResult.summary.currency ?? 'USD',
    };
  }

  return null;
}
