import { create } from 'zustand';

import * as api from '../api/client';
import type {
  ImageRef,
  ImageSlotSpec,
  ModelParameters,
  OutputContract,
  PromptListItem,
  RunItemSummary,
  RunSession,
  SampleRecord,
  Task,
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
  stream: false,
};

export interface ImageSlot {
  imageIndex: number;
  position: number;
}

const IMAGE_TOKEN_RE = /{{\s*image\s*:\s*(\d+)\s*}}/gi;

export function parseImageTokens(raw: string): { text: string; slots: ImageSlot[] } {
  const slots: ImageSlot[] = [];
  let text = '';
  let lastEnd = 0;

  for (const match of raw.matchAll(IMAGE_TOKEN_RE)) {
    const start = match.index ?? 0;
    text += raw.slice(lastEnd, start);
    slots.push({
      imageIndex: parseInt(match[1], 10),
      position: text.length,
    });
    lastEnd = start + match[0].length;
  }

  text += raw.slice(lastEnd);
  return { text, slots };
}

export function buildPromptWithImageSlots(
  text: string,
  slots: ImageSlot[],
): string {
  if (slots.length === 0) return text;

  const ordered = [...slots].sort((a, b) => a.position - b.position);

  let result = text;
  let offset = 0;

  for (const slot of ordered) {
    const clampedPosition = Math.max(0, Math.min(slot.position, text.length));
    const token = `{{image:${slot.imageIndex}}}`;
    const insertAt = clampedPosition + offset;
    result = result.slice(0, insertAt) + token + result.slice(insertAt);
    offset += token.length;
  }

  return result;
}

function getExposedModels(config: api.ProviderConfig | undefined): string[] {
  if (!config) return [];
  return config.selected_models.length > 0 ? config.selected_models : config.cached_models;
}

function streamUsageToRunUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const inputTokens =
    typeof usage.input_tokens === 'number'
      ? usage.input_tokens
      : typeof usage.prompt_tokens === 'number'
        ? usage.prompt_tokens
        : 0;
  const outputTokens =
    typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : typeof usage.completion_tokens === 'number'
        ? usage.completion_tokens
        : 0;
  const totalTokens =
    typeof usage.total_tokens === 'number' ? usage.total_tokens : inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    provider_reported: true,
    estimated: false,
    raw_usage: usage,
  };
}

function createStreamingRunItem(sampleId: string): RunItemSummary {
  const now = new Date().toISOString();
  return {
    run_item_id: `stream_${sampleId}`,
    run_id: `stream_${sampleId}`,
    sample_id: sampleId,
    status: 'running',
    started_at: now,
    completed_at: null,
    prompt_snapshot: null,
    model_config_snapshot: null,
    output_contract_snapshot: null,
    pricing_snapshot: null,
    final_attempt_id: null,
    latency_ms: null,
    response: { raw_text: '', parsed: '', parse_status: 'not_parsed', reasoning_text: '' },
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, image_count: 0 },
    cost: {},
    review: {},
    error: null,
    provider_id: null,
    model_id: null,
    estimated_cost: 0,
    created_at: now,
  };
}

function shiftImageSlots(
  slots: ImageSlot[],
  position: number,
  delta: number,
): ImageSlot[] {
  if (delta === 0) return slots;
  const start = Math.max(0, position);

  if (delta > 0) {
    return slots.map((slot) =>
      slot.position >= start
        ? { ...slot, position: slot.position + delta }
        : slot,
    );
  }

  const removed = -delta;
  const end = start + removed;

  return slots.map((slot) => {
    if (slot.position <= start) return slot;
    if (slot.position > end) {
      return { ...slot, position: slot.position + delta };
    }
    return { ...slot, position: start };
  });
}

function reindexImageSlots(
  slots: ImageSlot[],
  removedIndex: number,
): ImageSlot[] {
  return slots
    .filter((slot) => slot.imageIndex !== removedIndex)
    .map((slot) =>
      slot.imageIndex > removedIndex
        ? { ...slot, imageIndex: slot.imageIndex - 1 }
        : slot,
    );
}

