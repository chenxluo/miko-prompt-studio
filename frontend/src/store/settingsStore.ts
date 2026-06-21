import { create } from 'zustand';

import * as api from '../api/client';
import type {
  CreateModelConfigPayload,
  CreatePricingPayload,
  SavePromptPayload,
} from '../api/payloads';

interface SettingsState {
  apiKeyProviders: string[];
  modelConfigs: api.ModelConfigListItem[];
  pricingProfiles: api.PricingListItem[];
  prompts: api.PromptListItem[];
  isLoading: boolean;
  error: string | null;
}

interface SettingsActions {
  loadAll: () => Promise<void>;
  setApiKey: (provider: string, key: string) => Promise<void>;
  removeApiKey: (provider: string) => Promise<void>;
  saveModelConfig: (
    payload: CreateModelConfigPayload,
  ) => Promise<void>;
  savePricing: (payload: CreatePricingPayload) => Promise<void>;
  savePrompt: (payload: SavePromptPayload) => Promise<void>;
  clearError: () => void;
}

export const useSettingsStore = create<SettingsState & SettingsActions>((set) => ({
  apiKeyProviders: [],
  modelConfigs: [],
  pricingProfiles: [],
  prompts: [],
  isLoading: false,
  error: null,

  loadAll: async () => {
    set({ isLoading: true, error: null });
    try {
      const [keys, configs, profiles, prompts] = await Promise.all([
        api.listApiKeys(),
        api.listModelConfigs(),
        api.listPricing(),
        api.listPrompts(),
      ]);
      set({
        apiKeyProviders: keys.providers,
        modelConfigs: configs,
        pricingProfiles: profiles,
        prompts: prompts,
        isLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load settings';
      set({ isLoading: false, error: message });
    }
  },

  setApiKey: async (provider, key) => {
    try {
      await api.setApiKey(provider, key);
      const { providers } = await api.listApiKeys();
      set({ apiKeyProviders: providers });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to save API key' });
    }
  },

  removeApiKey: async (provider) => {
    try {
      await api.removeApiKey(provider);
      const { providers } = await api.listApiKeys();
      set({ apiKeyProviders: providers });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to remove API key' });
    }
  },

  saveModelConfig: async (payload) => {
    try {
      await api.saveModelConfig(payload);
      const configs = await api.listModelConfigs();
      set({ modelConfigs: configs });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to save model config' });
    }
  },

  savePricing: async (payload) => {
    try {
      await api.savePricing(payload);
      const profiles = await api.listPricing();
      set({ pricingProfiles: profiles });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to save pricing' });
    }
  },

  savePrompt: async (payload) => {
    try {
      await api.savePrompt(payload);
      const prompts = await api.listPrompts();
      set({ prompts });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to save prompt' });
    }
  },

  clearError: () => set({ error: null }),
}));
