/** Request payload types for POST/PUT endpoints. */

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
  provider_id: string;
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
  format_instruction?: string;
  notes?: string;
  prompt_id?: string | null;
}

export interface UpdateReviewPayload {
  accepted?: boolean | null;
  rating?: number | null;
  labels?: string[];
  notes?: string;
}
