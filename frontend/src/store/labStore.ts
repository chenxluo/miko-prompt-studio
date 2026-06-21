import { create } from 'zustand';

import * as api from '../api/client';
import type {
  ImageRef,
  ModelParameters,
  OutputContract,
  RunSession,
  SampleRecord,
} from '../types';

export const DEFAULT_OUTPUT_CONTRACT: OutputContract = {
  mode: 'free_text',
  format_instruction: null,
  json_schema: null,
  parser: null,
};

export const DEFAULT_MODEL_PARAMETERS: ModelParameters = {
  temperature: 0.2,
  max_output_tokens: 2048,
  top_p: null,
  seed: null,
  stop: null,
  enable_thinking: null,
  thinking_budget: null,
  reasoning_effort: null,
};

interface LabState {
  // Prompt
  systemPrompt: string;
  userPrompt: string;
  formatInstruction: string;

  // Images
  images: ImageRef[];

  // Provider config
  providerConfigs: api.ProviderConfig[];
  selectedProviderConfigId: string | null;

  // Model
  modelId: string;
  availableModels: string[];
  modelParameters: ModelParameters;
  isFetchingModels: boolean;

  // Output
  outputContract: OutputContract;

  // Run state
  isRunning: boolean;
  lastResult: RunSession | null;
  lastRunItem: api.RunItemSummary | null;
  runHistory: RunSession[];
  error: string | null;
}

interface LabActions {
  setSystemPrompt: (value: string) => void;
  setUserPrompt: (value: string) => void;
  setFormatInstruction: (value: string) => void;
  addImage: (image: ImageRef) => void;
  removeImage: (index: number) => void;
  setSelectedProviderConfigId: (id: string | null) => void;
  setModelId: (value: string) => void;
  setModelParameters: (parameters: ModelParameters) => void;
  setOutputContract: (contract: OutputContract) => void;
  setOutputMode: (mode: OutputContract['mode']) => void;
  loadProviderConfigs: () => Promise<void>;
  fetchModels: () => Promise<void>;
  run: () => Promise<RunSession | null>;
  loadRunDetail: (runId: string) => Promise<void>;
  clearResults: () => void;
  clearError: () => void;
}

export const useLabStore = create<LabState & LabActions>((set, get) => ({
  systemPrompt: '你是图像标注助手。请根据图片内容生成准确、详细的标注。',
  userPrompt: '请为这张图片生成标注。',
  formatInstruction: '',
  images: [],
  providerConfigs: [],
  selectedProviderConfigId: null,
  modelId: 'gpt-4o-mini',
  availableModels: [],
  modelParameters: DEFAULT_MODEL_PARAMETERS,
  isFetchingModels: false,
  outputContract: DEFAULT_OUTPUT_CONTRACT,
  isRunning: false,
  lastResult: null,
  lastRunItem: null,
  runHistory: [],
  error: null,

  setSystemPrompt: (value) => set({ systemPrompt: value }),
  setUserPrompt: (value) => set({ userPrompt: value }),
  setFormatInstruction: (value) => set({ formatInstruction: value }),

  addImage: (image) =>
    set((state) => ({
      images: [...state.images, { ...image, order: state.images.length }],
    })),

  removeImage: (index) =>
    set((state) => ({
      images: state.images
        .filter((_, i) => i !== index)
        .map((img, i) => ({ ...img, order: i })),
    })),

  setSelectedProviderConfigId: (id) =>
    set({
      selectedProviderConfigId: id,
      availableModels: [],
    }),
  setModelId: (value) => set({ modelId: value }),
  setModelParameters: (parameters) => set({ modelParameters: parameters }),
  setOutputContract: (contract) => set({ outputContract: contract }),

  setOutputMode: (mode) =>
    set((state) => ({
      outputContract: { ...state.outputContract, mode: mode ?? 'free_text' },
    })),

  loadProviderConfigs: async () => {
    set({ error: null });
    try {
      const configs = await api.listProviderConfigs();
      set({ providerConfigs: configs });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load provider configs';
      set({ error: message });
    }
  },

  fetchModels: async () => {
    const state = get();
    const config = state.providerConfigs.find(
      (c) => c.provider_config_id === state.selectedProviderConfigId,
    );
    if (!config) {
      set({ error: '请选择提供商配置' });
      return;
    }

    set({ isFetchingModels: true, error: null });
    try {
      const response = await api.fetchProviderModels({
        adapter_id: config.adapter_id,
        base_url: config.base_url,
      });
      set({ availableModels: response.models, isFetchingModels: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch models';
      set({ isFetchingModels: false, error: message });
    }
  },

  run: async () => {
    const state = get();
    if (state.images.length === 0) {
      set({ error: '请先添加至少一张图片' });
      return null;
    }
    if (!state.selectedProviderConfigId) {
      set({ error: '请选择提供商配置' });
      return null;
    }

    const sampleId = `lab_${Date.now()}`;
    const sample: SampleRecord = {
      sample_id: sampleId,
      sample_type: state.images.length > 1 ? 'multi_image' : 'single_image',
      images: state.images,
      vars: {},
      metadata: { source: 'lab_manual' },
    };

    set({ isRunning: true, error: null });
    try {
      const runSession = await api.runLab({
        sample,
        system_prompt: state.systemPrompt,
        user_prompt: state.userPrompt,
        format_instruction: state.formatInstruction,
        provider_config_id: state.selectedProviderConfigId,
        model_id: state.modelId,
        parameters: state.modelParameters as unknown as Record<string, unknown>,
        output_contract: state.outputContract as unknown as Record<string, unknown>,
        run_name: `Lab: ${sampleId}`,
      });

      // Fetch the full run detail to get the run item with response
      await get().loadRunDetail(runSession.run_id);

      set((prev) => ({
        isRunning: false,
        lastResult: runSession,
        runHistory: [runSession, ...prev.runHistory].slice(0, 50),
      }));
      return runSession;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Run failed';
      set({ isRunning: false, error: message });
      return null;
    }
  },

  loadRunDetail: async (runId: string) => {
    try {
      const detail = await api.getRun(runId);
      const item = detail.items[0] ?? null;
      set({ lastRunItem: item });
    } catch {
      // Non-fatal — the run still succeeded
    }
  },

  clearResults: () =>
    set({
      lastResult: null,
      lastRunItem: null,
      runHistory: [],
      error: null,
    }),

  clearError: () => set({ error: null }),
}));