export type LabViewMode = 'edit' | 'prompt-result' | 'image-result';

interface LabState {
  // View
  viewMode: LabViewMode;

  // Prompt
  systemPrompt: string;
  userPrompt: string;
  formatInstruction: string;

  // Images
  images: ImageRef[];
  imageSlots: ImageSlot[];
  templateImageSlotSpecs: ImageSlotSpec[];
  imageResolutionEnabled: boolean;
  imageResolutionTarget: number;

  // Provider config
  providerConfigs: api.ProviderConfig[];
  selectedProviderConfigId: string | null;

  // Model
  modelId: string;
  activePricing: api.PricingListItem | null;
  isLoadingPricing: boolean;
  availableModels: string[];
  modelParameters: ModelParameters;
  outputContract: OutputContract;

  // Run state
  isRunning: boolean;
  lastResult: RunSession | null;
  lastRunItem: RunItemSummary | null;
  runHistory: RunSession[];
  error: string | null;
}

interface LabActions {
  setViewMode: (mode: LabViewMode) => void;
  setSystemPrompt: (value: string) => void;
  setUserPrompt: (value: string, change?: { position: number; delta: number }) => void;
  setFormatInstruction: (value: string) => void;
  addImage: (image: ImageRef) => void;
  removeImage: (index: number) => void;
  addImageSlot: (imageIndex: number, position: number) => void;
  removeImageSlot: (imageIndex: number) => void;
  setImageSlots: (slots: ImageSlot[]) => void;
  setImages: (images: ImageRef[]) => void;
  setTemplateImageSlotSpecs: (specs: ImageSlotSpec[]) => void;
  setImageResolutionEnabled: (enabled: boolean) => void;
  setImageResolutionTarget: (target: number) => void;
  setSelectedProviderConfigId: (id: string | null) => void;
  setModelId: (value: string) => void;
  loadActivePricing: () => Promise<void>;
  setModelParameters: (parameters: ModelParameters) => void;
  setOutputContract: (contract: OutputContract) => void;
  setOutputMode: (mode: OutputContract['mode']) => void;
  loadTask: (task: Task) => void;
  loadPrompt: (prompt: PromptListItem) => void;
  loadProviderConfigs: () => Promise<void>;
  run: () => Promise<RunSession | null>;
  loadRunDetail: (runId: string) => Promise<api.RunDetail | null>;
  clearResults: () => void;
  clearError: () => void;
}

