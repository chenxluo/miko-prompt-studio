/// <reference types="vite/client" />

import type {
  ApiErrorBody,
  FewShotExample,
  ImageSlotSpec,
  ModelConfig,
  PricingProfile,
  Prompt,
  ResultSnapshot,
  ResultSnapshotDetail,
  RunItemSummary,
  RunSession,
  SampleRecord,
  Task,
  UploadImageResponse,
} from '../types';
import type {
  CreateModelConfigPayload,
  CreatePricingPayload,
  CreateResultSnapshotPayload,
  SavePromptPayload,
  SaveTaskPayload,
  UpdateResultSnapshotPayload,
  UpdateReviewPayload,
} from './payloads';

export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:21317';

let runtimeBaseUrlOverride: string | null = null;

export function setBaseUrl(url: string): void {
  runtimeBaseUrlOverride = url.replace(/\/$/, '');
}

export function getBaseUrl(): string {
  return (
    runtimeBaseUrlOverride ??
    (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ??
    DEFAULT_API_BASE_URL
  );
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: ApiErrorBody | null,
    public originalError?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function parseErrorBody(response: Response): Promise<ApiErrorBody | null> {
  const contentType = response.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/json')) {
      return (await response.json()) as ApiErrorBody;
    }
    const text = await response.text();
    return text ? { detail: text } : null;
  } catch {
    return null;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  isFormData = false,
): Promise<T> {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const url = `${baseUrl}${path}`;

  const headers = new Headers();
  if (!isFormData && body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const init: RequestInit = { method, headers };

  if (body !== undefined) {
    init.body = isFormData ? (body as FormData) : JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw new ApiError(
      `Network error while calling ${method} ${path}`,
      0,
      null,
      err,
    );
  }

  if (!response.ok) {
    const errorBody = await parseErrorBody(response);
    const message =
      typeof errorBody?.detail === 'string'
        ? errorBody.detail
        : `${method} ${path} failed with status ${response.status}`;
    throw new ApiError(message, response.status, errorBody);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new ApiError(
      `Failed to parse JSON response from ${method} ${path}`,
      response.status,
      null,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export async function checkHealth(): Promise<{ status: string; version: string }> {
  return request<{ status: string; version: string }>('GET', '/api/health');
}

// ---------------------------------------------------------------------------
// Providers & model discovery
// ---------------------------------------------------------------------------

export interface ProviderMetadata {
  adapter_id: string;
  label: string;
  requires_base_url: boolean;
  default_base_url: string | null;
  supports_model_discovery: boolean;
}

export async function listProviders(): Promise<{ providers: ProviderMetadata[] }> {
  return request<{ providers: ProviderMetadata[] }>('GET', '/api/providers');
}

export interface FetchModelsPayload {
  provider_config_id?: string;
  adapter_id?: string;
  api_key?: string;
  base_url?: string | null;
}

export interface FetchModelsResponse {
  models: string[];
  adapter_id: string;
}

export async function fetchProviderModels(
  payload: FetchModelsPayload,
): Promise<FetchModelsResponse> {
  return request<FetchModelsResponse>('POST', '/api/providers/models', payload);
}

// ---------------------------------------------------------------------------
// Provider configs
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  provider_config_id: string;
  name: string;
  adapter_id: string;
  base_url: string | null;
  api_key_set: boolean;
  api_key_masked: string;
  cached_models: string[];
  selected_models: string[];
  models_cached_at: string | null;
  notes: string;
  created_at: string;
}

export interface SaveProviderConfigPayload {
  name: string;
  adapter_id?: string;
  base_url?: string | null;
  api_key?: string | null;
  selected_models?: string[];
  notes?: string;
  provider_config_id?: string | null;
}

export async function listProviderConfigs(): Promise<ProviderConfig[]> {
  return request<ProviderConfig[]>('GET', '/api/provider-configs');
}

export async function saveProviderConfig(
  payload: SaveProviderConfigPayload,
): Promise<{
  provider_config_id: string;
  name: string;
  adapter_id: string;
  base_url: string | null;
  api_key_set: boolean;
  cached_models: string[];
  selected_models: string[];
  models_cached_at: string | null;
  created: boolean;
}> {
  return request<
    {
      provider_config_id: string;
      name: string;
      adapter_id: string;
      base_url: string | null;
      api_key_set: boolean;
      cached_models: string[];
      selected_models: string[];
      models_cached_at: string | null;
      created: boolean;
    }
  >('POST', '/api/provider-configs', payload);
}

export async function deleteProviderConfig(
  configId: string,
): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(
    'DELETE',
    `/api/provider-configs/${encodeURIComponent(configId)}`,
  );
}

// ---------------------------------------------------------------------------
// Lab run
// ---------------------------------------------------------------------------

export interface LabRunPayload {
  sample: SampleRecord;
  system_prompt: string;
  user_prompt: string;
  format_instruction: string;
  prompt_version_id?: string | null;
  prompt_id?: string | null;
  model_config_id?: string | null;
  provider_config_id?: string | null;
  model_id: string;
  parameters?: Record<string, unknown>;
  provider_options?: Record<string, unknown>;
  output_contract?: Record<string, unknown>;
  pricing_profile_id?: string | null;
  image_resolution_enabled?: boolean;
  image_resolution_target?: number;
  run_name?: string;
}

export async function runLab(payload: LabRunPayload): Promise<RunSession> {
  return request<RunSession>('POST', '/api/lab/run', payload);
}

export interface LabStreamEvent {
  event: 'reasoning' | 'content' | 'usage' | 'done' | 'error';
  delta?: string | null;
  usage?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
}

export async function runLabStream(
  payload: LabRunPayload,
  onEvent: (event: LabStreamEvent) => void,
): Promise<void> {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/api/lab/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await parseErrorBody(response);
    const message =
      typeof errorBody?.detail === 'string'
        ? errorBody.detail
        : `POST /api/lab/run failed with status ${response.status}`;
    throw new ApiError(message, response.status, errorBody);
  }

  if (!response.body) {
    throw new ApiError('Streaming response body is not available.', response.status, null);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushBlocks = (isFinal = false) => {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const blocks = normalized.split('\n\n');
    buffer = isFinal ? '' : blocks.pop() ?? '';
    const readyBlocks = isFinal ? blocks.filter(Boolean) : blocks;
    for (const block of readyBlocks) {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n');
      if (!data) continue;
      onEvent(JSON.parse(data) as LabStreamEvent);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flushBlocks();
  }
  buffer += decoder.decode();
  flushBlocks(true);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type { Task };

export async function listTasks(): Promise<Task[]> {
  return request<Task[]>('GET', '/api/tasks');
}

export async function getTask(taskId: string): Promise<Task> {
  return request<Task>('GET', `/api/tasks/${encodeURIComponent(taskId)}`);
}

export async function createTask(payload: SaveTaskPayload): Promise<Task> {
  return request<Task>('POST', '/api/tasks', payload);
}

export async function updateTask(
  taskId: string,
  payload: SaveTaskPayload,
): Promise<Task> {
  return request<Task>('PUT', `/api/tasks/${encodeURIComponent(taskId)}`, payload);
}

export async function deleteTask(taskId: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(
    'DELETE',
    `/api/tasks/${encodeURIComponent(taskId)}`,
  );
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunListItem {
  run_id: string;
  run_type: string;
  name: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  summary: Record<string, unknown>;
  created_at: string;
}

export async function listRuns(limit = 50): Promise<RunListItem[]> {
  return request<RunListItem[]>('GET', `/api/runs?limit=${limit}`);
}

export interface RunDetail {
  session: RunListItem & {
    source: Record<string, unknown>;
    config_snapshot: Record<string, unknown>;
    notes: string;
  };
  items: RunItemSummary[];
}

export async function getRun(runId: string): Promise<RunDetail> {
  return request<RunDetail>('GET', `/api/runs/${encodeURIComponent(runId)}`);
}

export async function getRunItem(
  runId: string,
  runItemId: string,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    'GET',
    `/api/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(runItemId)}`,
  );
}

export async function updateReview(
  runId: string,
  runItemId: string,
  payload: UpdateReviewPayload,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    'PATCH',
    `/api/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(runItemId)}/review`,
    payload,
  );
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

export interface SampleListItem {
  sample_id: string;
  sample_set_id: string | null;
  sample_type: string;
  data: Record<string, unknown>;
  tags: string[];
  notes: string;
  created_at: string;
}

export async function listSamples(
  sampleSetId?: string,
  limit = 100,
): Promise<SampleListItem[]> {
  const params = new URLSearchParams();
  if (sampleSetId) params.set('sample_set_id', sampleSetId);
  params.set('limit', String(limit));
  return request<SampleListItem[]>('GET', `/api/samples?${params.toString()}`);
}

export async function createSample(sample: SampleRecord): Promise<{ sample_id: string; created: boolean }> {
  return request<{ sample_id: string; created: boolean }>('POST', '/api/samples', sample);
}

// ---------------------------------------------------------------------------
// Sample sets
// ---------------------------------------------------------------------------

export interface SampleSetListItem {
  sample_set_id: string;
  name: string;
  description: string;
  record_ids: string[];
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function listSampleSets(): Promise<SampleSetListItem[]> {
  return request<SampleSetListItem[]>('GET', '/api/sample-sets');
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export interface PromptListItem {
  prompt_id: string;
  name: string;
  description: string;
  current_version_id: string | null;
  tags: string[];
  latest_version: {
    prompt_version_id: string;
    version_label: string;
    system_prompt: string;
    user_template: string;
    format_instruction: string;
    notes: string;
    image_slot_specs: ImageSlotSpec[];
    few_shot_examples: FewShotExample[];
  } | null;
  created_at: string;
}

export type { Prompt };

export async function listPrompts(): Promise<PromptListItem[]> {
  return request<PromptListItem[]>('GET', '/api/prompts');
}

export async function savePrompt(
  payload: SavePromptPayload,
): Promise<{ prompt_id: string; prompt_version_id: string; created: boolean }> {
  return request('POST', '/api/prompts', payload);
}

export async function getPrompt(promptId: string): Promise<PromptListItem> {
  return request<PromptListItem>('GET', `/api/prompts/${encodeURIComponent(promptId)}`);
}

export async function getPromptVersion(
  promptId: string,
  versionId: string,
): Promise<{
  prompt_version_id: string;
  prompt_id: string;
  version_label: string;
  system_prompt: string;
  user_template: string;
  format_instruction: string;
  notes: string;
  image_slot_specs: ImageSlotSpec[];
  few_shot_examples: FewShotExample[];
  created_at: string;
}> {
  return request<
    {
      prompt_version_id: string;
      prompt_id: string;
      version_label: string;
      system_prompt: string;
      user_template: string;
      format_instruction: string;
      notes: string;
      image_slot_specs: ImageSlotSpec[];
      few_shot_examples: FewShotExample[];
      created_at: string;
    }
  >('GET', `/api/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(versionId)}`);
}

export async function deletePrompt(promptId: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(
    'DELETE',
    `/api/prompts/${encodeURIComponent(promptId)}`,
  );
}

// ---------------------------------------------------------------------------
// Model configs
// ---------------------------------------------------------------------------

export type { ModelConfig };

export interface ModelConfigListItem {
  model_config_id: string;
  name: string;
  provider_id: string;
  model_id: string;
  adapter_id: string;
  parameters: Record<string, unknown>;
  provider_options: Record<string, unknown>;
  notes: string;
  created_at: string;
}

export async function listModelConfigs(): Promise<ModelConfigListItem[]> {
  return request<ModelConfigListItem[]>('GET', '/api/model-configs');
}

export async function saveModelConfig(
  payload: CreateModelConfigPayload,
): Promise<{ model_config_id: string; created: boolean }> {
  return request('POST', '/api/model-configs', payload);
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export type { PricingProfile };

export interface PricingListItem {
  pricing_profile_id: string;
  provider_id: string;
  provider_config_id: string | null;
  model_id: string;
  currency: string;
  effective_date: string | null;
  input_token_price: number;
  output_token_price: number;
  cached_input_price: number | null;
  batch_discount: number;
  image_pricing: Record<string, unknown>;
  notes: string;
  created_at: string;
}

export async function listPricing(filters?: {
  provider_config_id?: string | null;
  model_id?: string | null;
}): Promise<PricingListItem[]> {
  const params = new URLSearchParams();
  if (filters?.provider_config_id) params.set('provider_config_id', filters.provider_config_id);
  if (filters?.model_id) params.set('model_id', filters.model_id);
  const query = params.toString();
  return request<PricingListItem[]>('GET', `/api/pricing${query ? `?${query}` : ''}`);
}

export async function savePricing(
  payload: CreatePricingPayload,
): Promise<{ pricing_profile_id: string; created: boolean }> {
  return request('POST', '/api/pricing', payload);
}

export async function deletePricing(
  pricingProfileId: string,
): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(
    'DELETE',
    `/api/pricing/${encodeURIComponent(pricingProfileId)}`,
  );
}

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

export async function uploadImage(
  file: File,
): Promise<UploadImageResponse> {
  const formData = new FormData();
  formData.append('file', file);
  return request<UploadImageResponse>('POST', '/api/upload/image', formData, true);
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

export interface CsvPreviewResponse {
  columns: string[];
  rows: Record<string, string>[];
}

export async function previewCsv(
  csvPath: string,
  delimiter = ',',
): Promise<CsvPreviewResponse> {
  return request<CsvPreviewResponse>('POST', '/api/import/csv/preview', {
    csv_path: csvPath,
    delimiter,
  });
}

export async function importCsv(
  payload: Record<string, unknown>,
): Promise<{ sample_set_id: string; imported_count: number }> {
  return request<{ sample_set_id: string; imported_count: number }>(
    'POST',
    '/api/import/csv',
    payload,
  );
}

// ---------------------------------------------------------------------------
// Result snapshots
// ---------------------------------------------------------------------------

export async function createResultSnapshot(
  payload: CreateResultSnapshotPayload,
): Promise<ResultSnapshot> {
  return request<ResultSnapshot>('POST', '/api/result-snapshots', payload);
}

export async function listResultSnapshots(options?: {
  limit?: number;
  starred_only?: boolean;
  tag?: string;
  provider_id?: string;
  model_id?: string;
}): Promise<ResultSnapshot[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.starred_only !== undefined) params.set('starred_only', String(options.starred_only));
  if (options?.tag) params.set('tag', options.tag);
  if (options?.provider_id) params.set('provider_id', options.provider_id);
  if (options?.model_id) params.set('model_id', options.model_id);
  const query = params.toString();
  return request<ResultSnapshot[]>('GET', `/api/result-snapshots${query ? `?${query}` : ''}`);
}

export async function getResultSnapshot(snapshotId: string): Promise<ResultSnapshotDetail> {
  return request<ResultSnapshotDetail>(
    'GET',
    `/api/result-snapshots/${encodeURIComponent(snapshotId)}`,
  );
}

export async function updateResultSnapshot(
  snapshotId: string,
  payload: UpdateResultSnapshotPayload,
): Promise<ResultSnapshot> {
  return request<ResultSnapshot>(
    'PATCH',
    `/api/result-snapshots/${encodeURIComponent(snapshotId)}`,
    payload,
  );
}

export async function deleteResultSnapshot(snapshotId: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(
    'DELETE',
    `/api/result-snapshots/${encodeURIComponent(snapshotId)}`,
  );
}
