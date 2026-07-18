import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, AlertCircle, Check, Server, RefreshCw, Loader2, Pencil, X, Download, Upload } from 'lucide-react';

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
  const [editingPricingId, setEditingPricingId] = useState<string | null>(null);
  const [pricingSaving, setPricingSaving] = useState(false);

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

  const resetPricingForm = useCallback(() => {
    setEditingPricingId(null);
    setPricingProviderConfigId('');
    setPricingModelId('');
    setPricingInput('0');
    setPricingOutput('0');
    setPricingCached('');
    setPricingImageMode('token');
    setPricingImagePrice('0');
    setPricingDiscount('1');
    setPricingCurrency('USD');
    setPricingNotes('');
  }, []);

  const startEditPricing = useCallback((row: PricingListItem) => {
    setEditingPricingId(row.pricing_profile_id);
    setPricingProviderConfigId(row.provider_config_id ?? '');
    setPricingModelId(row.model_id);
    setPricingInput(String(row.input_token_price ?? 0));
    setPricingOutput(String(row.output_token_price ?? 0));
    setPricingCached(row.cached_input_price == null ? '' : String(row.cached_input_price));
    const mode = typeof row.image_pricing?.mode === 'string' ? row.image_pricing.mode : 'token';
    setPricingImageMode(mode);
    if (mode === 'per_request') {
      setPricingImagePrice(String(Number(row.image_pricing?.image_per_request_price ?? 0)));
    } else if (mode === 'token') {
      setPricingImagePrice(String(Number(row.image_pricing?.image_token_price ?? 0)));
    } else {
      setPricingImagePrice('0');
    }
    setPricingDiscount(String(row.batch_discount ?? 1));
    setPricingCurrency(row.currency || 'USD');
    setPricingNotes(row.notes ?? '');
    setPricingError(null);
  }, []);

  const handleSavePricing = useCallback(async () => {
    if (!pricingProviderConfigId || !pricingModelId.trim()) return;
    const selected = providerConfigs.find((c) => c.provider_config_id === pricingProviderConfigId);
    const imagePrice = parseFloat(pricingImagePrice || '0') || 0;
    setPricingSaving(true);
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
      resetPricingForm();
      await loadPricing();
    } catch (err) {
      setPricingError(err instanceof Error ? err.message : 'Failed to save pricing');
    } finally {
      setPricingSaving(false);
    }
  }, [loadPricing, pricingCached, pricingCurrency, pricingDiscount, pricingImageMode, pricingImagePrice, pricingInput, pricingModelId, pricingNotes, pricingOutput, pricingProviderConfigId, providerConfigs, resetPricingForm]);

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
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
    <section className="flex-1 overflow-y-auto overscroll-y-contain">
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
                        config.adapter_id === 'vertex'
                          ? t('model.regionHint')
                          : providers.find((p) => p.adapter_id === config.adapter_id)?.requires_base_url
                            ? t('model.baseUrlRequired')
                            : t('model.baseUrlOptional')
                      }
                      value={editBaseUrl}
                      onChange={(e) => setEditBaseUrl(e.target.value)}
                      className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                    />
                    {config.adapter_id === 'vertex' ? (
                      <textarea
                        rows={4}
                        spellCheck={false}
                        placeholder={t('settings.vertexKeyHintEdit')}
                        value={editApiKey}
                        onChange={(e) => setEditApiKey(e.target.value)}
                        className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none sm:col-span-2"
                      />
                    ) : (
                      <input
                        type="password"
                        placeholder={config.api_key_set ? `${t('settings.apiKey')} (${t('settings.apiKeyKeep')})` : t('settings.apiKey')}
                        value={editApiKey}
                        onChange={(e) => setEditApiKey(e.target.value)}
                        className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                      />
                    )}
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
              newConfigAdapter === 'vertex'
                ? t('model.regionHint')
                : requiresBaseUrl ? t('model.baseUrlRequired') : t('model.baseUrlOptional')
            }
            value={newConfigBaseUrl}
            onChange={(e) => setNewConfigBaseUrl(e.target.value)}
            className={`rounded-md border bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:outline-none sm:col-span-2 ${
              requiresBaseUrl && !newConfigBaseUrl.trim()
                ? 'border-cost/50 focus:border-cost'
                : 'border-surface-700 focus:border-accent'
            }`}
          />
          {newConfigAdapter === 'vertex' ? (
            <textarea
              rows={4}
              spellCheck={false}
              placeholder={t('settings.vertexKeyHint')}
              value={newConfigApiKey}
              onChange={(e) => setNewConfigApiKey(e.target.value)}
              className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none sm:col-span-2"
            />
          ) : (
            <input
              type="password"
              placeholder={t('settings.apiKey')}
              value={newConfigApiKey}
              onChange={(e) => setNewConfigApiKey(e.target.value)}
              className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
          )}
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
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => startEditPricing(row)}
                            disabled={editingPricingId !== null}
                            className="rounded p-1.5 text-ink-dim transition-colors hover:bg-surface-800 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                            title={t('settings.edit')}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeletePricing(row.pricing_profile_id)}
                            disabled={editingPricingId !== null}
                            className="rounded p-1.5 text-ink-dim transition-colors hover:bg-surface-800 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                            title={t('settings.remove')}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
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
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">
            {editingPricingId ? t('pricing.edit') : t('pricing.add')}
          </h3>
          {editingPricingId && (
            <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent">
              {t('pricing.editing')}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <select
            value={pricingProviderConfigId}
            onChange={(e) => { setPricingProviderConfigId(e.target.value); setPricingModelId(''); }}
            disabled={editingPricingId !== null}
            className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="" disabled>{t('pricing.providerConfig')}</option>
            {providerConfigs.map((config) => <option key={config.provider_config_id} value={config.provider_config_id}>{config.name}</option>)}
          </select>
          <select
            value={pricingModelId}
            onChange={(e) => setPricingModelId(e.target.value)}
            disabled={editingPricingId !== null || !pricingProviderConfigId || pricingModelOptions.length === 0}
            className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="" disabled>{pricingModelOptions.length > 0 ? t('pricing.model') : t('model.noModels')}</option>
            {pricingModelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
            {editingPricingId && pricingModelId && !pricingModelOptions.includes(pricingModelId) && (
              <option value={pricingModelId}>{pricingModelId}</option>
            )}
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSavePricing}
            disabled={pricingSaving || !pricingProviderConfigId || !pricingModelId.trim()}
            className="btn-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pricingSaving ? <Loader2 size={16} className="animate-spin" /> : editingPricingId ? <Check size={16} /> : <Plus size={16} />}
            {editingPricingId ? t('pricing.update') : t('pricing.save')}
          </button>
          {editingPricingId && (
            <button
              type="button"
              onClick={resetPricingForm}
              disabled={pricingSaving}
              className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink disabled:opacity-40"
            >
              <X size={14} />
              {t('settings.cancelEdit')}
            </button>
          )}
        </div>
      </div>

      <MigrationSection />

    </div>
    </section>
    </div>
  );
}