export const useLabStore = create<LabState & LabActions>((set, get) => ({
  viewMode: 'edit',

  systemPrompt: '你是图像标注助手。请根据图片内容生成准确、详细的标注。',
  userPrompt: '请为这张图片生成标注。',
  formatInstruction: '',
  images: [],
  imageSlots: [],
  templateImageSlotSpecs: [],
  imageResolutionEnabled: false,
  imageResolutionTarget: 1024,
  providerConfigs: [],
  selectedProviderConfigId: null,
  modelId: '',
  activePricing: null,
  isLoadingPricing: false,
  availableModels: [],
  modelParameters: DEFAULT_MODEL_PARAMETERS,
  outputContract: DEFAULT_OUTPUT_CONTRACT,
  isRunning: false,
  lastResult: null,
  lastRunItem: null,
  runHistory: [],
  error: null,

  setSystemPrompt: (value) => set({ systemPrompt: value }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setUserPrompt: (value, change) =>
    set((state) => {
      const slots = change
        ? shiftImageSlots(state.imageSlots, change.position, change.delta)
        : state.imageSlots;
      return { userPrompt: value, imageSlots: slots };
    }),
  setFormatInstruction: (value) => set({ formatInstruction: value }),

  addImageSlot: (imageIndex, position) =>
    set((state) => {
      if (imageIndex < 0 || imageIndex >= state.images.length) return state;
      const existingIndex = state.imageSlots.findIndex(
        (slot) => slot.imageIndex === imageIndex,
      );
      const nextSlots = [...state.imageSlots];
      if (existingIndex >= 0) {
        nextSlots[existingIndex] = { imageIndex, position };
      } else {
        nextSlots.push({ imageIndex, position });
      }
      return { imageSlots: nextSlots };
    }),

  removeImageSlot: (imageIndex) =>
    set((state) => ({
      imageSlots: state.imageSlots.filter((slot) => slot.imageIndex !== imageIndex),
    })),

  setImageSlots: (slots) => set({ imageSlots: slots }),
  setImages: (images) => set({ images: images.map((img, i) => ({ ...img, order: i })) }),
  setTemplateImageSlotSpecs: (specs) => set({ templateImageSlotSpecs: specs }),
  setImageResolutionEnabled: (enabled) => set({ imageResolutionEnabled: enabled }),
  setImageResolutionTarget: (target) => set({ imageResolutionTarget: target }),

  addImage: (image) =>
    set((state) => ({
      images: [...state.images, { ...image, order: state.images.length }],
    })),

  removeImage: (index) =>
    set((state) => ({
      images: state.images
        .filter((_, i) => i !== index)
        .map((img, i) => ({ ...img, order: i })),
      imageSlots: reindexImageSlots(state.imageSlots, index),
    })),

  setSelectedProviderConfigId: (id) =>
    set((state) => {
      const config = state.providerConfigs.find((c) => c.provider_config_id === id);
      const availableModels = getExposedModels(config);
      // Auto-fill the first exposed model when user selects a provider and modelId is empty
      const modelId = state.modelId || (availableModels.length > 0 ? availableModels[0] : '');
      return {
        selectedProviderConfigId: id,
        availableModels,
        modelId,
      };
    }),
  setModelId: (value) => set({ modelId: value }),
  setModelParameters: (parameters) => set({ modelParameters: parameters }),
  setOutputContract: (contract) => set({ outputContract: contract }),

  setOutputMode: (mode) =>
    set((state) => ({
      outputContract: { ...state.outputContract, mode: mode ?? 'free_text' },
    })),

  loadTask: (task) =>
    set((state) => {
      const selectedConfig = state.providerConfigs.find(
        (config) => config.provider_config_id === task.provider_config_id,
      );
      const parsed = parseImageTokens(task.user_prompt ?? '');
      return {
        selectedProviderConfigId: task.provider_config_id ?? null,
        modelId: task.model_id,
        modelParameters: task.model_parameters ?? DEFAULT_MODEL_PARAMETERS,
        systemPrompt: task.system_prompt ?? '',
        userPrompt: parsed.text,
        formatInstruction: task.format_instruction ?? '',
        imageSlots: parsed.slots,
        templateImageSlotSpecs: [],
        imageResolutionEnabled: task.image_resolution_enabled ?? false,
        imageResolutionTarget: task.image_resolution_target ?? 1024,
        outputContract: task.output_contract ?? DEFAULT_OUTPUT_CONTRACT,
        activePricing: task.pricing_profile_id ? state.activePricing : null,
        availableModels: selectedConfig ? getExposedModels(selectedConfig) : state.availableModels,
        error: null,
      };
    }),

  loadPrompt: (prompt) =>
    set(() => {
      const version = prompt.latest_version;
      const parsed = parseImageTokens(version?.user_template ?? '');
      return {
        systemPrompt: version?.system_prompt ?? '',
        userPrompt: parsed.text,
        imageSlots: parsed.slots,
        templateImageSlotSpecs: version?.image_slot_specs ?? [],
        error: null,
      };
    }),

  loadProviderConfigs: async () => {
    set({ error: null });
    try {
      const configs = await api.listProviderConfigs();
      const selectedId = get().selectedProviderConfigId;
      const selectedConfig = configs.find((c) => c.provider_config_id === selectedId);
      set({
        providerConfigs: configs,
        availableModels: selectedConfig ? getExposedModels(selectedConfig) : get().availableModels,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load provider configs';
      set({ error: message });
    }
  },

  loadActivePricing: async () => {
    const state = get();
    const providerConfigId = state.selectedProviderConfigId;
    const modelId = state.modelId.trim();
    if (!providerConfigId || !modelId) {
      set({ activePricing: null, isLoadingPricing: false });
      return;
    }
    set({ isLoadingPricing: true });
    try {
      const rows = await api.listPricing({ provider_config_id: providerConfigId, model_id: modelId });
      set({ activePricing: rows[0] ?? null, isLoadingPricing: false });
    } catch {
      set({ activePricing: null, isLoadingPricing: false });
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
    if (!state.modelId.trim()) {
      set({ error: '请输入或选择模型 ID' });
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

    const isStreaming = state.modelParameters.stream === true;
    set({
      isRunning: true,
      error: null,
      lastRunItem: isStreaming ? createStreamingRunItem(sampleId) : state.lastRunItem,
    });
    const effectiveUserPrompt = buildPromptWithImageSlots(
      state.userPrompt,
      state.imageSlots,
    );
    try {
      const payload: api.LabRunPayload = {
        sample,
        system_prompt: state.systemPrompt,
        user_prompt: effectiveUserPrompt,
        format_instruction: state.formatInstruction,
        provider_config_id: state.selectedProviderConfigId,
        model_id: state.modelId,
        parameters: state.modelParameters as unknown as Record<string, unknown>,
        output_contract: state.outputContract as unknown as Record<string, unknown>,
        image_resolution_enabled: state.imageResolutionEnabled,
        image_resolution_target: state.imageResolutionTarget,
        run_name: `Lab: ${sampleId}`,
      };

      if (isStreaming) {
        let persistedRunId: string | null = null;
        await api.runLabStream(payload, (event) => {
          if (event.event === 'done') {
            if (typeof event.usage?.run_id === 'string') {
              persistedRunId = event.usage.run_id;
            }
            return;
          }
          if (event.event === 'usage' && event.usage) {
            set((prev) => ({
              lastRunItem: prev.lastRunItem
                ? { ...prev.lastRunItem, usage: streamUsageToRunUsage(event.usage ?? {}) }
                : prev.lastRunItem,
            }));
            return;
          }
          if (event.event === 'error') {
            const message =
              typeof event.error?.message === 'string' ? event.error.message : 'Run failed';
            set((prev) => ({
              error: message,
              lastRunItem: prev.lastRunItem
                ? { ...prev.lastRunItem, status: 'failed', error: event.error ?? null }
                : prev.lastRunItem,
            }));
            return;
          }
          if (event.event !== 'content' && event.event !== 'reasoning') return;
          const delta = event.delta ?? '';
          if (!delta) return;
          set((prev) => {
            if (!prev.lastRunItem) return prev;
            const response = prev.lastRunItem.response ?? {};
            const rawText = typeof response.raw_text === 'string' ? response.raw_text : '';
            const reasoningText =
              typeof response.reasoning_text === 'string' ? response.reasoning_text : '';
            const nextResponse =
              event.event === 'content'
                ? {
                    ...response,
                    raw_text: rawText + delta,
                    parsed: rawText + delta,
                    parse_status: 'not_parsed',
                  }
                : { ...response, reasoning_text: reasoningText + delta };
            return { lastRunItem: { ...prev.lastRunItem, response: nextResponse } };
          });
        });

        const detail = persistedRunId ? await get().loadRunDetail(persistedRunId) : null;
        const runSession = detail ? (detail.session as unknown as RunSession) : null;
        set((prev) => ({
          isRunning: false,
          lastResult: runSession,
          runHistory: runSession ? [runSession, ...prev.runHistory].slice(0, 50) : prev.runHistory,
        }));
        return runSession;
      }

      const runSession = await api.runLab(payload);

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
      return detail;
    } catch {
      // Non-fatal — the run still succeeded
      return null;
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
