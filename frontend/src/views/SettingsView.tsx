import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, Trash2, AlertCircle, Check, Server } from 'lucide-react';

import { useSettingsStore } from '../store/settingsStore';
import { useI18n } from '../i18n';
import * as api from '../api/client';
import type { ProviderConfig } from '../api/client';

export function SettingsView() {
  const { t } = useI18n();
  const {
    apiKeyProviders,
    isLoading,
    error,
    loadAll,
    setApiKey,
    removeApiKey,
    clearError,
  } = useSettingsStore();

  const [newProvider, setNewProvider] = useState('');
  const [newKey, setNewKey] = useState('');
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  // Provider configs
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfig[]>([]);
  const [providers, setProviders] = useState<api.ProviderMetadata[]>([]);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSavedFlash, setConfigSavedFlash] = useState(false);

  const [newConfigName, setNewConfigName] = useState('');
  const [newConfigAdapter, setNewConfigAdapter] = useState('');
  const [newConfigBaseUrl, setNewConfigBaseUrl] = useState('');
  const [newConfigApiKey, setNewConfigApiKey] = useState('');
  const [newConfigNotes, setNewConfigNotes] = useState('');

  useEffect(() => {
    loadAll();
    loadProviderConfigs();
    api.listProviders().then((res) => setProviders(res.providers)).catch(() => {});
  }, [loadAll]);

  const loadProviderConfigs = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const configs = await api.listProviderConfigs();
      setProviderConfigs(configs);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : 'Failed to load provider configs');
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const selectedMeta = providers.find((p) => p.adapter_id === newConfigAdapter);
  const requiresBaseUrl = selectedMeta?.requires_base_url ?? false;

  const handleSave = useCallback(async () => {
    if (!newProvider.trim() || !newKey.trim()) return;
    await setApiKey(newProvider.trim(), newKey.trim());
    setNewProvider('');
    setNewKey('');
    setSavedFlash(newProvider.trim());
    setTimeout(() => setSavedFlash(null), 2000);
  }, [newProvider, newKey, setApiKey]);

  const handleRemove = useCallback(
    async (provider: string) => {
      await removeApiKey(provider);
    },
    [removeApiKey],
  );

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

  return (
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
            <div key={config.provider_config_id} className="flex items-center gap-3 px-4 py-3">
              <Server size={16} className="text-accent" />
              <div className="flex flex-1 flex-col">
                <span className="text-sm font-medium text-ink">{config.name}</span>
                <span className="text-xs text-ink-dim">
                  {config.adapter_id}
                  {config.base_url ? ` · ${config.base_url}` : ' · default'}
                </span>
              </div>
              <button
                onClick={() => handleDeleteConfig(config.provider_config_id)}
                className="rounded p-1.5 text-ink-dim transition-colors hover:bg-surface-800 hover:text-danger"
                title={t('settings.remove')}
              >
                <Trash2 size={15} />
              </button>
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

      {/* API keys section */}
      <div className="border-t border-surface-800 pt-6">
        <div>
          <h2 className="text-lg font-semibold text-ink">{t('settings.title')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('settings.description')}</p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertCircle size={16} />
          <span>{error}</span>
          <button
            onClick={clearError}
            className="ml-auto text-danger/70 hover:text-danger"
          >
            ✕
          </button>
        </div>
      )}

      <div className="panel divide-y divide-surface-800">
        {isLoading && apiKeyProviders.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-ink-dim">{t('settings.loading')}</div>
        ) : apiKeyProviders.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-ink-dim">
            {t('settings.noKeys')}
          </div>
        ) : (
          apiKeyProviders.map((provider) => (
            <div key={provider} className="flex items-center gap-3 px-4 py-3">
              <KeyRound size={16} className="text-accent" />
              <span className="flex-1 font-mono text-sm text-ink">{provider}</span>
              {savedFlash === provider && (
                <span className="flex items-center gap-1 text-xs text-accent">
                  <Check size={14} /> {t('settings.saved')}
                </span>
              )}
              <button
                onClick={() => handleRemove(provider)}
                className="rounded p-1.5 text-ink-dim transition-colors hover:bg-surface-800 hover:text-danger"
                title={t('settings.remove')}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="panel space-y-3 p-4">
        <h3 className="text-sm font-semibold text-ink">{t('settings.addKey')}</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[200px_1fr]">
          <input
            type="text"
            placeholder={t('settings.provider')}
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value)}
            className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
          <input
            type="password"
            placeholder={t('settings.apiKey')}
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>
        <button
          onClick={handleSave}
          disabled={!newProvider.trim() || !newKey.trim()}
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus size={16} />
          {t('settings.save')}
        </button>
      </div>

      <div className="rounded-md border border-surface-800 bg-surface-900/50 p-4 text-xs text-ink-dim">
        <p className="mt-1">{t('settings.providerHint')}</p>
      </div>
    </div>
  );
}
