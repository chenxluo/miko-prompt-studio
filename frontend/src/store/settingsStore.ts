import { create } from 'zustand';

import * as api from '../api/client';
import type {
  CreateModelConfigPayload,
  CreatePricingPayload,
  SavePromptPayload,
} from '../api/payloads';

interface SettingsState {
  modelConfigs: api.ModelConfigListItem[];
  pricingProfiles: api.PricingListItem[];
  prompts: api.PromptListItem[];
  isLoading: boolean;
  error: string | null;
}

interface SettingsActions {
  saveModelConfig: (
    payload: CreateModelConfigPayload,
  ) => Promise<void>;
  savePricing: (payload: CreatePricingPayload) => Promise<void>;
  savePrompt: (payload: SavePromptPayload) => Promise<void>;
}

export const useSettingsStore = create<SettingsState & SettingsActions>((set) => ({
  modelConfigs: [],
  pricingProfiles: [],
  prompts: [],
  isLoading: false,
  error: null,

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
}));
