/** Request payload types for POST/PUT endpoints. */

import type { ImagePreprocessConfig, ImageSlotSpec, VariableSpec } from '../types';

export interface CreateModelConfigPayload {
  name: string;
  provider_id: string;
  model_id: string;
  adapter_id?: string;
  parameters?: Record<string, unknown>;
  provider_options?: Record<string, unknown>;
  notes?: string;
}

export interface CreatePricingPayload {
  provider_id?: string | null;
  provider_config_id?: string | null;
  model_id: string;
  currency?: string;
  input_token_price?: number;
  output_token_price?: number;
  cached_input_price?: number | null;
  batch_discount?: number;
  image_pricing?: Record<string, unknown>;
  notes?: string;
}

export interface SavePromptPayload {
  name: string;
  system_prompt?: string;
  user_template?: string;
  notes?: string;
  prompt_id?: string | null;
}

export interface UpdateReviewPayload {
  accepted?: boolean | null;
  rating?: number | null;
  labels?: string[];
  notes?: string;
}

export interface CreateTaskVersionPayload {
  system_prompt: string;
  user_template: string;
  provider_config_id?: string | null;
  model_id: string;
  model_parameters?: Record<string, unknown>;
  output_contract?: Record<string, unknown>;
  image_preprocess_config?: ImagePreprocessConfig | null;
  pricing_profile_id?: string | null;
  notes?: string;
  image_slot_specs?: ImageSlotSpec[];
  variable_specs?: VariableSpec[];
}

export interface CreateTaskPayload {
  name: string;
  description?: string;
  tags?: string[];
  group_id?: string | null;
  family_id?: string | null;
  language?: string | null;
  translated_from_version_id?: string | null;
  version: CreateTaskVersionPayload;
}

export interface UpdateTaskPayload {
  name?: string;
  description?: string;
  tags?: string[];
  current_version_id?: string | null;
  group_id?: string | null;
  family_id?: string | null;
  language?: string | null;
  translated_from_version_id?: string | null;
}

export interface CreateResultSnapshotPayload {
  run_id: string;
  run_item_id?: string | null;
  attempt_id?: string | null;
  name: string;
  description?: string;
  tags?: string[];
  notes?: string;
  starred?: boolean;
  linked_task_version_id?: string | null;
}

export interface UpdateResultSnapshotPayload {
  name?: string;
  description?: string;
  tags?: string[];
  notes?: string;
  starred?: boolean;
  accepted?: boolean | null;
  rating?: number | null;
  linked_task_version_id?: string | null;
}
