import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, AlertCircle, Check, Server, RefreshCw, Loader2, Pencil, X } from 'lucide-react';

import { useI18n } from '../i18n';
import * as api from '../api/client';
import type { PricingListItem, ProviderConfig } from '../api/client';

export function SettingsView() {
  const { t } = useI18n();

  // Provider configs
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfig[]>([]);
  const [providers, setProviders] = useState<api.ProviderMetadata[]>([]);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSavedFlash, setConfigSavedFlash] = useState(false);
  const [refreshingConfigId, setRefreshingConfigId] = useState<string | null>(null);
  const [configSelectedModels, setConfigSelectedModels] = useState<Record<string, string[]>>({});

  const [newConfigName, setNewConfigName] = useState('');
  const [newConfigAdapter, setNewConfigAdapter] = useState('');
  const [newConfigBaseUrl, setNewConfigBaseUrl] = useState('');
  const [newConfigApiKey, setNewConfigApiKey] = useState('');
  const [newConfigNotes, setNewConfigNotes] = useState('');

  // Inline edit state
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editApiKey, setEditApiKey] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Manual model-add state (per config)
  const [manualModelInput, setManualModelInput] = useState<Record<string, string>>({});
  const [manualModelSavingId, setManualModelSavingId] = useState<string | null>(null);

  // Pricing
  const [pricingRows, setPricingRows] = useState<PricingListItem[]>([]);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingProviderConfigId, setPricingProviderConfigId] = useState('');
  const [pricingModelId, setPricingModelId] = useState('');
  const [pricingInput, setPricingInput] = useState('0');
  const [pricingOutput, setPricingOutput] = useState('0');
  const [pricingCached, setPricingCached] = useState('');
  const [pricingImageMode, setPricingImageMode] = useState('token');
  const [pricingImagePrice, setPricingImagePrice] = useState('0');
  const [pricingDiscount, setPricingDiscount] = useState('1');
  const [pricingCurrency, setPricingCurrency] = useState('USD');
  const [pricingNotes, setPricingNotes] = useState('');

  useEffect(() => {
    loadProviderConfigs();
    loadPricing();
    api.listProviders().then((res) => setProviders(res.providers)).catch(() => {});
  }, []);

  const loadProviderConfigs = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const configs = await api.listProviderConfigs();
      setProviderConfigs(configs);
      setConfigSelectedModels(Object.fromEntries(
        configs.map((config) => [config.provider_config_id, config.selected_models ?? []]),
      ));
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : 'Failed to load provider configs');
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const selectedMeta = providers.find((p) => p.adapter_id === newConfigAdapter);
  const requiresBaseUrl = selectedMeta?.requires_base_url ?? false;
  const selectedPricingConfig = providerConfigs.find(
    (config) => config.provider_config_id === pricingProviderConfigId,
  );
  const pricingModelOptions = getExposedModels(selectedPricingConfig);

  const loadPricing = useCallback(async () => {
    setPricingLoading(true);
    setPricingError(null);
    try {
      setPricingRows(await api.listPricing());
    } catch (err) {
      setPricingError(err instanceof Error ? err.message : 'Failed to load pricing');
    } finally {
      setPricingLoading(false);
    }
  }, []);

  const handleSaveConfig = useCallback(async () => {
    const name = newConfigName.trim();
    const adapterId = newConfigAdapter.trim();
    if (!name || !adapterId) return;
    if (requiresBaseUrl && !newConfigBaseUrl.trim()) return;

    setConfigError(null);
    try {
      await api.saveProviderConfig({
        name,
        adapter_id: adapterId,
        base_url: newConfigBaseUrl.trim() || null,
        api_key: newConfigApiKey.trim() || null,
        selected_models: [],
        notes: newConfigNotes.trim(),
      });
      setNewConfigName('');
      setNewConfigAdapter('');
      setNewConfigBaseUrl('');
      setNewConfigApiKey('');
      setNewConfigNotes('');
      setConfigSavedFlash(true);
      setTimeout(() => setConfigSavedFlash(false), 2000);
      await loadProviderConfigs();
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : 'Failed to save provider config');
    }
  }, [
    newConfigName,
    newConfigAdapter,
    newConfigBaseUrl,
    newConfigApiKey,
    newConfigNotes,
    requiresBaseUrl,
    loadProviderConfigs,
  ]);

  const handleDeleteConfig = useCallback(
    async (configId: string) => {
      setConfigError(null);
      try {
        await api.deleteProviderConfig(configId);
        await loadProviderConfigs();
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : 'Failed to delete provider config');
      }
    },
    [loadProviderConfigs],
  );

  const handleRefreshModels = useCallback(
    async (configId: string) => {
      setConfigError(null);
      setRefreshingConfigId(configId);
      try {
        await api.fetchProviderModels({ provider_config_id: configId });
        await loadProviderConfigs();
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : 'Failed to fetch models');
      } finally {
        setRefreshingConfigId(null);
      }
    },
    [loadProviderConfigs],
  );

  const handleToggleSelectedModel = useCallback(
    async (config: ProviderConfig, modelId: string, checked: boolean) => {
      const current = configSelectedModels[config.provider_config_id] ?? config.selected_models ?? [];
      // When current selection is empty (meaning "all models" in Lab), materialize the full
      // cached_models list so that unchecking a model actually removes it instead of being a no-op.
      const effective = current.length > 0 ? current : config.cached_models;
      const next = checked
        ? Array.from(new Set([...effective, modelId]))
        : effective.filter((id) => id !== modelId);
      setConfigSelectedModels((prev) => ({ ...prev, [config.provider_config_id]: next }));
      setConfigError(null);
      try {
        await api.saveProviderConfig({
          provider_config_id: config.provider_config_id,
          name: config.name,
          adapter_id: config.adapter_id,
          base_url: config.base_url,
          api_key: null,
          selected_models: next,
          notes: config.notes,
        });
        await loadProviderConfigs();
      } catch (err) {
        setConfigSelectedModels((prev) => ({
          ...prev,
          [config.provider_config_id]: current,
        }));
        setConfigError(err instanceof Error ? err.message : 'Failed to save selected models');
      }
    },
    [configSelectedModels, loadProviderConfigs],
  );

  const handleSelectAll = useCallback(
    async (config: ProviderConfig) => {
      const allModels = config.cached_models;
      const prev = configSelectedModels[config.provider_config_id] ?? config.selected_models ?? [];
      setConfigSelectedModels((prevState) => ({ ...prevState, [config.provider_config_id]: allModels }));
      setConfigError(null);
      try {
        await api.saveProviderConfig({
          provider_config_id: config.provider_config_id,
          name: config.name,
          adapter_id: config.adapter_id,
          base_url: config.base_url,
          api_key: null,
          selected_models: allModels,
          notes: config.notes,
        });
        await loadProviderConfigs();
      } catch (err) {
        setConfigSelectedModels((prevState) => ({
          ...prevState,
          [config.provider_config_id]: prev,
        }));
        setConfigError(err instanceof Error ? err.message : 'Failed to save selected models');
      }
    },
    [configSelectedModels, loadProviderConfigs],
  );

  const handleInvertSelection = useCallback(
    async (config: ProviderConfig) => {
      const current = configSelectedModels[config.provider_config_id] ?? config.selected_models ?? [];
      const effective = current.length > 0 ? current : config.cached_models;
      const inverted = config.cached_models.filter((id) => !effective.includes(id));
      setConfigSelectedModels((prevState) => ({ ...prevState, [config.provider_config_id]: inverted }));
      setConfigError(null);
      try {
        await api.saveProviderConfig({
          provider_config_id: config.provider_config_id,
          name: config.name,
          adapter_id: config.adapter_id,
          base_url: config.base_url,
          api_key: null,
          selected_models: inverted,
          notes: config.notes,
        });
        await loadProviderConfigs();
      } catch (err) {
        setConfigSelectedModels((prevState) => ({
          ...prevState,
          [config.provider_config_id]: current,
        }));
        setConfigError(err instanceof Error ? err.message : 'Failed to save selected models');
      }
    },
    [configSelectedModels, loadProviderConfigs],
  );

  const startEdit = useCallback((config: ProviderConfig) => {
    setEditingConfigId(config.provider_config_id);
    setEditName(config.name);
    setEditBaseUrl(config.base_url ?? '');
    setEditApiKey('');
    setEditNotes(config.notes ?? '');
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingConfigId(null);
    setEditName('');
    setEditBaseUrl('');
    setEditApiKey('');
    setEditNotes('');
  }, []);

  const handleSaveEdit = useCallback(
    async (config: ProviderConfig) => {
      const name = editName.trim();
      if (!name) return;
      const meta = providers.find((p) => p.adapter_id === config.adapter_id);
      const requiresUrl = meta?.requires_base_url ?? false;
      if (requiresUrl && !editBaseUrl.trim()) return;

      setEditSaving(true);
      setConfigError(null);
      try {
        await api.saveProviderConfig({
          provider_config_id: config.provider_config_id,
          name,
          adapter_id: config.adapter_id,
          base_url: editBaseUrl.trim() || null,
          api_key: editApiKey.trim() || null,
          selected_models: config.selected_models ?? [],
          notes: editNotes.trim(),
        });
        cancelEdit();
        await loadProviderConfigs();
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : 'Failed to save provider config');
      } finally {
        setEditSaving(false);
      }
    },
    [editName, editBaseUrl, editApiKey, editNotes, providers, cancelEdit, loadProviderConfigs],
  );

  const handleAddModel = useCallback(
    async (config: ProviderConfig) => {
      const raw = (manualModelInput[config.provider_config_id] ?? '').trim();
      if (!raw) return;
      const merged = Array.from(new Set([...(config.cached_models ?? []), raw]));
      setManualModelSavingId(config.provider_config_id);
      setConfigError(null);
      try {
        await api.saveProviderConfig({
          provider_config_id: config.provider_config_id,
          name: config.name,
          adapter_id: config.adapter_id,
          base_url: config.base_url,
          api_key: null,
          selected_models: config.selected_models ?? [],
          notes: config.notes,
          cached_models: merged,
        });
        setManualModelInput((prev) => ({ ...prev, [config.provider_config_id]: '' }));
        await loadProviderConfigs();
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : 'Failed to add model');
      } finally {
        setManualModelSavingId(null);
      }
    },
    [manualModelInput, loadProviderConfigs],
  );

  const handleSavePricing = useCallback(async () => {
    if (!pricingProviderConfigId || !pricingModelId.trim()) return;
    const selected = providerConfigs.find((c) => c.provider_config_id === pricingProviderConfigId);
    const imagePrice = parseFloat(pricingImagePrice || '0') || 0;
    setPricingError(null);
    try {
      await api.savePricing({
        provider_config_id: pricingProviderConfigId,
        provider_id: selected?.name ?? pricingProviderConfigId,
        model_id: pricingModelId.trim(),
        currency: pricingCurrency.trim() || 'USD',
        input_token_price: parseFloat(pricingInput || '0') || 0,
        output_token_price: parseFloat(pricingOutput || '0') || 0,
        cached_input_price: pricingCached.trim() ? parseFloat(pricingCached) : null,
        batch_discount: parseFloat(pricingDiscount || '1') || 1,
        image_pricing: {
          mode: pricingImageMode,
          image_token_price: pricingImageMode === 'token' ? imagePrice : null,
          image_per_request_price: pricingImageMode === 'per_request' ? imagePrice : null,
        },
        notes: pricingNotes.trim(),
      });
      setPricingModelId('');
      setPricingInput('0');
      setPricingOutput('0');
      setPricingCached('');
      setPricingImagePrice('0');
      setPricingDiscount('1');
      setPricingNotes('');
      await loadPricing();
    } catch (err) {
      setPricingError(err instanceof Error ? err.message : 'Failed to save pricing');
    }
  }, [loadPricing, pricingCached, pricingCurrency, pricingDiscount, pricingImageMode, pricingImagePrice, pricingInput, pricingModelId, pricingNotes, pricingOutput, pricingProviderConfigId, providerConfigs]);

  const handleDeletePricing = useCallback(async (pricingProfileId: string) => {
    setPricingError(null);
    try {
      await api.deletePricing(pricingProfileId);
      await loadPricing();
    } catch (err) {
      setPricingError(err instanceof Error ? err.message : 'Failed to delete pricing');
    }
  }, [loadPricing]);

  return (
    <section className="flex-1 overflow-y-auto bg-surface-950">
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {/* Provider configs section */}
      <div>
        <h2 className="text-lg font-semibold text-ink">{t('settings.providerConfigs')}</h2>
        <p className="mt-1 text-sm text-ink-muted">
          {t('settings.noProviderConfigs')}
        </p>
      </div>

      {configError && (
        <div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertCircle size={16} />
          <span>{configError}</span>
          <button
            onClick={() => setConfigError(null)}
            className="ml-auto text-danger/70 hover:text-danger"
          >
            ✕
          </button>
        </div>
      )}

      <div className="panel divide-y divide-surface-800">
        {configLoading && providerConfigs.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-ink-dim">{t('settings.loading')}</div>
        ) : providerConfigs.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-ink-dim">
            {t('settings.noProviderConfigs')}
          </div>
        ) : (
          providerConfigs.map((config) => (
            <div key={config.provider_config_id} className="px-4 py-3">
              <div className="flex items-center gap-3">
              <Server size={16} className="text-accent" />
              <div className="flex flex-1 flex-col gap-2">
                <span className="text-sm font-medium text-ink">{config.name}</span>
                <span className="text-xs text-ink-dim">
                  {config.adapter_id}
                  {config.base_url ? ` · ${config.base_url}` : ' · default'}
                </span>
                <span className="text-xs text-ink-dim">
                  {config.cached_models.length > 0
                    ? t('settings.modelCacheStatus', { count: config.cached_models.length })
                    : t('settings.modelCacheEmpty')}
                  {config.models_cached_at
                    ? ` · ${t('settings.modelCacheAt', { time: formatCacheTime(config.models_cached_at) })}`
                    : ''}
                </span>
                {config.cached_models.length > 0 && (
                  <div className="rounded-md border border-surface-800 bg-surface-900/60 p-2">
                    <div className="mb-2 flex items-center justify-between gap-2 text-xs text-ink-muted">
                      <span>{t('settings.selectedModels')}</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleSelectAll(config)}
                          className="text-accent hover:text-accent-hover"
                        >
                          {t('settings.selectAll')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleInvertSelection(config)}
                          className="text-accent hover:text-accent-hover"
                        >
                          {t('settings.invertSelection')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void api.saveProviderConfig({
                            provider_config_id: config.provider_config_id,
                            name: config.name,
                            adapter_id: config.adapter_id,
                            base_url: config.base_url,
                            api_key: null,
                            selected_models: [],
                            notes: config.notes,
                          }).then(loadProviderConfigs).catch((err: unknown) => {
                            setConfigError(err instanceof Error ? err.message : 'Failed to save selected models');
                          })}
                          className="text-accent hover:text-accent-hover"
                        >
                          {t('settings.allModels')}
                        </button>
                      </div>
                    </div>
                    <div className="grid max-h-36 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                      {config.cached_models.map((model) => {
                        const selectedModels = getSelectedModelIdsForEditing(
                          config,
                          configSelectedModels[config.provider_config_id],
                        );
                        return (
                          <label key={model} className="flex items-center gap-2 rounded px-2 py-1 text-xs text-ink-muted hover:bg-surface-800">
                            <input
                              type="checkbox"
                              checked={selectedModels.includes(model)}
                              onChange={(e) => void handleToggleSelectedModel(config, model, e.target.checked)}
                              className="h-3.5 w-3.5 accent-accent"
                            />
                            <span className="truncate font-mono" title={model}>{model}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* Manual model addition */}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder={t('settings.addModelPlaceholder')}
                    value={manualModelInput[config.provider_config_id] ?? ''}
                    onChange={(e) => setManualModelInput((prev) => ({ ...prev, [config.provider_config_id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleAddModel(config); }}
                    className="flex-1 rounded-md border border-surface-700 bg-surface-800 px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleAddModel(config)}
                    disabled={manualModelSavingId === config.provider_config_id || !(manualModelInput[config.provider_config_id] ?? '').trim()}
                    className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2.5 py-1.5 text-xs text-ink-muted transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {manualModelSavingId === config.provider_config_id ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    {t('settings.addModelBtn')}
                  </button>
                </div>
              </div>
              <button
                onClick={() => startEdit(config)}
                className="rounded p-1.5 text-ink-dim transition-colors hover:bg-surface-800 hover:text-accent"
                title={t('settings.edit')}
              >
                <Pencil size={15} />
              </button>
              <button
                onClick={() => void handleRefreshModels(config.provider_config_id)}
                disabled={refreshingConfigId === config.provider_config_id}
                className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-ink-dim transition-colors hover:bg-surface-800 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                title={t('settings.syncModels')}
              >
                {refreshingConfigId === config.provider_config_id ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <RefreshCw size={14} />
                )}
                {t('settings.syncModels')}
              </button>
              <button
                onClick={() => handleDeleteConfig(config.provider_config_id)}
                className="rounded p-1.5 text-ink-dim transition-colors hover:bg-surface-800 hover:text-danger"
                title={t('settings.remove')}
              >
                <Trash2 size={15} />
              </button>
              </div>
              {editingConfigId === config.provider_config_id && (
                <div className="mt-3 space-y-3 rounded-md border border-accent/30 bg-surface-900/40 p-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                    {t('settings.editProviderConfig')}
                  </h4>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <input
                      type="text"
                      placeholder={t('settings.configName')}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                    />
                    <input
                      type="text"
                      placeholder={
                        providers.find((p) => p.adapter_id === config.adapter_id)?.requires_base_url
                          ? t('model.baseUrlRequired')
                          : t('model.baseUrlOptional')
                      }
                      value={editBaseUrl}
                      onChange={(e) => setEditBaseUrl(e.target.value)}
                      className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                    />
                    <input
                      type="password"
                      placeholder={config.api_key_set ? `${t('settings.apiKey')} (${t('settings.apiKeyKeep')})` : t('settings.apiKey')}
                      value={editApiKey}
                      onChange={(e) => setEditApiKey(e.target.value)}
                      className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                    />
                    <input
                      type="text"
                      placeholder={t('settings.notes') ?? 'Notes'}
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSaveEdit(config)}
                      disabled={editSaving || !editName.trim()}
                      className="btn-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {editSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                      {t('settings.save')}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={editSaving}
                      className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink disabled:opacity-40"
                    >
                      <X size={14} />
                      {t('settings.cancelEdit')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="panel space-y-3 p-4">
        <h3 className="text-sm font-semibold text-ink">{t('settings.addProviderConfig')}</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            type="text"
            placeholder={t('settings.configName')}
            value={newConfigName}
            onChange={(e) => setNewConfigName(e.target.value)}
            className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
          <select
            value={newConfigAdapter}
            onChange={(e) => setNewConfigAdapter(e.target.value)}
            className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          >
            <option value="" disabled>
              {t('settings.configType')}
            </option>
            {providers.map((p) => (
              <option key={p.adapter_id} value={p.adapter_id}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder={
              requiresBaseUrl ? t('model.baseUrlRequired') : t('model.baseUrlOptional')
            }
            value={newConfigBaseUrl}
            onChange={(e) => setNewConfigBaseUrl(e.target.value)}
            className={`rounded-md border bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:outline-none sm:col-span-2 ${
              requiresBaseUrl && !newConfigBaseUrl.trim()
                ? 'border-cost/50 focus:border-cost'
                : 'border-surface-700 focus:border-accent'
            }`}
          />
          <input
            type="password"
            placeholder={t('settings.apiKey')}
            value={newConfigApiKey}
            onChange={(e) => setNewConfigApiKey(e.target.value)}
            className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
          <input
            type="text"
            placeholder={t('settings.notes') ?? 'Notes'}
            value={newConfigNotes}
            onChange={(e) => setNewConfigNotes(e.target.value)}
            className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>
        <button
          onClick={handleSaveConfig}
          disabled={
            !newConfigName.trim() ||
            !newConfigAdapter.trim() ||
            (requiresBaseUrl && !newConfigBaseUrl.trim())
          }
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus size={16} />
          {configSavedFlash ? (
            <span className="flex items-center gap-1">
              <Check size={14} /> {t('settings.saved')}
            </span>
          ) : (
            t('settings.save')
          )}
        </button>
      </div>

      {/* Pricing section */}
      <div className="border-t border-surface-800 pt-6">
        <h2 className="text-lg font-semibold text-ink">{t('pricing.title')}</h2>
        <p className="mt-1 text-sm text-ink-muted">{t('settings.pricingDescription')}</p>
      </div>

      {pricingError && (
        <div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertCircle size={16} />
          <span>{pricingError}</span>
          <button onClick={() => setPricingError(null)} className="ml-auto text-danger/70 hover:text-danger">✕</button>
        </div>
      )}

      <div className="panel overflow-hidden">
        {pricingLoading && pricingRows.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-ink-dim">{t('settings.loading')}</div>
        ) : pricingRows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-ink-dim">{t('pricing.empty')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-900 text-ink-muted">
                <tr>
                  <th className="px-3 py-2">{t('pricing.providerConfig')}</th>
                  <th className="px-3 py-2">{t('pricing.model')}</th>
                  <th className="px-3 py-2">{t('pricing.input')}</th>
                  <th className="px-3 py-2">{t('pricing.output')}</th>
                  <th className="px-3 py-2">{t('pricing.image')}</th>
                  <th className="px-3 py-2">{t('pricing.discount')}</th>
                  <th className="px-3 py-2">{t('pricing.currency')}</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {pricingRows.map((row) => {
                  const config = providerConfigs.find((c) => c.provider_config_id === row.provider_config_id);
                  return (
                    <tr key={row.pricing_profile_id}>
                      <td className="px-3 py-2 text-ink">{config?.name ?? row.provider_config_id ?? row.provider_id}</td>
                      <td className="px-3 py-2 font-mono text-ink-muted">{row.model_id}</td>
                      <td className="px-3 py-2 text-ink-muted">{row.input_token_price}/1M</td>
                      <td className="px-3 py-2 text-ink-muted">{row.output_token_price}/1M</td>
                      <td className="px-3 py-2 text-ink-muted">{formatImagePricing(row.image_pricing)}</td>
                      <td className="px-3 py-2 text-ink-muted">{Math.round(row.batch_discount * 100)}%</td>
                      <td className="px-3 py-2 text-ink-muted">{row.currency}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => void handleDeletePricing(row.pricing_profile_id)} className="rounded p-1.5 text-ink-dim transition-colors hover:bg-surface-800 hover:text-danger" title={t('settings.remove')}>
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel space-y-3 p-4">
        <h3 className="text-sm font-semibold text-ink">{t('pricing.add')}</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <select value={pricingProviderConfigId} onChange={(e) => { setPricingProviderConfigId(e.target.value); setPricingModelId(''); }} className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none">
            <option value="" disabled>{t('pricing.providerConfig')}</option>
            {providerConfigs.map((config) => <option key={config.provider_config_id} value={config.provider_config_id}>{config.name}</option>)}
          </select>
          <select value={pricingModelId} onChange={(e) => setPricingModelId(e.target.value)} disabled={!pricingProviderConfigId || pricingModelOptions.length === 0} className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-40">
            <option value="" disabled>{pricingModelOptions.length > 0 ? t('pricing.model') : t('model.noModels')}</option>
            {pricingModelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          <input value={pricingCurrency} onChange={(e) => setPricingCurrency(e.target.value)} placeholder={t('pricing.currency')} className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none" />
          <input type="number" step="0.01" value={pricingInput} onChange={(e) => setPricingInput(e.target.value)} placeholder={t('pricing.input')} className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none" />
          <input type="number" step="0.01" value={pricingOutput} onChange={(e) => setPricingOutput(e.target.value)} placeholder={t('pricing.output')} className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none" />
          <input type="number" step="0.01" value={pricingCached} onChange={(e) => setPricingCached(e.target.value)} placeholder={t('pricing.cached')} className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none" />
          <select value={pricingImageMode} onChange={(e) => setPricingImageMode(e.target.value)} className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none">
            <option value="token">{t('pricing.imageToken')}</option>
            <option value="per_request">{t('pricing.imageRequest')}</option>
            <option value="none">{t('pricing.imageNone')}</option>
          </select>
          <input type="number" step="0.01" value={pricingImagePrice} onChange={(e) => setPricingImagePrice(e.target.value)} placeholder={t('pricing.imagePrice')} className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none" />
          <input type="number" step="0.01" value={pricingDiscount} onChange={(e) => setPricingDiscount(e.target.value)} placeholder={t('pricing.discount')} className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none" />
          <input value={pricingNotes} onChange={(e) => setPricingNotes(e.target.value)} placeholder={t('settings.notes')} className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none sm:col-span-3" />
        </div>
        <button onClick={handleSavePricing} disabled={!pricingProviderConfigId || !pricingModelId.trim()} className="btn-primary disabled:cursor-not-allowed disabled:opacity-40">
          <Plus size={16} /> {t('pricing.save')}
        </button>
      </div>

    </div>
    </section>
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

function getExposedModels(config: ProviderConfig | undefined): string[] {
  if (!config) return [];
  return config.selected_models.length > 0 ? config.selected_models : config.cached_models;
}

function getSelectedModelIdsForEditing(
  config: ProviderConfig,
  draftSelected: string[] | undefined,
): string[] {
  const selected = draftSelected ?? config.selected_models ?? [];
  return selected.length > 0 ? selected : config.cached_models;
}

function formatImagePricing(imagePricing: Record<string, unknown>): string {
  const mode = typeof imagePricing.mode === 'string' ? imagePricing.mode : 'token';
  if (mode === 'none') return 'none';
  if (mode === 'per_request') {
    return `${Number(imagePricing.image_per_request_price ?? 0)}/img`;
  }
  return `${Number(imagePricing.image_token_price ?? 0)}/1M`;
}
