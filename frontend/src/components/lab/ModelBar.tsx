import {
  Brain,
  ChevronDown,
  ChevronUp,
  Cpu,
  Loader2,
  Play,
  RefreshCw,
  AlertCircle,
  Settings,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { useLabStore } from '../../store/labStore';
import { useI18n } from '../../i18n';

export function ModelBar() {
  const { t } = useI18n();
  const providerConfigs = useLabStore((s) => s.providerConfigs);
  const selectedProviderConfigId = useLabStore((s) => s.selectedProviderConfigId);
  const modelId = useLabStore((s) => s.modelId);
  const modelParameters = useLabStore((s) => s.modelParameters);
  const images = useLabStore((s) => s.images);
  const isRunning = useLabStore((s) => s.isRunning);
  const availableModels = useLabStore((s) => s.availableModels);
  const isFetchingModels = useLabStore((s) => s.isFetchingModels);
  const lastResult = useLabStore((s) => s.lastResult);
  const lastRunItem = useLabStore((s) => s.lastRunItem);

  const setSelectedProviderConfigId = useLabStore((s) => s.setSelectedProviderConfigId);
  const setModelId = useLabStore((s) => s.setModelId);
  const setModelParameters = useLabStore((s) => s.setModelParameters);
  const run = useLabStore((s) => s.run);
  const fetchModels = useLabStore((s) => s.fetchModels);
  const loadProviderConfigs = useLabStore((s) => s.loadProviderConfigs);

  const [fetchError, setFetchError] = useState<string | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);

  useEffect(() => {
    void loadProviderConfigs();
  }, [loadProviderConfigs]);

  const selectedConfig = providerConfigs.find(
    (c) => c.provider_config_id === selectedProviderConfigId,
  );

  const costEstimate = resolveCostEstimate(lastResult, lastRunItem);
  const canRun =
    !isRunning && images.length > 0 && !!selectedProviderConfigId && !!modelId.trim();

  const handleFetchModels = async () => {
    setFetchError(null);
    await fetchModels();
    if (useLabStore.getState().error) {
      setFetchError(useLabStore.getState().error!);
    }
  };

  const navigateToSettings = () => {
    window.dispatchEvent(new CustomEvent('miko:navigate', { detail: 'settings' }));
  };

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Provider config */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted">
            {t('model.providerConfig')}
          </label>
          {providerConfigs.length === 0 ? (
            <div className="flex flex-col gap-2 rounded-md border border-surface-700 bg-surface-800/50 px-3 py-2">
              <span className="text-xs text-ink-dim">{t('settings.noProviderConfigs')}</span>
              <button
                type="button"
                onClick={navigateToSettings}
                className="flex items-center gap-1 text-xs text-accent hover:underline"
              >
                <Settings size={12} />
                {t('model.manageInSettings')}
              </button>
            </div>
          ) : (
            <select
              value={selectedProviderConfigId ?? ''}
              onChange={(e) => setSelectedProviderConfigId(e.target.value || null)}
              className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
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

        {/* Model ID — combo input + datalist */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted">
            {t('model.modelId')}
          </label>
          <div className="flex gap-1.5">
            <input
              type="text"
              list="model-list"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="gpt-4o-mini"
              disabled={!selectedProviderConfigId}
              className="flex-1 rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleFetchModels}
              disabled={isFetchingModels || !selectedProviderConfigId}
              title={t('model.fetchModels')}
              className="flex shrink-0 items-center justify-center rounded-md border border-surface-700 bg-surface-800 px-2.5 text-ink-muted transition-colors hover:border-surface-600 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isFetchingModels ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
            </button>
            <datalist id="model-list">
              {availableModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          {availableModels.length > 0 && (
            <span className="text-[10px] text-ink-dim">
              {t('model.modelsLoaded', { count: availableModels.length })}
            </span>
          )}
          {fetchError && (
            <span className="flex items-center gap-1 text-[10px] text-danger">
              <AlertCircle size={10} />
              {t('model.fetchFailed')}
            </span>
          )}
          {!selectedConfig?.api_key_set && selectedConfig && (
            <span className="text-[10px] text-cost">
              ⚠ {t('settings.noKeys')}
            </span>
          )}
        </div>

        {/* Temperature */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted">
            {t('model.temperature')}
          </label>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={modelParameters.temperature ?? 0}
            onChange={(e) =>
              setModelParameters({
                ...modelParameters,
                temperature: parseNumber(e.target.value),
              })
            }
            className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
          />
        </div>

        {/* Max tokens */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted">
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
            className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {/* Thinking parameters */}
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
          <div className="grid grid-cols-1 gap-4 border-t border-surface-800 px-3 py-3 sm:grid-cols-3">
            <div className="flex items-center gap-2">
              <input
                id="enable-thinking"
                type="checkbox"
                checked={modelParameters.enable_thinking ?? false}
                onChange={(e) =>
                  setModelParameters({
                    ...modelParameters,
                    enable_thinking: e.target.checked,
                  })
                }
                className="h-4 w-4 rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
              />
              <label htmlFor="enable-thinking" className="text-xs text-ink-muted">
                {t('model.enableThinking')}
              </label>
            </div>

            {modelParameters.enable_thinking && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-ink-muted">
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
                    className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-ink-muted">
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
                    className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                  >
                    <option value="">—</option>
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

      <div className="flex items-center justify-end gap-3">
        {costEstimate && (
          <div className="flex items-center gap-2 rounded-md bg-surface-800 px-3 py-2 text-xs">
            <Cpu size={14} className="text-cost" />
            <span className="text-ink-muted">{t('lab.cost')}:</span>
            <span className="font-medium text-cost">
              {costEstimate.currency} {costEstimate.amount.toFixed(6)}
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={() => void run()}
          disabled={!canRun}
          className="btn-primary min-w-[7rem] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isRunning ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {t('lab.running')}
            </>
          ) : (
            <>
              <Play size={16} />
              {t('lab.run')}
            </>
          )}
        </button>
      </div>
    </div>
  );
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
