// src/types/index.ts
// TypeScript interfaces that mirror the backend Pydantic schemas exactly.
// Python `str | None`    -> `string | null`
// Python `dict[str, Any]` -> `Record<string, unknown>`
// Python `list[T]`       -> `T[]`
// Python enums           -> string literal union types
// Python datetime/date   -> string (ISO 8601)

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type OutputMode =
  | 'free_text'
  | 'soft_sections'
  | 'loose_json'
  | 'strict_json'
  | 'custom';

export type RunSessionStatus =
  | 'created'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'cancelled'
  | 'failed';

export type RunItemType =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type AttemptStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'rate_limited'
  | 'blocked'
  | 'cancelled';

export type ParseStatus =
  | 'not_parsed'
  | 'parsed'
  | 'partially_parsed'
  | 'parse_failed';

export type RunType =
  | 'lab'
  | 'batch'
  | 'compare'
  | 'rerun_failed'
  | 'import_test'
  | 'dry_run';

export type ErrorType =
  | 'auth_error'
  | 'rate_limit'
  | 'timeout'
  | 'network_error'
  | 'provider_error'
  | 'invalid_request'
  | 'unsupported_capability'
  | 'safety_blocked'
  | 'empty_response'
  | 'parse_error'
  | 'format_error'
  | 'unknown_error';

// ---------------------------------------------------------------------------
// Common / shared
// ---------------------------------------------------------------------------

export interface Timestamps {
  created_at?: string;
  updated_at?: string;
}