function MigrationSection() {
  const { t } = useI18n();
  const [includeAssets, setIncludeAssets] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'skip' | 'overwrite' | 'duplicate'>('skip');
  const [dryRun, setDryRun] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [report, setReport] = useState<api.BundleImportReport | null>(null);

  async function handleExportWorkspace() {
    setExportLoading(true);
    setExportError(null);
    try {
      await api.exportBundle({ all: true, include_assets: includeAssets });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportLoading(false);
    }
  }

  async function handleImport() {
    if (!file) {
      setImportError(t('migration.noFile'));
      return;
    }
    setImportLoading(true);
    setImportError(null);
    setReport(null);
    try {
      const result = await api.importBundle(file, {
        mode,
        dryRun,
        includeAssets: true,
      });
      setReport(result);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportLoading(false);
    }
  }

  return (
    <>
      <div className="border-t border-surface-800 pt-6">
        <h2 className="text-lg font-semibold text-ink">{t('migration.title')}</h2>
        <p className="mt-1 text-sm text-ink-muted">{t('migration.exportDesc')}</p>
      </div>

      <div className="panel space-y-4 p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md border border-surface-700 bg-surface-950 p-2">
            <Download size={18} className="text-accent" />
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">{t('migration.exportWorkspace')}</h3>
              <p className="text-xs text-ink-muted">{t('migration.exportDesc')}</p>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={includeAssets}
                onChange={(e) => setIncludeAssets(e.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              {t('migration.includeAssets')}
            </label>
            <button
              type="button"
              onClick={() => void handleExportWorkspace()}
              disabled={exportLoading}
              className="btn-primary text-xs disabled:opacity-50"
            >
              {exportLoading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              {t('migration.exportWorkspace')}
            </button>
            {exportError && <p className="text-xs text-danger">{exportError}</p>}
          </div>
        </div>

        <div className="border-t border-surface-800" />

        <div className="flex items-start gap-3">
          <div className="rounded-md border border-surface-700 bg-surface-950 p-2">
            <Upload size={18} className="text-accent" />
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">{t('migration.importBundle')}</h3>
              <p className="text-xs text-ink-muted">{t('migration.importDesc')}</p>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-muted">{t('migration.selectFile')}</label>
              <input
                type="file"
                accept=".mikobundle,.zip"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setReport(null);
                }}
                className="block w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink file:mr-3 file:rounded-md file:border-0 file:bg-surface-800 file:px-3 file:py-1 file:text-xs file:text-ink hover:file:bg-surface-700"
              />
            </div>
            <div className="space-y-1">
              <span className="text-xs text-ink-muted">{t('migration.mode')}</span>
              <div className="flex flex-wrap gap-2">
                {(['skip', 'overwrite', 'duplicate'] as const).map((m) => (
                  <label
                    key={m}
                    className={`cursor-pointer inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs transition-colors ${
                      mode === m
                        ? 'border-accent bg-surface-800 text-ink'
                        : 'border-surface-700 text-ink-muted hover:bg-surface-800'
                    }`}
                  >
                    <input
                      type="radio"
                      name="bundleImportMode"
                      value={m}
                      checked={mode === m}
                      onChange={() => setMode(m)}
                      className="sr-only"
                    />
                    {t(`migration.mode${m.charAt(0).toUpperCase() + m.slice(1)}`)}
                  </label>
                ))}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              {t('migration.dryRun')}
            </label>
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={importLoading}
              className="btn-primary text-xs disabled:opacity-50"
            >
              {importLoading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Upload size={14} />
              )}
              {t('migration.import')}
            </button>
            {importError && (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {importError}
              </div>
            )}
            {report && !importError && (
              <div className="space-y-3 rounded-md border border-surface-700 bg-surface-950 p-3">
                <h4 className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                  <Check size={14} className="text-accent" />
                  {t('migration.importSuccess')}
                </h4>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    { key: 'created', value: report.created.length },
                    { key: 'updated', value: report.updated.length },
                    { key: 'skipped', value: report.skipped.length },
                    { key: 'duplicated', value: report.duplicated.length },
                  ].map(({ key, value }) => (
                    <div key={key} className="rounded-md border border-surface-800 bg-surface-900 p-2 text-center">
                      <div className="text-sm font-semibold text-ink">{value}</div>
                      <div className="text-[10px] text-ink-muted">{t(`migration.${key}`)}</div>
                    </div>
                  ))}
                </div>
                {report.renamed.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-xs font-medium text-ink-muted">{t('migration.renamed')}</span>
                    <ul className="space-y-1 text-xs text-ink-muted">
                      {report.renamed.map(([original, newName]) => (
                        <li key={`${original}-${newName}`} className="font-mono">
                          <span className="text-ink">{original}</span> → {newName}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.warnings.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-xs font-medium text-ink-muted">{t('migration.warnings')}</span>
                    <ul className="list-disc space-y-1 pl-4 text-xs text-ink-muted">
                      {report.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.redactions_needed.length > 0 && (
                  <div className="rounded-md border border-cost/40 bg-cost/10 p-3 text-xs text-cost">
                    <div className="mb-1 flex items-center gap-1.5 font-semibold">
                      <AlertCircle size={14} />
                      {t('migration.redactionsTitle')}
                    </div>
                    <p className="mb-2 text-cost/90">{t('migration.redactionsDesc')}</p>
                    <ul className="list-disc space-y-1 pl-4 font-mono text-cost/80">
                      {report.redactions_needed.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
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
