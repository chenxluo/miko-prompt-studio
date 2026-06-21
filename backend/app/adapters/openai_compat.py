"""OpenAI-compatible chat completions adapter."""

from __future__ import annotations

import base64
import mimetypes
import re
from pathlib import Path
from typing import Any

import httpx

from app.adapters.base import BaseAdapter
from app.schemas.common import AttemptStatus, ErrorType, NormalizedError, OutputMode
from app.schemas.internal_request import InternalRequest, RequestImage
from app.schemas.model_config import ProviderCapability
from app.schemas.run_record import AdapterResult, NormalizedResponse, SafetyInfo, Usage

DEFAULT_BASE_URL = "https://api.openai.com/v1"


class OpenAICompatAdapter(BaseAdapter):
    """Adapter for OpenAI-compatible ``/chat/completions`` APIs.

    Subclasses can override ``DEFAULT_BASE_URL`` to target a specific platform.
    Instances using ``adapter_id="openai_compat"`` require a ``base_url`` to be
    supplied at call time — there is no default endpoint.
    """

    adapter_id = "openai_compat"
    DEFAULT_BASE_URL = ""  # no default — caller must supply base_url

    def list_models(self) -> list[str]:
        """Static catalog is empty — use :meth:`fetch_models` for live discovery."""

        return []

    async def fetch_models(
        self,
        api_key: str,
        base_url: str | None,
        timeout: int = 30,
    ) -> list[str]:
        """Call ``GET /v1/models`` to discover available model IDs."""

        resolved_base = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        if not resolved_base:
            raise ValueError("base_url is required for the openai_compat adapter.")

        url = f"{resolved_base}/models"
        headers = {"Authorization": f"Bearer {api_key}"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            response = await client.get(url, headers=headers)

        if response.is_error:
            raise _models_error(response)

        data = response.json()
        models = data.get("data") if isinstance(data, dict) else data
        if not isinstance(models, list):
            return []

        result: list[str] = []
        for item in models:
            if isinstance(item, dict):
                model_id = item.get("id") or item.get("model")
                if isinstance(model_id, str):
                    result.append(model_id)
            elif isinstance(item, str):
                result.append(item)
        return sorted(result)

    def get_capability(self, model_id: str) -> ProviderCapability:
        return ProviderCapability(
            provider_id="openai_compat",
            model_id=model_id,
            supports_image=True,
            supports_multi_image=True,
            supports_system_prompt=True,
            supports_json_mode=True,
            supports_strict_json_schema=True,
            supports_batch_api=False,
            max_images=20,
        )

    def build_provider_request(self, request: InternalRequest) -> dict[str, Any]:
        messages: list[dict[str, Any]] = []
        if request.system_prompt.strip():
            messages.append({"role": "system", "content": request.system_prompt})

        prompt_text = self._build_user_prompt(request)
        sorted_images = sorted(request.images, key=lambda item: item.order)
        user_content = self._build_user_content(prompt_text, sorted_images)

        messages.append({"role": "user", "content": user_content})

        payload: dict[str, Any] = {
            "model": request.model.model_id,
            "messages": messages,
        }

        params = request.model.parameters
        if params.temperature is not None:
            payload["temperature"] = params.temperature
        if params.max_output_tokens is not None:
            payload["max_tokens"] = params.max_output_tokens
        if params.top_p is not None:
            payload["top_p"] = params.top_p
        if params.seed is not None:
            payload["seed"] = params.seed
        if params.stop is not None:
            payload["stop"] = params.stop

        # Thinking / reasoning parameters (DeepSeek, Qwen, OpenAI o-series, etc.)
        if params.enable_thinking is not None:
            payload["enable_thinking"] = params.enable_thinking
        if params.thinking_budget is not None:
            payload["thinking_budget"] = params.thinking_budget
        if params.reasoning_effort is not None:
            payload["reasoning_effort"] = params.reasoning_effort

        payload.update(request.model.provider_options)
        response_format = self._response_format(request)
        if response_format is not None:
            payload["response_format"] = response_format

        return payload

    async def send(
        self,
        provider_request: dict[str, Any],
        api_key: str,
        base_url: str | None,
        timeout: int,
    ) -> httpx.Response:
        resolved = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        if not resolved:
            raise ValueError(
                "base_url is required for the openai_compat adapter. "
                "Provide it in the model config or run request."
            )
        url = f"{resolved}/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            return await client.post(url, headers=headers, json=provider_request)

    def parse_response(self, response: httpx.Response, request: InternalRequest) -> AdapterResult:
        data = response.json()
        choices = data.get("choices") or []
        if not choices:
            return AdapterResult(
                status=AttemptStatus.FAILED,
                usage=self._usage_with_image_count(data, request),
                error=NormalizedError(
                    type=ErrorType.EMPTY_RESPONSE,
                    message="Provider response contained no choices.",
                    retryable=False,
                    raw_error=data,
                ),
            )

        first_choice = choices[0]
        message = first_choice.get("message") or {}
        content = message.get("content")
        text = self._content_to_text(content)
        finish_reason = first_choice.get("finish_reason")
        blocked = finish_reason == "content_filter"

        return AdapterResult(
            status=AttemptStatus.BLOCKED if blocked else AttemptStatus.SUCCEEDED,
            normalized_response=NormalizedResponse(
                text=text,
                finish_reason=finish_reason,
                safety=SafetyInfo(
                    blocked=blocked,
                    categories=["content_filter"] if blocked else [],
                    raw=first_choice if blocked else None,
                ),
            ),
            usage=self._usage_with_image_count(data, request),
            error=(
                NormalizedError(
                    type=ErrorType.SAFETY_BLOCKED,
                    message="Provider blocked the response via content_filter.",
                    retryable=False,
                    raw_error=first_choice,
                )
                if blocked
                else None
            ),
        )

    def parse_usage(self, response_data: dict[str, Any]) -> Usage:
        usage = response_data.get("usage") or {}
        prompt_tokens = int(usage.get("prompt_tokens") or 0)
        completion_tokens = int(usage.get("completion_tokens") or 0)
        total_tokens = int(usage.get("total_tokens") or prompt_tokens + completion_tokens)

        cached_tokens = None
        prompt_details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details")
        if isinstance(prompt_details, dict):
            cached = prompt_details.get("cached_tokens") or prompt_details.get(
                "cached_input_tokens"
            )
            cached_tokens = int(cached) if cached is not None else None

        return Usage(
            input_tokens=prompt_tokens,
            output_tokens=completion_tokens,
            total_tokens=total_tokens,
            image_count=0,
            cached_input_tokens=cached_tokens,
            provider_reported=bool(usage),
            estimated=not bool(usage),
            raw_usage=usage or None,
        )

    def normalize_error(
        self,
        response: httpx.Response | None,
        exception: Exception | None,
    ) -> NormalizedError:
        if exception is not None:
            if isinstance(exception, httpx.TimeoutException):
                return NormalizedError(
                    type=ErrorType.TIMEOUT,
                    message=str(exception) or "Provider request timed out.",
                    retryable=True,
                    raw_error={"exception": exception.__class__.__name__},
                )
            if isinstance(exception, httpx.HTTPError):
                return NormalizedError(
                    type=ErrorType.NETWORK_ERROR,
                    message=str(exception) or "Network error while calling provider.",
                    retryable=True,
                    raw_error={"exception": exception.__class__.__name__},
                )
            return NormalizedError(
                type=ErrorType.UNKNOWN_ERROR,
                message=str(exception) or "Unknown adapter error.",
                retryable=False,
                raw_error={"exception": exception.__class__.__name__},
            )

        if response is None:
            return NormalizedError(type=ErrorType.UNKNOWN_ERROR, message="Unknown provider error.")

        raw_error = self._error_body(response)
        message = self._error_message(raw_error) or response.reason_phrase
        status = response.status_code
        if status in {401, 403}:
            error_type = ErrorType.AUTH_ERROR
            retryable = False
        elif status == 429:
            error_type = ErrorType.RATE_LIMIT
            retryable = True
        elif status == 408:
            error_type = ErrorType.TIMEOUT
            retryable = True
        elif 500 <= status <= 599:
            error_type = ErrorType.PROVIDER_ERROR
            retryable = False
        elif 400 <= status <= 499:
            error_type = ErrorType.INVALID_REQUEST
            retryable = False
        else:
            error_type = ErrorType.UNKNOWN_ERROR
            retryable = False

        return NormalizedError(
            type=error_type,
            message=message,
            provider_error_code=str(status),
            retryable=retryable,
            raw_error=raw_error,
        )

    def _build_user_prompt(self, request: InternalRequest) -> str:
        pieces = [request.user_prompt]
        format_instruction = request.prompt.format_instruction or ""
        effective_instruction = request.output_contract.effective_format_instruction()
        if format_instruction:
            pieces.append(format_instruction)
        if effective_instruction and effective_instruction != format_instruction:
            pieces.append(effective_instruction)
        return "\n\n".join(piece for piece in pieces if piece.strip())

    # Regex for inline image references: {{image:0}}, {{image:1}}, etc.
    _INLINE_IMAGE_RE = re.compile(r"{{\s*image\s*:\s*(\d+)\s*}}", re.IGNORECASE)

    def _build_user_content(
        self,
        prompt_text: str,
        images: list[RequestImage],
    ) -> list[dict[str, Any]]:
        """Build the OpenAI ``content`` array for the user message.

        If the prompt contains ``{{image:N}}`` tokens, images are interleaved
        at the specified positions.  Otherwise, text is emitted first followed
        by all images appended in order (the default behaviour).
        """

        if not prompt_text and not images:
            return []

        # Check for inline image references
        matches = list(self._INLINE_IMAGE_RE.finditer(prompt_text or ""))

        if not matches:
            # Default: text first, then all images
            content: list[dict[str, Any]] = []
            if prompt_text:
                content.append({"type": "text", "text": prompt_text})
            for image in images:
                content.append(
                    {"type": "image_url", "image_url": {"url": self._image_to_url(image)}}
                )
            return content

        # Inline mode: interleave text segments and image references
        content = []
        last_end = 0
        referenced_indices: set[int] = set()

        for match in matches:
            # Text before the image token
            text_segment = prompt_text[last_end : match.start()].strip()
            if text_segment:
                content.append({"type": "text", "text": text_segment})

            img_index = int(match.group(1))
            if 0 <= img_index < len(images):
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": self._image_to_url(images[img_index])},
                    }
                )
                referenced_indices.add(img_index)
            else:
                # Out-of-range index — emit a text placeholder
                content.append(
                    {"type": "text", "text": f"[image {img_index} not available]"}
                )

            last_end = match.end()

        # Trailing text after the last image token
        trailing = prompt_text[last_end:].strip()
        if trailing:
            content.append({"type": "text", "text": trailing})

        # Append any images that were NOT referenced inline
        for i, image in enumerate(images):
            if i not in referenced_indices:
                content.append(
                    {"type": "image_url", "image_url": {"url": self._image_to_url(image)}}
                )

        return content

    def _response_format(self, request: InternalRequest) -> dict[str, Any] | None:
        contract = request.output_contract
        if contract.mode == OutputMode.STRICT_JSON:
            if contract.json_schema:
                return {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "annotation_output",
                        "schema": contract.json_schema,
                        "strict": True,
                    },
                }
            return {"type": "json_object"}
        if contract.mode == OutputMode.LOOSE_JSON:
            return {"type": "json_object"}
        return None

    def _image_to_url(self, image: RequestImage) -> str:
        resolved = image.resolved
        uri = resolved.uri if resolved is not None else None
        if uri:
            return uri

        path = (resolved.path if resolved is not None and resolved.path else image.path)
        if path is None:
            raise ValueError(f"Image {image.request_image_id} has neither data URI nor path.")
        if path.startswith(("http://", "https://", "data:")):
            return path

        file_path = Path(path).expanduser()
        if not file_path.exists():
            raise FileNotFoundError(f"Image file not found: {file_path}")

        mime_type = (
            (resolved.mime_type if resolved is not None else None)
            or image.mime_type
            or mimetypes.guess_type(file_path.name)[0]
            or "application/octet-stream"
        )
        encoded = base64.b64encode(file_path.read_bytes()).decode("ascii")
        return f"data:{mime_type};base64,{encoded}"

    def _usage_with_image_count(
        self, response_data: dict[str, Any], request: InternalRequest
    ) -> Usage:
        usage = self.parse_usage(response_data)
        usage.image_count = len(request.images)
        return usage

    def _content_to_text(self, content: Any) -> str:
        if content is None:
            return ""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict):
                    text = item.get("text")
                    if isinstance(text, str):
                        parts.append(text)
                elif isinstance(item, str):
                    parts.append(item)
            return "".join(parts)
        return str(content)

    def _error_body(self, response: httpx.Response) -> dict[str, Any]:
        try:
            data = response.json()
            return data if isinstance(data, dict) else {"body": data}
        except ValueError:
            return {"body": response.text}

    def _error_message(self, raw_error: dict[str, Any]) -> str | None:
        error = raw_error.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            return str(message) if message is not None else None
        if isinstance(error, str):
            return error
        body = raw_error.get("body")
        return str(body) if body else None


# ---------------------------------------------------------------------------
# OpenAI native adapter (uses api.openai.com, no base_url required)
# ---------------------------------------------------------------------------

OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"


class OpenAINativeAdapter(OpenAICompatAdapter):
    """Adapter for the official OpenAI API (``api.openai.com``).

    Unlike :class:`OpenAICompatAdapter`, this adapter has a fixed default base
    URL so the caller never needs to supply one.
    """

    adapter_id = "openai"
    DEFAULT_BASE_URL = OPENAI_DEFAULT_BASE_URL

    def get_capability(self, model_id: str) -> ProviderCapability:
        return ProviderCapability(
            provider_id="openai",
            model_id=model_id,
            supports_image=True,
            supports_multi_image=True,
            supports_system_prompt=True,
            supports_json_mode=True,
            supports_strict_json_schema=True,
            supports_batch_api=False,
            max_images=20,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _models_error(response: httpx.Response) -> Exception:
    """Build a descriptive exception for a failed /v1/models call."""

    try:
        body = response.json()
    except ValueError:
        body = response.text

    return RuntimeError(
        f"Failed to fetch model list (HTTP {response.status_code}): {body}"
    )
