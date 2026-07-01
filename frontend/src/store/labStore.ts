import { create } from 'zustand';

import * as api from '../api/client';
import type {
  ImagePreprocessConfig,
  ImageRef,
  ImageSlotSpec,
  ModelParameters,
  OutputContract,
  PromptListItem,
  RunItemSummary,
  RunSession,
  SampleRecord,
  Task,
  TaskVersion,
  VariableSpec,
} from '../types';

export const DEFAULT_OUTPUT_CONTRACT: OutputContract = {
  mode: 'free_text',
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

export function buildDefaultVariables(specs: VariableSpec[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const spec of specs) {
    const value =
      typeof spec.default_value === 'string' ? spec.default_value : '';
    vars[spec.var_id] = value;
  }
  return vars;
}

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
        : typeof usage.promptTokenCount === 'number'
          ? usage.promptTokenCount
          : 0;
  const outputTokens =
    typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : typeof usage.completion_tokens === 'number'
        ? usage.completion_tokens
        : typeof usage.candidatesTokenCount === 'number'
          ? usage.candidatesTokenCount
          : 0;
  const details = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const reasoningTokens =
    typeof usage.reasoning_tokens === 'number' ? usage.reasoning_tokens
    : typeof usage.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount
    : (details && typeof details.reasoning_tokens === 'number') ? details.reasoning_tokens
    : null;
  const totalTokens =
    typeof usage.total_tokens === 'number'
      ? usage.total_tokens
      : typeof usage.totalTokenCount === 'number'
        ? usage.totalTokenCount
        : inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    reasoning_tokens: reasoningTokens,
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

function parseImagePreprocessConfig(
  config?: ImagePreprocessConfig | null,
): { enabled: boolean; target: number } {
  if (!config || !config.mode) {
    return { enabled: false, target: 1024 };
  }
  return {
    enabled: true,
    target: config.long_edge ?? config.short_edge ?? 1024,
  };
}

function createDefaultSlot(existingSpecs: ImageSlotSpec[]): ImageSlotSpec {
  const n = existingSpecs.length + 1;
  const baseRoleHint = `slot_${n}`;
  const existingHints = new Set(
    existingSpecs.map((s) => s.role_hint).filter((hint): hint is string => Boolean(hint)),
  );
  let roleHint = baseRoleHint;
  let suffix = 1;
  while (existingHints.has(roleHint)) {
    roleHint = `${baseRoleHint}_${suffix}`;
    suffix++;
  }
  return {
    slot_id: `slot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    label: '',
    description: '',
    role_hint: roleHint,
    required: true,
    min_count: 1,
    max_count: 1,
  };
}

function hasSlotCapacity(spec: ImageSlotSpec, images: ImageRef[]): boolean {
  const count = images.filter((img) => img.slot_id === spec.slot_id).length;
  const max = spec.max_count;
  if (max == null) return true;
  return count < max;
}

// Stable identity key for an image, used to detect duplicates regardless of
// how the image entered the store (fresh upload vs. snapshot restore). Falls
// back through the most specific identifiers available.
function imageIdentityKey(image: ImageRef): string {
  const meta = image.metadata as Record<string, unknown> | undefined;
  const sha = typeof meta?.sha256 === 'string' ? meta.sha256 : '';
  if (sha) return `sha:${sha}`;
  if (image.path) return `path:${image.path}`;
  if (image.uri) return `uri:${image.uri}`;
  return '';
}

function isDuplicateImage(existing: ImageRef[], image: ImageRef): boolean {
  const key = imageIdentityKey(image);
  if (!key) return false;
  return existing.some((img) => imageIdentityKey(img) === key);
}

function findSlotWithCapacity(
  specs: ImageSlotSpec[],
  images: ImageRef[],
): ImageSlotSpec | undefined {
  return specs.find((spec) => hasSlotCapacity(spec, images));
}

function migrateImagesToSlots(
  images: ImageRef[],
  specs: ImageSlotSpec[],
): { specs: ImageSlotSpec[]; migratedImages: ImageRef[] } {
  let nextSpecs = [...specs];
  const migrated: ImageRef[] = [];
  for (const img of images) {
    // Skip exact-content duplicates (e.g. the same file re-added to the lab).
    if (isDuplicateImage(migrated, img)) continue;
    if (img.slot_id && nextSpecs.some((s) => s.slot_id === img.slot_id)) {
      const presetSpec = nextSpecs.find((s) => s.slot_id === img.slot_id)!;
      // Honour capacity even for pre-assigned slots; otherwise fall through to
      // the normal assignment so the image lands somewhere valid instead of
      // overflowing a max_count=1 slot.
      if (hasSlotCapacity(presetSpec, migrated)) {
        migrated.push(img);
        continue;
      }
    }
    let targetSpec: ImageSlotSpec | undefined;
    if (img.role) {
      targetSpec = nextSpecs.find(
        (s) => s.role_hint === img.role && hasSlotCapacity(s, migrated),
      );
    }
    if (!targetSpec) {
      targetSpec = nextSpecs.find((s) => hasSlotCapacity(s, migrated));
    }
    if (!targetSpec) {
      targetSpec = createDefaultSlot(nextSpecs);
      nextSpecs = [...nextSpecs, targetSpec];
    }
    migrated.push({
      ...img,
      slot_id: targetSpec.slot_id,
      role: targetSpec.role_hint ?? img.role ?? '',
    });
  }
  return { specs: nextSpecs, migratedImages: migrated };
}

function removeImagesByIndices(
  images: ImageRef[],
  slots: ImageSlot[],
  indices: number[],
): { images: ImageRef[]; imageSlots: ImageSlot[] } {
  const sorted = [...indices].sort((a, b) => b - a);
  let nextImages = images;
  let nextSlots = slots;
  for (const index of sorted) {
    if (index < 0 || index >= nextImages.length) continue;
    nextImages = nextImages.filter((_, i) => i !== index);
    nextSlots = reindexImageSlots(nextSlots, index);
  }
  return {
    images: nextImages.map((img, i) => ({ ...img, order: i })),
    imageSlots: nextSlots,
  };
}

export function buildImagePreprocessConfig(
  enabled: boolean,
  target: number,
): ImagePreprocessConfig | null {
  if (!enabled) return null;
  return { mode: 'long_edge', long_edge: target };
}

export type LabViewMode = 'edit' | 'prompt-result' | 'image-result';

interface LabState {
  // View
  viewMode: LabViewMode;

  // Prompt
  systemPrompt: string;
  userPrompt: string;

  // Images
  images: ImageRef[];
  imageSlots: ImageSlot[];
  templateImageSlotSpecs: ImageSlotSpec[];
  templateVariableSpecs: VariableSpec[];
  variables: Record<string, string>;
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

  // Active task / prompt references (used by SaveTaskDialog and BatchView)
  activeTaskId: string | null;
  activeTaskVersionId: string | null;
  activePromptId: string | null;
  activePromptVersionId: string | null;

  // Run state
  isRunning: boolean;
  lastResult: RunSession | null;
  lastRunItem: RunItemSummary | null;
  runHistory: RunSession[];
  error: string | null;
  abortController: AbortController | null;
}

interface LabActions {
  setViewMode: (mode: LabViewMode) => void;
  setSystemPrompt: (value: string) => void;
  setUserPrompt: (value: string, change?: { position: number; delta: number }) => void;
  addImage: (image: ImageRef) => void;
  removeImage: (index: number) => void;
  updateImageRole: (index: number, role: string) => void;
  addImageSlot: (imageIndex: number, position: number) => void;
  removeImageSlot: (imageIndex: number) => void;
  setImageSlots: (slots: ImageSlot[]) => void;
  setImages: (images: ImageRef[]) => void;
  addSlot: () => void;
  removeSlot: (slotId: string) => void;
  updateSlot: (slotId: string, patch: Partial<ImageSlotSpec>) => void;
  addImageToSlot: (image: ImageRef, slotId: string) => void;
  moveImageToSlot: (imageIndex: number, slotId: string) => void;
  setTemplateImageSlotSpecs: (specs: ImageSlotSpec[]) => void;
  setTemplateVariableSpecs: (specs: VariableSpec[]) => void;
  setVariable: (varId: string, value: string) => void;
  setVariables: (vars: Record<string, string>) => void;
  setImageResolutionEnabled: (enabled: boolean) => void;
  setImageResolutionTarget: (target: number) => void;
  setSelectedProviderConfigId: (id: string | null) => void;
  setModelId: (value: string) => void;
  loadActivePricing: () => Promise<void>;
  setModelParameters: (parameters: ModelParameters) => void;
  setOutputContract: (contract: OutputContract) => void;
  setOutputMode: (mode: OutputContract['mode']) => void;
  loadTask: (task: Task, version?: TaskVersion) => Promise<void>;
  loadPrompt: (prompt: PromptListItem) => void;
  loadProviderConfigs: () => Promise<void>;
  run: () => Promise<RunSession | null>;
  loadRunDetail: (runId: string) => Promise<api.RunDetail | null>;
  clearResults: () => void;
  clearError: () => void;
  abortRun: () => void;
}

export const useLabStore = create<LabState & LabActions>((set, get) => ({
  viewMode: 'edit',

  systemPrompt: '你是图像标注助手。请根据图片内容生成准确、详细的标注。',
  userPrompt: '请为这张图片生成标注。',
  images: [],
  imageSlots: [],
  templateImageSlotSpecs: [],
  templateVariableSpecs: [],
  variables: {},
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
  activeTaskId: null,
  activeTaskVersionId: null,
  activePromptId: null,
  activePromptVersionId: null,
  isRunning: false,
  lastResult: null,
  lastRunItem: null,
  runHistory: [],
  error: null,
  abortController: null,

  setSystemPrompt: (value) => set({ systemPrompt: value }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setUserPrompt: (value, change) =>
    set((state) => {
      const slots = change
        ? shiftImageSlots(state.imageSlots, change.position, change.delta)
        : state.imageSlots;
      return { userPrompt: value, imageSlots: slots };
    }),

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
  setImages: (images) =>
    set((state) => {
      const { specs, migratedImages } = migrateImagesToSlots(
        images,
        state.templateImageSlotSpecs,
      );
      return {
        templateImageSlotSpecs: specs,
        images: migratedImages.map((img, i) => ({ ...img, order: i })),
      };
    }),
  setTemplateImageSlotSpecs: (specs) => set({ templateImageSlotSpecs: specs }),
  setTemplateVariableSpecs: (specs) => set({ templateVariableSpecs: specs }),
  setVariable: (varId, value) =>
    set((state) => ({
      variables: { ...state.variables, [varId]: value },
    })),
  setVariables: (vars) => set({ variables: vars }),
  setImageResolutionEnabled: (enabled) => set({ imageResolutionEnabled: enabled }),
  setImageResolutionTarget: (target) => set({ imageResolutionTarget: target }),

  addImage: (image) =>
    set((state) => {
      if (isDuplicateImage(state.images, image)) return state;
      let spec = image.slot_id
        ? state.templateImageSlotSpecs.find((s) => s.slot_id === image.slot_id)
        : undefined;
      let nextSpecs = state.templateImageSlotSpecs;
      if (!spec || !hasSlotCapacity(spec, state.images)) {
        spec = findSlotWithCapacity(nextSpecs, state.images);
      }
      if (!spec) {
        spec = createDefaultSlot(nextSpecs);
        nextSpecs = [...nextSpecs, spec];
      }
      return {
        templateImageSlotSpecs: nextSpecs,
        images: [
          ...state.images,
          {
            ...image,
            slot_id: spec.slot_id,
            role: spec.role_hint ?? image.role ?? '',
            order: state.images.length,
          },
        ],
      };
    }),

  addImageToSlot: (image, slotId) =>
    set((state) => {
      if (isDuplicateImage(state.images, image)) return state;
      const spec = state.templateImageSlotSpecs.find((s) => s.slot_id === slotId);
      if (!spec) return state;
      if (!hasSlotCapacity(spec, state.images)) return state;
      return {
        images: [
          ...state.images,
          {
            ...image,
            slot_id: spec.slot_id,
            role: spec.role_hint ?? image.role ?? '',
            order: state.images.length,
          },
        ],
      };
    }),

  moveImageToSlot: (imageIndex, slotId) =>
    set((state) => {
      if (imageIndex < 0 || imageIndex >= state.images.length) return state;
      const spec = state.templateImageSlotSpecs.find((s) => s.slot_id === slotId);
      if (!spec) return state;
      const image = state.images[imageIndex];
      if (!image || image.slot_id === slotId) return state;
      if (!hasSlotCapacity(spec, state.images)) return state;
      const next = [...state.images];
      next[imageIndex] = {
        ...image,
        slot_id: spec.slot_id,
        role: spec.role_hint ?? '',
      };
      return { images: next };
    }),

  addSlot: () =>
    set((state) => ({
      templateImageSlotSpecs: [
        ...state.templateImageSlotSpecs,
        createDefaultSlot(state.templateImageSlotSpecs),
      ],
    })),

  removeSlot: (slotId) =>
    set((state) => {
      const indices = state.images
        .map((img, i) => (img.slot_id === slotId ? i : -1))
        .filter((i): i is number => i >= 0)
        .sort((a, b) => b - a);
      const { images, imageSlots } = removeImagesByIndices(
        state.images,
        state.imageSlots,
        indices,
      );
      return {
        templateImageSlotSpecs: state.templateImageSlotSpecs.filter(
          (s) => s.slot_id !== slotId,
        ),
        images,
        imageSlots,
      };
    }),

  updateSlot: (slotId, patch) =>
    set((state) => {
      const specIndex = state.templateImageSlotSpecs.findIndex(
        (s) => s.slot_id === slotId,
      );
      if (specIndex < 0) return state;
      const nextSpecs = [...state.templateImageSlotSpecs];
      nextSpecs[specIndex] = { ...nextSpecs[specIndex], ...patch };
      let nextImages = state.images;
      if (
        patch.role_hint !== undefined &&
        patch.role_hint !== state.templateImageSlotSpecs[specIndex]?.role_hint
      ) {
        nextImages = state.images.map((img) =>
          img.slot_id === slotId
            ? { ...img, role: patch.role_hint ?? '' }
            : img,
        );
      }
      return {
        templateImageSlotSpecs: nextSpecs,
        images: nextImages,
      };
    }),

  updateImageRole: (index, role) =>
    set((state) => {
      const trimmed = role.trim();
      const next = [...state.images];
      const image = next[index];
      if (!image) return state;
      if (!trimmed) {
        next[index] = { ...image, role: trimmed };
        return { images: next };
      }
      const existingRoles = new Set(
        state.images.map((img, i) => (i === index ? null : img.role)).filter(Boolean),
      );
      let uniqueRole = trimmed;
      if (existingRoles.has(uniqueRole)) {
        let suffix = 1;
        do {
          uniqueRole = `${trimmed}_${suffix}`;
          suffix++;
        } while (existingRoles.has(uniqueRole));
      }
      next[index] = { ...image, role: uniqueRole };
      return { images: next };
    }),

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

  loadTask: async (task, version) => {
    const state = get();
    const resolvedVersion = version ?? task.current_version;

    if (resolvedVersion) {
      const selectedConfig = state.providerConfigs.find(
        (config) => config.provider_config_id === resolvedVersion.provider_config_id,
      );
      const preprocess = parseImagePreprocessConfig(resolvedVersion.image_preprocess_config);
      set({
        selectedProviderConfigId: resolvedVersion.provider_config_id ?? null,
        modelId: resolvedVersion.model_id,
        modelParameters: { ...DEFAULT_MODEL_PARAMETERS, ...(resolvedVersion.model_parameters ?? {}) },
        outputContract: resolvedVersion.output_contract ?? DEFAULT_OUTPUT_CONTRACT,
        imageResolutionEnabled: preprocess.enabled,
        imageResolutionTarget: preprocess.target,
        activeTaskId: task.task_id,
        activeTaskVersionId: resolvedVersion.task_version_id,
        activePromptId: null,
        activePromptVersionId: null,
        availableModels: selectedConfig ? getExposedModels(selectedConfig) : state.availableModels,
        // Clear stale images/slots: the new task has its own slot layout, so any
        // previously loaded image (which references an old slot_id) must not
        // linger as a phantom that gets sent on the next run.
        images: [],
        imageSlots: [],
        error: null,
      });

      const parsed = parseImageTokens(resolvedVersion.user_template ?? '');
      const variableSpecs = resolvedVersion.variable_specs ?? [];
      set({
        systemPrompt: resolvedVersion.system_prompt ?? '',
        userPrompt: parsed.text,
        imageSlots: parsed.slots,
        templateImageSlotSpecs: resolvedVersion.image_slot_specs ?? [],
        templateVariableSpecs: variableSpecs,
        variables: buildDefaultVariables(variableSpecs),
      });
      return;
    }

    // Backward compatibility for legacy flat Task records.
    const selectedConfig = state.providerConfigs.find(
      (config) => config.provider_config_id === task.provider_config_id,
    );
    const parsed = parseImageTokens(task.user_prompt ?? '');
    set({
      selectedProviderConfigId: task.provider_config_id ?? null,
      modelId: task.model_id ?? '',
      modelParameters: { ...DEFAULT_MODEL_PARAMETERS, ...(task.model_parameters ?? {}) },
      systemPrompt: task.system_prompt ?? '',
      userPrompt: parsed.text,
      imageSlots: parsed.slots,
      templateImageSlotSpecs: [],
      templateVariableSpecs: [],
      imageResolutionEnabled: task.image_resolution_enabled ?? false,
      imageResolutionTarget: task.image_resolution_target ?? 1024,
      outputContract: task.output_contract ?? DEFAULT_OUTPUT_CONTRACT,
      activeTaskId: task.task_id,
      activeTaskVersionId: null,
      activePromptId: null,
      activePromptVersionId: null,
      availableModels: selectedConfig ? getExposedModels(selectedConfig) : state.availableModels,
      images: [],
      error: null,
    });
  },

  loadPrompt: (prompt) =>
    set(() => {
      const parsed = parseImageTokens(prompt.user_template ?? '');
      return {
        systemPrompt: prompt.system_prompt ?? '',
        userPrompt: parsed.text,
        imageSlots: parsed.slots,
        // Prompt defines its own slot layout; drop any images loaded under a
        // different prompt/task so they don't persist as phantom images.
        images: [],
        activePromptId: prompt.prompt_id,
        activePromptVersionId: null,
        activeTaskId: null,
        activeTaskVersionId: null,
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
    // Defense-in-depth: drop any duplicate images (same path/uri/sha256) that
    // may have slipped into the store before persisting a run. This guarantees
    // a run item / snapshot can never carry a phantom duplicate image.
    const dedupedImages: ImageRef[] = [];
    for (const img of state.images) {
      if (!isDuplicateImage(dedupedImages, img)) dedupedImages.push(img);
    }
    const sample: SampleRecord = {
      sample_id: sampleId,
      sample_type: dedupedImages.length > 1 ? 'multi_image' : 'single_image',
      images: dedupedImages,
      vars: state.variables,
      metadata: { source: 'lab_manual' },
    };

    const isStreaming = state.modelParameters.stream === true;
    const abortController = new AbortController();
    set({
      isRunning: true,
      error: null,
      abortController,
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
        provider_config_id: state.selectedProviderConfigId,
        model_id: state.modelId,
        parameters: state.modelParameters as unknown as Record<string, unknown>,
        output_contract: state.outputContract as unknown as Record<string, unknown>,
        image_resolution_enabled: state.imageResolutionEnabled,
        image_resolution_target: state.imageResolutionTarget,
        run_name: `Lab: ${sampleId}`,
        image_slot_specs: state.templateImageSlotSpecs,
        variable_specs: state.templateVariableSpecs,
      };

      if (isStreaming) {
        let persistedRunId: string | null = null;
        await api.runLabStream(payload, (event) => {
          if (event.event === 'done') {
            if (typeof event.usage?.run_id === 'string') {
              persistedRunId = event.usage.run_id;
            }
            // Handle truncation / content filter from finish_reason
            const fr = event.finish_reason;
            if (fr === 'length' || fr === 'content_filter') {
              const message =
                fr === 'length'
                  ? 'Response was truncated due to max token limit.'
                  : 'Response was blocked by content filter.';
              set((prev) => ({
                error: message,
                lastRunItem: prev.lastRunItem
                  ? {
                      ...prev.lastRunItem,
                      status: fr === 'content_filter' ? 'blocked' : 'failed',
                      error: {
                        type: fr === 'content_filter' ? 'safety_blocked' : 'provider_error',
                        message,
                        retryable: false,
                      },
                    }
                  : prev.lastRunItem,
              }));
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
        }, abortController.signal);

        const detail = persistedRunId ? await get().loadRunDetail(persistedRunId) : null;
        const runSession = detail ? (detail.session as unknown as RunSession) : null;
        set((prev) => ({
          isRunning: false,
          abortController: null,
          lastResult: runSession,
          runHistory: runSession ? [runSession, ...prev.runHistory].slice(0, 50) : prev.runHistory,
        }));
        return runSession;
      }

      const runSession = await api.runLab(payload, abortController.signal);

      // Fetch the full run detail to get the run item with response
      await get().loadRunDetail(runSession.run_id);

      set((prev) => ({
        isRunning: false,
        abortController: null,
        lastResult: runSession,
        runHistory: [runSession, ...prev.runHistory].slice(0, 50),
      }));
      return runSession;
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      if (aborted) {
        set((prev) => ({
          isRunning: false,
          abortController: null,
          lastRunItem: prev.lastRunItem
            ? {
                ...prev.lastRunItem,
                status: 'aborted',
                completed_at: new Date().toISOString(),
              }
            : prev.lastRunItem,
        }));
        return null;
      }
      const message = err instanceof Error ? err.message : 'Run failed';
      set((prev) => ({
        isRunning: false,
        abortController: null,
        error: message,
        lastRunItem: prev.lastRunItem
          ? { ...prev.lastRunItem, status: 'failed', error: { type: 'unknown_error', message } }
          : prev.lastRunItem,
      }));
      return null;
    }
  },

  loadRunDetail: async (runId: string) => {
    try {
      const detail = await api.getRun(runId);
      const item = detail.items[0] ?? null;
      if (item) {
        set({ lastRunItem: item });
      }
      return detail;
    } catch {
      // Non-fatal — preserve existing lastRunItem (may have streaming error state)
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

  abortRun: () => {
    get().abortController?.abort();
  },
}));