export interface NormalizedError {
  type?: ErrorType;
  message?: string;
  provider_error_code?: string | null;
  retryable?: boolean;
  raw_error?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Sample Record
// ---------------------------------------------------------------------------

export interface ImageMetadata {
  width?: number | null;
  height?: number | null;
  file_size?: number | null;
  sha256?: string | null;
  extra?: Record<string, unknown>;
}

export interface ImageRef {
  [key: string]: unknown;
  image_id?: string | null;
  slot_id?: string;
  role?: string;
  path?: string | null;
  uri?: string | null;
  mime_type?: string | null;
  display_name?: string | null;
  order?: number;
  metadata?: ImageMetadata;
}

export interface SampleRecord {
  [key: string]: unknown;
  schema_version?: string;
  sample_id: string;
  sample_type?: string;
  images?: ImageRef[];
  vars?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  expected?: Record<string, unknown> | null;
  tags?: string[];
  notes?: string;
  sample_set_id?: string | null;
}

export interface SampleSet {
  schema_version?: string;
  sample_set_id: string;
  name: string;
  description?: string;
  import_source?: Record<string, unknown> | null;
  record_ids?: string[];
  metadata?: Record<string, unknown>;
}

export interface SampleRecordORM extends Timestamps {
  id?: number | null;
  sample_id: string;
  sample_set_id?: string | null;
  sample_type?: string;
  data: Record<string, unknown>;
  tags?: string[];
  notes?: string;
}

export interface SampleSetORM extends Timestamps {
  id?: number | null;
  sample_set_id: string;
  name: string;
  description?: string;
  import_source?: Record<string, unknown> | null;
  record_ids?: string[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Output Contract
// ---------------------------------------------------------------------------

export interface ParserConfig {
  type?: string;
  options?: Record<string, unknown>;
}

export interface OutputContract {
  mode?: OutputMode;
  format_instruction?: string | null;
  json_schema?: Record<string, unknown> | null;
  parser?: ParserConfig | null;
}

// ---------------------------------------------------------------------------
// Model Config
// ---------------------------------------------------------------------------

export interface ModelParameters {
  temperature?: number | null;
  max_output_tokens?: number | null;
  top_p?: number | null;
  seed?: number | null;
  stop?: string[] | null;
  enable_thinking?: boolean | null;
  thinking_budget?: number | null;
  reasoning_effort?: string | null;
  stream?: boolean | null;
}

export interface ModelConfig extends Timestamps {
  model_config_id: string;
  name: string;
  provider_id: string;
  model_id: string;
  adapter_id?: string;
  parameters?: ModelParameters;
  provider_options?: Record<string, unknown>;
  notes?: string;
}

export interface ModelConfigSnapshot {
  model_config_id?: string | null;
  provider_id: string;
  model_id: string;
  adapter_id: string;
  parameters?: ModelParameters;
  provider_options?: Record<string, unknown>;
}

export interface TaskVersion extends Timestamps {
  task_version_id: string;
  task_id: string;
  version_label?: string;
  prompt_id: string;
  prompt_version_id: string;
  provider_config_id?: string | null;
  model_id: string;
  model_parameters?: ModelParameters;
  output_contract?: OutputContract;
  image_preprocess_config?: ImagePreprocessConfig | null;
  pricing_profile_id?: string | null;
  notes?: string;
}

export interface Task extends Timestamps {
  task_id: string;
  name: string;
  description?: string;
  current_version_id?: string | null;
  tags?: string[];
  current_version?: TaskVersion | null;

  // Backward-compatible fields from the previous flat Task design.
  // New API responses use current_version instead, but cached data or
  // older responses may still include these fields.
  provider_config_id?: string | null;
  model_id?: string;
  model_parameters?: ModelParameters;
  system_prompt?: string;
  user_prompt?: string;
  format_instruction?: string;
  output_contract?: OutputContract;
  pricing_profile_id?: string | null;
  image_resolution_enabled?: boolean;
  image_resolution_target?: number;
  sample_set_id?: string | null;
  notes?: string;
}

export interface ProviderCapability {
  provider_id: string;
  model_id: string;
  supports_image?: boolean;
  supports_multi_image?: boolean;
  supports_system_prompt?: boolean;
  supports_json_mode?: boolean;
  supports_strict_json_schema?: boolean;
  supports_batch_api?: boolean;
  max_images?: number | null;
  max_output_tokens?: number | null;
  known_quirks?: string[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface ImageSlotSpec {
  slot_id: string;
  label?: string;
  description?: string;
  role_hint?: string | null;
  required?: boolean;
  min_count?: number;
  max_count?: number | null;
}

export interface VariableSpec {
  var_id: string;
  label?: string;
  description?: string;
  required?: boolean;
  default_value?: string | null;
  type?: string;
}

export interface FewShotExample {
  example_id: string;
  title?: string;
  enabled?: boolean;
  input_text?: string;
  output_text?: string;
  parsed_output?: unknown;
  reasoning_text?: string | null;
  images?: ImageRef[];
  source_run_id?: string | null;
  source_run_item_id?: string | null;
  source_attempt_id?: string | null;
  notes?: string;
  created_from?: string;
}

export interface PromptVersionData {
  system_prompt?: string;
  user_template?: string;
  format_instruction?: string;
  notes?: string;
  image_slot_specs?: ImageSlotSpec[];
  variable_specs?: VariableSpec[];
  few_shot_examples?: FewShotExample[];
}

export interface PromptVersion extends PromptVersionData, Timestamps {
  prompt_version_id: string;
  prompt_id: string;
  version_label?: string;
  parent_version_id?: string | null;
}

export interface Prompt extends Timestamps {
  prompt_id: string;
  name: string;
  description?: string;
  current_version_id?: string | null;
  tags?: string[];
}

export interface PromptListItem extends Timestamps {
  prompt_id: string;
  name: string;
  description?: string;
  current_version_id?: string | null;
  tags?: string[];
  latest_version?: {
    prompt_version_id: string;
    version_label?: string;
    system_prompt?: string;
    user_template?: string;
    format_instruction?: string;
    notes?: string;
    image_slot_specs?: ImageSlotSpec[];
    variable_specs?: VariableSpec[];
    few_shot_examples?: FewShotExample[];
    created_at?: string;
    updated_at?: string;
  } | null;
}

export interface PromptSnapshot {
  prompt_id?: string | null;
  prompt_version_id?: string | null;
  system_prompt?: string;
  user_template?: string;
  format_instruction?: string;
  notes?: string;
  image_slot_specs?: ImageSlotSpec[];
  variable_specs?: VariableSpec[];
  few_shot_examples?: FewShotExample[];
  version_label?: string | null;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface ImagePriceMode {
  mode?: string;
  image_token_price?: number | null;
  image_per_request_price?: number | null;
}

export interface PricingProfile extends Timestamps {
  pricing_profile_id: string;
  provider_id: string;
  provider_config_id?: string | null;
  model_id: string;
  currency?: string;
  effective_date?: string | null;
  input_token_price?: number;
  output_token_price?: number;
  cached_input_price?: number | null;
  batch_discount?: number;
  image_pricing?: ImagePriceMode;
  notes?: string;
}

export interface PricingSnapshot {
  pricing_profile_id?: string | null;
  currency?: string;
  input_token_price?: number;
  output_token_price?: number;
  cached_input_price?: number | null;
  batch_discount?: number;
  image_pricing?: ImagePriceMode;
  raw?: Record<string, unknown> | null;
}

export interface CostBreakdown {
  input_text?: number;
  output_text?: number;
  image_input?: number;
  cached_input?: number;
  retry_extra?: number;
}

export interface CostEstimate {
  estimated_cost?: number;
  actual_cost?: number | null;
  currency?: string;
  pricing_profile_id?: string | null;
  pricing_snapshot?: PricingSnapshot | null;
  cost_breakdown?: CostBreakdown;
}

// ---------------------------------------------------------------------------
// Internal Request
// ---------------------------------------------------------------------------

export interface RenderContext {
  vars?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  sample_id?: string | null;
}

export interface TemplateRefs {
  prompt_id?: string | null;
  prompt_version_id?: string | null;
}

export interface PromptSpec {
  system_prompt?: string;
  user_prompt?: string;
  render_context?: RenderContext;
  template_refs?: TemplateRefs;
  format_instruction?: string;
}

export interface ImagePreprocessConfig {
  mode?: string;
  long_edge?: number | null;
  short_edge?: number | null;
  box_width?: number | null;
  box_height?: number | null;
  format?: string | null;
  quality?: number | null;
}

export interface ResolvedImage {
  path?: string | null;
  uri?: string | null;
  mime_type?: string;
  width?: number | null;
  height?: number | null;
  file_size?: number | null;
  sha256?: string | null;
}

export interface RequestImage {
  request_image_id: string;
  source_image_id?: string | null;
  role?: string;
  path?: string | null;
  mime_type?: string | null;
  order?: number;
  preprocess?: ImagePreprocessConfig;
  resolved?: ResolvedImage | null;
}

export interface ModelSpec {
  provider_id: string;
  model_id: string;
  adapter_id?: string;
  parameters?: ModelParameters;
  provider_options?: Record<string, unknown>;
}

export interface CostContext {
  pricing_profile_id?: string | null;
  currency?: string;
  pricing_snapshot?: PricingSnapshot | null;
}

export interface RetryPolicy {
  max_retries?: number;
  retry_on?: string[];
}

export interface RuntimeOptions {
  timeout_seconds?: number;
  retry_policy?: RetryPolicy;
  dry_run?: boolean;
}

export interface SampleRef {
  sample_id: string;
  sample_set_id?: string | null;
}

export interface InternalRequest {
  schema_version?: string;
  request_id: string;
  sample_ref: SampleRef;
  prompt?: PromptSpec;
  images?: RequestImage[];
  model: ModelSpec;
  output_contract?: OutputContract;
  cost_context?: CostContext;
  runtime?: RuntimeOptions;
}

// ---------------------------------------------------------------------------
// Run Record
// ---------------------------------------------------------------------------

export interface RunSource {
  mode?: string;
  sample_set_id?: string | null;
  sample_ids?: string[];
}

export interface ConfigSnapshot {
  prompt_version?: PromptSnapshot | null;
  model_config_snapshot?: ModelConfigSnapshot | null;
  output_contract?: OutputContract | null;
  preprocess_config?: Record<string, unknown> | null;
  pricing_profile?: PricingSnapshot | null;
}

export interface RunSummary {
  total_items?: number;
  succeeded_items?: number;
  failed_items?: number;
  cancelled_items?: number;
  skipped_items?: number;
  total_attempts?: number;
  total_cost_estimated?: number;
  currency?: string;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_image_count?: number;
  total_latency_ms?: number;
  avg_latency_ms?: number;
}

export interface RunSession extends Timestamps {
  schema_version?: string;
  run_id: string;
  run_type?: RunType;
  name?: string;
  status?: RunSessionStatus;
  started_at?: string | null;
  completed_at?: string | null;
  source?: RunSource;
  config_snapshot?: ConfigSnapshot;
  summary?: RunSummary;
  notes?: string;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  image_count?: number;
  image_tokens?: number | null;
  cached_input_tokens?: number | null;
  provider_reported?: boolean;
  estimated?: boolean;
  raw_usage?: Record<string, unknown> | null;
}

export interface SafetyInfo {
  blocked?: boolean;
  categories?: string[];
  raw?: Record<string, unknown> | null;
}

export interface NormalizedResponse {
  text?: string;
  finish_reason?: string | null;
  safety?: SafetyInfo;
  reasoning_text?: string | null;
}

export interface ParsedResponse {
  raw_text?: string;
  parsed?: unknown;
  parse_status?: ParseStatus;
  parse_errors?: Record<string, unknown>[];
}

export interface AdapterInfo {
  provider_id: string;
  adapter_id: string;
  model_id: string;
}

export interface Attempt {
  schema_version?: string;
  attempt_id: string;
  run_item_id: string;
  attempt_index?: number;
  status?: AttemptStatus;
  started_at?: string | null;
  completed_at?: string | null;
  adapter?: AdapterInfo | null;
  provider_request_snapshot?: Record<string, unknown> | null;
  provider_response_raw?: Record<string, unknown> | null;
  normalized_response?: NormalizedResponse | null;
  usage?: Usage | null;
  error?: NormalizedError | null;
  latency_ms?: number | null;
}

export interface Review {
  accepted?: boolean | null;
  rating?: number | null;
  labels?: string[];
  notes?: string;
  reviewed_at?: string | null;
}

export interface RunItemExportInfo {
  exportable?: boolean;
  export_status?: string;
}

export interface CompareAxes {
  task_version_id?: string | null;
  prompt_version_id?: string | null;
  model_config_id?: string | null;
}

export interface RunItem extends Timestamps {
  schema_version?: string;
  run_item_id: string;
  run_id: string;
  sample_id: string;
  status?: RunItemType;
  started_at?: string | null;
  completed_at?: string | null;
  internal_request_snapshot?: Record<string, unknown> | null;
  final_attempt_id?: string | null;
  latency_ms?: number | null;
  response?: ParsedResponse;
  usage?: Usage;
  cost?: CostEstimate;
  review?: Review;
  export?: RunItemExportInfo;
  compare_axes?: CompareAxes | null;
  error?: NormalizedError | null;
}

export interface AdapterResult {
  status: AttemptStatus;
  normalized_response?: NormalizedResponse | null;
  usage?: Usage | null;
  error?: NormalizedError | null;
  latency_ms?: number | null;
  provider_request_snapshot?: Record<string, unknown> | null;
  provider_response_raw?: Record<string, unknown> | null;
}

export interface RunItemSummary extends Timestamps {
  run_item_id: string;
  run_id: string;
  sample_id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  internal_request_snapshot?: Record<string, unknown> | null;
  prompt_snapshot: Record<string, unknown> | null;
  model_config_snapshot: Record<string, unknown> | null;
  output_contract_snapshot: Record<string, unknown> | null;
  pricing_snapshot: Record<string, unknown> | null;
  final_attempt_id: string | null;
  latency_ms: number | null;
  response: Record<string, unknown>;
  usage: Record<string, unknown>;
  cost: Record<string, unknown>;
  review: Record<string, unknown>;
  error: Record<string, unknown> | null;
  provider_id: string | null;
  model_id: string | null;
  estimated_cost: number;
  compare_axes?: CompareAxes | null;
}

// ---------------------------------------------------------------------------
// Result snapshots
// ---------------------------------------------------------------------------

export interface ResultSnapshot extends Timestamps {
  snapshot_id: string;
  run_id: string;
  run_item_id?: string | null;
  attempt_id?: string | null;
  name: string;
  description?: string;
  tags?: string[];
  starred?: boolean;
  notes?: string;
  accepted?: boolean | null;
  rating?: number | null;
  provider_id?: string | null;
  model_id?: string | null;
  prompt_version_id?: string | null;
  thumbnail_image_uri?: string | null;
  internal_request_snapshot?: Record<string, unknown> | null;
  config_snapshot?: Record<string, unknown> | null;
  image_dir?: string | null;
}

export interface ResultSnapshotDetail {
  snapshot: ResultSnapshot;
  run_session: RunSession;
  run_item: RunItemSummary | null;
  attempt: Attempt | null;
}

// ---------------------------------------------------------------------------
// API request / response shapes
// ---------------------------------------------------------------------------

export interface RunLabRequest {
  system_prompt?: string;
  user_prompt?: string;
  format_instruction?: string;
  images?: ImageRef[];
  model_config_id: string;
  output_contract?: OutputContract;
  runtime_options?: RuntimeOptions;
}

export interface RunLabResponse {
  run_session: RunSession;
}

export interface ListResponse<T> {
  items: T[];
  total?: number;
}

export interface CreateSampleRequest {
  sample: SampleRecord;
}

export interface SavePromptRequest {
  prompt: Prompt;
  version?: PromptVersionData;
}

export interface SaveModelConfigRequest {
  model_config: ModelConfig;
}

export interface SavePricingProfileRequest {
  pricing_profile: PricingProfile;
}

export interface SettingsRecord {
  api_keys?: Record<string, string>;
  default_model_config_id?: string | null;
  default_pricing_profile_id?: string | null;
  [key: string]: unknown;
}

export interface UploadImageResponse {
  path: string;
  url: string;
  filename: string | null;
  mime_type: string;
  size: number;
}

export interface ApiErrorBody {
  detail?: string | Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Compare runs
// ---------------------------------------------------------------------------

export interface CompareTaskVersionPayload {
  task_id: string;
  task_version_id?: string | null;
  label?: string | null;
}

export interface CreateCompareRunPayload {
  sample_set_id: string;
  task_versions: CompareTaskVersionPayload[];
  limit?: number | null;
}

export type CompareRunEstimatePayload = CreateCompareRunPayload;

export interface CompareRunCreationResponse {
  run_id: string;
  status: string;
  summary: Record<string, unknown>;
}

export interface CompareRunEstimateResponse {
  estimated_cost: number;
  currency: string;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  sample_count: number;
}

// ---------------------------------------------------------------------------
// Task input spec
// ---------------------------------------------------------------------------

export interface ExpectedCsvColumn {
  column: string;
  kind: string;
  role_hint?: string | null;
  var_id?: string | null;
  required: boolean;
}

export interface TaskInputSpecImageSlot {
  slot_id: string;
  role_hint: string | null;
  label: string;
  required: boolean;
  min_count: number;
  max_count: number | null;
  description: string | null;
}

export interface TaskInputSpecVariableSlot {
  var_id: string;
  label: string;
  description: string | null;
  required: boolean;
  default_value: string | null;
  type: string;
}

export interface TaskInputSpec {
  task_id: string;
  task_version_id: string;
  task_name: string;
  version_label: string;
  system_prompt: string;
  user_template: string;
  format_instruction: string;
  image_slots: TaskInputSpecImageSlot[];
  variable_slots: TaskInputSpecVariableSlot[];
  expected_csv_columns: ExpectedCsvColumn[];
  csv_example_row: Record<string, string>;
  jsonl_example: Record<string, unknown>;
  notes: string;
}
