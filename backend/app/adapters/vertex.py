"""Google Vertex AI (Gemini) native adapter.

Calls Vertex AI's native Gemini REST API (``generateContent`` /
``streamGenerateContent``). Authentication uses a **service-account JSON key**
(the full JSON is stored as-is in the existing encrypted ``api_key`` slot); the
Vertex region/location lives in the existing ``base_url`` slot. There is no DB
migration and no OpenAI-compat shim — this is the native Gemini surface only.

RS256 JWT-bearer auth (RFC 7523) is implemented with the already-installed
``cryptography`` library — no new dependency.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import re
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import load_pem_private_key

from app.adapters.base import BaseAdapter
from app.schemas.common import AttemptStatus, ErrorType, NormalizedError, OutputMode
from app.schemas.internal_request import InternalRequest, RequestImage
from app.schemas.model_config import ProviderCapability
from app.schemas.run_record import (
    AdapterResult,
    NormalizedResponse,
    SafetyInfo,
    StreamEvent,
    Usage,
)

# ---------------------------------------------------------------------------
# Static Gemini model catalog (the only "discovery" this adapter offers).
# ---------------------------------------------------------------------------

GEMINI_MODELS: list[str] = [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
]

DEFAULT_LOCATION = "us-central1"
_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

# finishReason values that mean the candidate was blocked (not a normal stop).
_BLOCKED_FINISH_REASONS = frozenset(
    {
        "SAFETY",
        "RECITATION",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "SPII",
        "IMAGE_SAFETY",
        "LANGUAGE",
    }
)

# JSON-Schema ``type`` → Gemini Schema REST enum (UPPERCASE proto names).
# Lowercase types 400; this map is applied at every schema node. Idempotent.
_GEMINI_TYPE_MAP: dict[str, str] = {
    "string": "STRING",
    "number": "NUMBER",
    "integer": "INTEGER",
    "boolean": "BOOLEAN",
    "array": "ARRAY",
    "object": "OBJECT",
}

# JSON-Schema keys Gemini's responseSchema subset accepts.
_GEMINI_SCHEMA_KEEP: dict[str, None] = {  # ordered allow-list
    "type": None,
    "format": None,
    "description": None,
    "nullable": None,
    "enum": None,
    "required": None,
    "items": None,
    "properties": None,
}

# Service-account JSON fields that MUST be present and truthy.
_REQUIRED_SA_FIELDS = ("type", "project_id", "private_key", "client_email", "token_uri")

# Token cache keyed by (project_id, client_email) → (access_token, expires_at).
# ponytail: no lock; concurrent refresh races are harmless (both fetch, last
# wins). Per-key locks if token churn ever shows up.
_TOKEN_CACHE: dict[tuple[str, str], tuple[str, float]] = {}

_DATA_URI_RE = re.compile(r"^data:(?P<mime>[^;]+)?;base64,(?P<data>.+)$")
# Extracts <loc> from "...<loc>-aiplatform.googleapis.com..." (forgiving).
_URL_LOC_RE = re.compile(r"([a-z0-9-]+)-aiplatform\.googleapis\.com", re.IGNORECASE)
_REGION_OK_RE = re.compile(r"^[a-z0-9-]+$")


# ---------------------------------------------------------------------------
# Module-level helpers (auth, URL building, image, schema)
# ---------------------------------------------------------------------------


def _b64url(raw: bytes) -> str:
    """Base64url-encode without padding (JWT segment encoding)."""

    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _service_account(json_str: str) -> dict[str, Any]:
    """Parse and validate a service-account JSON key string.

    Raises ``ValueError`` with a clear message if the input is not JSON, is not
    an object, is missing required fields, or is not ``type == service_account``.
    """

    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid service-account JSON: {exc.msg}") from exc
    if not isinstance(data, dict):
        raise ValueError("Service-account JSON must be a JSON object.")
    missing = [name for name in _REQUIRED_SA_FIELDS if not data.get(name)]
    if missing:
        raise ValueError(
            "Service-account JSON missing required field(s): " + ", ".join(missing)
        )
    if data.get("type") != "service_account":
        raise ValueError(
            f"Service-account JSON has type={data.get('type')!r}, "
            "expected 'service_account'."
        )
    return data


def _sign_jwt(sa: dict[str, Any]) -> str:
    """Build and RS256-sign a JWT-bearer assertion for ``sa`` (RFC 7523)."""

    header: dict[str, Any] = {"alg": "RS256", "typ": "JWT"}
    if sa.get("private_key_id"):
        header["kid"] = sa["private_key_id"]

    now = int(time.time())
    claims = {
        "iss": sa["client_email"],
        "scope": _OAUTH_SCOPE,
        "aud": sa["token_uri"],
        "iat": now,
        "exp": now + 3600,
    }

    signing_input = (
        _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
        + "."
        + _b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    )

    private_key = load_pem_private_key(sa["private_key"].encode("utf-8"), password=None)
    signature = private_key.sign(
        signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256()
    )
    return signing_input + "." + _b64url(signature)


async def _access_token(api_key: str) -> str:
    """Return a cached OAuth2 access token for the service account, minting one
    via a JWT-bearer grant when missing or about to expire."""

    sa = _service_account(api_key)
    cache_key = (sa["project_id"], sa["client_email"])
    cached = _TOKEN_CACHE.get(cache_key)
    if cached and time.time() < cached[1] - 120:
        return cached[0]

    assertion = _sign_jwt(sa)
    body = {
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(30)) as client:
        resp = await client.post(
            sa["token_uri"],
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if resp.is_error:
        raise RuntimeError(
            f"Failed to mint Vertex access token "
            f"(HTTP {resp.status_code}): {resp.text}"
        )
    token_data = resp.json()
    access_token = token_data["access_token"]
    expires_in = int(token_data.get("expires_in", 3600))
    _TOKEN_CACHE[cache_key] = (access_token, time.time() + expires_in)
    return access_token


def _resolve_location(base_url: str | None) -> str:
    """Derive the Vertex region/location from the ``base_url`` slot.

    Empty → default. A full Vertex URL → extract ``<loc>`` from the subdomain.
    Otherwise treat the trimmed string as the region (validated).
    """

    raw = (base_url or "").strip()
    if not raw:
        return DEFAULT_LOCATION
    match = _URL_LOC_RE.search(raw)
    loc = match.group(1).lower() if match else raw.lower()
    if not _REGION_OK_RE.fullmatch(loc):
        raise ValueError(f"Invalid Vertex region/location: {raw!r}")
    return loc


def _endpoint(
    base_url: str | None, project_id: str, model_id: str, stream: bool
) -> str:
    """Build the Vertex generateContent (or streamGenerateContent) URL.

    Regional locations use ``{loc}-aiplatform.googleapis.com``. The ``global``
    and ``global*`` (e.g. globalus) multi-region locations are served by the
    BARE global host ``aiplatform.googleapis.com`` — a ``global-aiplatform``
    subdomain does not exist, and using one returns Google's HTML 404 (not a
    Vertex JSON error). Many newly-released models (e.g. gemini-3.x previews)
    are global-only, so this must be supported, not rejected.
    """

    location = _resolve_location(base_url)
    host = (
        "aiplatform.googleapis.com"
        if location.startswith("global")
        else f"{location}-aiplatform.googleapis.com"
    )
    base = (
        f"https://{host}/v1beta1/"
        f"projects/{project_id}/locations/{location}/"
        f"publishers/google/models/{model_id}"
    )
    return base + ":streamGenerateContent?alt=sse" if stream else base + ":generateContent"


def _image_to_inline_data(image: RequestImage) -> dict[str, Any]:
    """Convert an internal image to a Vertex ``inlineData``/``fileData`` part.

    Vertex wants RAW base64 in ``inlineData.data`` with ``mimeType`` as a
    sibling — NOT a ``data:`` URI (do not reuse openai_compat's ``_image_to_url``).
    """

    resolved = image.resolved
    uri = resolved.uri if resolved is not None else None

    if uri and uri.startswith("gs://"):
        mime = (resolved.mime_type if resolved is not None else None) or image.mime_type
        return {
            "fileData": {"fileUri": uri, "mimeType": mime or "image/png"}
        }

    if uri and uri.startswith("data:"):
        match = _DATA_URI_RE.match(uri)
        if match:
            return {
                "inlineData": {
                    "mimeType": match.group("mime") or "image/png",
                    "data": match.group("data"),
                }
            }

    # Fallback: read raw bytes from disk and base64-encode.
    path = (
        resolved.path if resolved is not None and resolved.path else image.path
    )
    if path is None:
        raise ValueError(
            f"Image {image.request_image_id} has neither a data/GS URI nor a path."
        )
    mime = (
        (resolved.mime_type if resolved is not None else None)
        or image.mime_type
        or mimetypes.guess_type(path)[0]
        or "application/octet-stream"
    )
    file_path = Path(path).expanduser()
    if not file_path.exists():
        raise FileNotFoundError(f"Image file not found: {file_path}")
    encoded = base64.b64encode(file_path.read_bytes()).decode("ascii")
    return {"inlineData": {"mimeType": mime, "data": encoded}}


def _sanitize_gemini_schema(schema: Any) -> dict[str, Any] | None:
    """Reduce a JSON-Schema node to Gemini's responseSchema subset and map
    ``type`` to UPPERCASE proto enum names (lowercase 400s). Returns ``None``
    if the node cannot be represented."""

    if not isinstance(schema, dict):
        return None

    node: dict[str, Any] = {}

    raw_type = schema.get("type")
    if isinstance(raw_type, str):
        node["type"] = _GEMINI_TYPE_MAP.get(raw_type.lower(), raw_type)
    elif isinstance(raw_type, list):
        # JSON-Schema type arrays (e.g. ["string","null"]): take the first
        # non-null type and mark nullable when null was offered.
        norm = [t for t in raw_type if isinstance(t, str)]
        non_null = [t for t in norm if t.lower() != "null"]
        if non_null:
            first = non_null[0]
            node["type"] = _GEMINI_TYPE_MAP.get(first.lower(), first)
        if any(t.lower() == "null" for t in norm):
            node["nullable"] = True

    if schema.get("description") is not None:
        node["description"] = schema["description"]
    if schema.get("format") is not None:
        node["format"] = schema["format"]
    if schema.get("nullable") is not None:
        node["nullable"] = schema["nullable"]
    if schema.get("enum") is not None:
        node["enum"] = schema["enum"]
    if isinstance(schema.get("required"), list):
        node["required"] = schema["required"]

    if isinstance(schema.get("properties"), dict):
        props: dict[str, Any] = {}
        for name, sub in schema["properties"].items():
            cleaned = _sanitize_gemini_schema(sub)
            if cleaned is not None:
                props[name] = cleaned
        node["properties"] = props

    if schema.get("items") is not None:
        cleaned = _sanitize_gemini_schema(schema["items"])
        if cleaned is not None:
            node["items"] = cleaned

    # Only keep known keys (drop $schema/$id/$ref/title/$defs/...).
    return {k: v for k, v in node.items() if k in _GEMINI_SCHEMA_KEEP} or None


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


class VertexAdapter(BaseAdapter):
    """Vertex AI (Gemini) native adapter — service-account JSON key auth."""

    adapter_id = "vertex"

    # -- discovery / capability -------------------------------------------

    def list_models(self) -> list[str]:
        return list(GEMINI_MODELS)

    async def fetch_models(
        self,
        api_key: str,
        base_url: str | None,
        timeout: int = 30,
    ) -> list[str]:
        # No live discovery (Vertex has no clean OpenAI-style list). Validate
        # the key for early feedback from the Settings "sync" button, then
        # return the static catalog (sorted).
        _service_account(api_key)
        return sorted(GEMINI_MODELS)

    def get_capability(self, model_id: str) -> ProviderCapability:
        return ProviderCapability(
            provider_id="vertex",
            model_id=model_id,
            supports_image=True,
            supports_multi_image=True,
            supports_system_prompt=True,
            supports_json_mode=True,
            supports_strict_json_schema=False,  # responseSchema is close but not OpenAI-strict
            supports_batch_api=False,
            max_images=16,
        )

    # -- build ------------------------------------------------------------

    def build_provider_request(self, request: InternalRequest) -> dict[str, Any]:
        params = request.model.parameters
        sorted_images = sorted(request.images, key=lambda item: item.order)

        parts: list[dict[str, Any]] = []
        if request.user_prompt:
            parts.append({"text": request.user_prompt})
        for image in sorted_images:
            parts.append(_image_to_inline_data(image))
        if not parts:
            parts.append({"text": ""})

        payload: dict[str, Any] = {
            "contents": [{"role": "user", "parts": parts}],
            # Gemini has no `model` body field (it is in the URL). Thread the
            # model id through send/send_stream, which pop it before dispatch.
            # ponytail: __vertex_model survives into the redacted snapshot; it's
            # a model id, not a secret. Cleaner plumbing = override base flow,
            # not worth it.
            "__vertex_model": request.model.model_id,
        }

        if request.system_prompt.strip():
            payload["systemInstruction"] = {"parts": [{"text": request.system_prompt}]}

        gen_config: dict[str, Any] = {}
        if params.temperature is not None:
            gen_config["temperature"] = params.temperature
        if params.top_p is not None:
            gen_config["topP"] = params.top_p
        if params.max_output_tokens is not None:
            gen_config["maxOutputTokens"] = params.max_output_tokens
        if params.stop:
            gen_config["stopSequences"] = params.stop

        self._apply_json_contract(request, gen_config)

        # Only emit thinkingConfig when the user actually configured thinking.
        # Default (enable_thinking=None, no budget) is NEUTRAL — omit entirely.
        # Otherwise every Vertex call forces thought capture (cost/behaviour
        # shift) and Gemini 1.5 — which has no thinkingConfig — would 400.
        if params.enable_thinking is False:
            gen_config["thinkingConfig"] = {"thinkingBudget": 0}
        elif params.enable_thinking is True or params.thinking_budget is not None:
            thinking_config: dict[str, Any] = {"includeThoughts": True}
            if params.thinking_budget is not None:
                thinking_config["thinkingBudget"] = params.thinking_budget
            gen_config["thinkingConfig"] = thinking_config

        if gen_config:
            payload["generationConfig"] = gen_config

        # Shallow passthrough last. NOTE: a provider-supplied `generationConfig`
        # here overrides the whole sub-dict (intended power-user escape hatch).
        if request.model.provider_options:
            payload.update(request.model.provider_options)

        return payload

    def _apply_json_contract(
        self, request: InternalRequest, gen_config: dict[str, Any]
    ) -> None:
        contract = request.output_contract
        if contract.mode == OutputMode.LOOSE_JSON:
            gen_config["responseMimeType"] = "application/json"
        elif contract.mode == OutputMode.STRICT_JSON:
            gen_config["responseMimeType"] = "application/json"
            schema = contract.json_schema
            if schema:
                cleaned = _sanitize_gemini_schema(schema)
                if cleaned:
                    gen_config["responseSchema"] = cleaned
                # ponytail: responseSchema dropped — Gemini schema subset;
                # revisit if strict-shape tasks move to Vertex.

    # -- send / stream ----------------------------------------------------

    async def send(
        self,
        provider_request: dict[str, Any],
        api_key: str,
        base_url: str | None,
        timeout: int,
    ) -> httpx.Response:
        payload = dict(provider_request)
        model_id = payload.pop("__vertex_model", "")
        sa = _service_account(api_key)
        url = _endpoint(base_url, sa["project_id"], model_id, stream=False)
        token = await _access_token(api_key)
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            return await client.post(url, headers=headers, json=payload)

    async def stream(
        self,
        provider_request: dict[str, Any],
        api_key: str,
        base_url: str | None,
        timeout: int,
    ) -> AsyncIterator[StreamEvent]:
        async for event in self.send_stream(provider_request, api_key, base_url, timeout):
            yield event

    async def send_stream(
        self,
        provider_request: dict[str, Any],
        api_key: str,
        base_url: str | None,
        timeout: int,
    ) -> AsyncIterator[StreamEvent]:
        payload = dict(provider_request)
        model_id = payload.pop("__vertex_model", "")
        payload.pop("stream", None)  # CRITICAL — base injects stream=True; Vertex rejects it
        sa = _service_account(api_key)
        url = _endpoint(base_url, sa["project_id"], model_id, stream=True)
        token = await _access_token(api_key)
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client, client.stream(
                "POST", url, headers=headers, json=payload
            ) as response:
                if response.is_error:
                    await response.aread()
                    err = self.normalize_error(response=response, exception=None)
                    yield StreamEvent(event="error", error=err.model_dump(mode="json"))
                    return
                async for event in self._events_from_sse_lines(response.aiter_lines()):
                    yield event
        except Exception as exc:
            err = self.normalize_error(response=None, exception=exc)
            yield StreamEvent(event="error", error=err.model_dump(mode="json"))

    async def _events_from_sse_lines(
        self,
        lines: AsyncIterator[str],
    ) -> AsyncIterator[StreamEvent]:
        finish_reason: str | None = None

        async for line in lines:
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            data_text = line[len("data:") :].strip()
            if not data_text:
                continue

            try:
                data = json.loads(data_text)
            except json.JSONDecodeError as exc:
                yield StreamEvent(
                    event="error",
                    error={
                        "type": ErrorType.PROVIDER_ERROR.value,
                        "message": f"Invalid streaming JSON chunk: {exc}",
                        "retryable": False,
                        "raw_error": {"chunk": data_text},
                    },
                )
                return

            if not isinstance(data, dict):
                continue

            usage = data.get("usageMetadata")
            if isinstance(usage, dict) and usage:
                yield StreamEvent(event="usage", usage=usage)

            prompt_feedback = data.get("promptFeedback")
            if isinstance(prompt_feedback, dict) and prompt_feedback.get("blockReason"):
                yield StreamEvent(
                    event="error",
                    error={
                        "type": ErrorType.SAFETY_BLOCKED.value,
                        "message": f"Prompt blocked: {prompt_feedback.get('blockReason')}",
                        "retryable": False,
                        "raw_error": prompt_feedback,
                    },
                )
                return

            candidates = data.get("candidates")
            if not isinstance(candidates, list):
                continue
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                fr = candidate.get("finishReason")
                if isinstance(fr, str) and fr:
                    finish_reason = fr
                content = candidate.get("content")
                parts = content.get("parts") if isinstance(content, dict) else None
                if not isinstance(parts, list):
                    continue
                for part in parts:
                    if not isinstance(part, dict):
                        continue
                    text = part.get("text")
                    if not isinstance(text, str) or not text:
                        continue
                    if part.get("thought") is True:
                        yield StreamEvent(event="reasoning", delta=text)
                    else:
                        yield StreamEvent(event="content", delta=text)

        yield StreamEvent(event="done", finish_reason=finish_reason)

    # -- parse ------------------------------------------------------------

    def parse_response(
        self, response: httpx.Response, request: InternalRequest
    ) -> AdapterResult:
        data = response.json()

        prompt_feedback = data.get("promptFeedback")
        if isinstance(prompt_feedback, dict) and prompt_feedback.get("blockReason"):
            block_reason = prompt_feedback.get("blockReason")
            return AdapterResult(
                status=AttemptStatus.BLOCKED,
                usage=self._usage_with_image_count(data, request),
                normalized_response=NormalizedResponse(
                    text="",
                    finish_reason=None,
                    safety=SafetyInfo(
                        blocked=True, categories=[block_reason], raw=data
                    ),
                ),
                error=NormalizedError(
                    type=ErrorType.SAFETY_BLOCKED,
                    message=f"Prompt blocked: {block_reason}",
                    retryable=False,
                    raw_error=data,
                ),
            )

        candidates = data.get("candidates") or []
        if not candidates:
            return AdapterResult(
                status=AttemptStatus.FAILED,
                usage=self._usage_with_image_count(data, request),
                error=NormalizedError(
                    type=ErrorType.EMPTY_RESPONSE,
                    message="Vertex response contained no candidates.",
                    retryable=False,
                    raw_error=data,
                ),
            )

        first = candidates[0] if isinstance(candidates[0], dict) else {}
        parts = (first.get("content") or {}).get("parts") or []
        text = "".join(
            part.get("text", "")
            for part in parts
            if isinstance(part, dict)
            and part.get("thought") is not True
            and isinstance(part.get("text"), str)
        )
        reasoning_text = (
            "".join(
                part.get("text", "")
                for part in parts
                if isinstance(part, dict)
                and part.get("thought") is True
                and isinstance(part.get("text"), str)
            )
            or None
        )
        finish_reason = first.get("finishReason")
        blocked = (
            isinstance(finish_reason, str) and finish_reason in _BLOCKED_FINISH_REASONS
        )

        if blocked:
            return AdapterResult(
                status=AttemptStatus.BLOCKED,
                usage=self._usage_with_image_count(data, request),
                normalized_response=NormalizedResponse(
                    text=text,
                    finish_reason=finish_reason,
                    reasoning_text=reasoning_text,
                    safety=SafetyInfo(
                        blocked=True, categories=[finish_reason], raw=first
                    ),
                ),
                error=NormalizedError(
                    type=ErrorType.SAFETY_BLOCKED,
                    message=f"Response blocked by Vertex (finishReason={finish_reason}).",
                    retryable=False,
                    raw_error=first,
                ),
            )

        return AdapterResult(
            status=AttemptStatus.SUCCEEDED,
            normalized_response=NormalizedResponse(
                text=text,
                finish_reason=finish_reason,
                reasoning_text=reasoning_text,
                safety=SafetyInfo(),
            ),
            usage=self._usage_with_image_count(data, request),
        )

    def parse_usage(self, response_data: dict[str, Any]) -> Usage:
        metadata: dict[str, Any] = {}
        if isinstance(response_data, dict):
            usage_metadata = response_data.get("usageMetadata")
            usage = response_data.get("usage")
            if isinstance(usage_metadata, dict):
                metadata = usage_metadata
            elif isinstance(usage, dict):
                metadata = usage

        input_tokens = int(metadata.get("promptTokenCount") or 0)
        output_tokens = int(metadata.get("candidatesTokenCount") or 0)
        total_tokens = int(
            metadata.get("totalTokenCount") or (input_tokens + output_tokens)
        )
        cached = metadata.get("cachedContentTokenCount")
        cached_input_tokens = int(cached) if cached is not None else None

        # Gemini bills thoughtsTokenCount at the OUTPUT price, but it is EXCLUDED
        # from candidatesTokenCount (output_tokens). Surface it for display and
        # fold it into the billable output count so thinking is actually billed.
        thoughts = metadata.get("thoughtsTokenCount")
        reasoning_tokens = int(thoughts) if thoughts is not None else None
        billable_output_tokens = (
            output_tokens + reasoning_tokens if reasoning_tokens else None
        )

        return Usage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            image_count=0,
            cached_input_tokens=cached_input_tokens,
            reasoning_tokens=reasoning_tokens,
            billable_output_tokens=billable_output_tokens,
            provider_reported=bool(metadata),
            estimated=not bool(metadata),
            raw_usage=metadata or None,
        )

    def _usage_with_image_count(
        self, response_data: dict[str, Any], request: InternalRequest
    ) -> Usage:
        usage = self.parse_usage(response_data)
        usage.image_count = len(request.images)
        if usage.image_tokens is None:
            image_pixels = 0
            for image in request.images:
                resolved = image.resolved
                if resolved and resolved.width and resolved.height:
                    image_pixels += resolved.width * resolved.height
            usage.image_tokens = image_pixels or None
        return usage

    # -- error normalization ---------------------------------------------

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
            return NormalizedError(
                type=ErrorType.UNKNOWN_ERROR, message="Unknown provider error."
            )

        raw_error = self._error_body(response)
        message = self._error_message(raw_error) or response.reason_phrase
        status = response.status_code
        if status in {401, 403}:
            error_type, retryable = ErrorType.AUTH_ERROR, False
        elif status == 429:
            error_type, retryable = ErrorType.RATE_LIMIT, True
        elif status == 408:
            error_type, retryable = ErrorType.TIMEOUT, True
        elif 500 <= status <= 599:
            error_type, retryable = ErrorType.PROVIDER_ERROR, False
        elif 400 <= status <= 499:
            error_type, retryable = ErrorType.INVALID_REQUEST, False
        else:
            error_type, retryable = ErrorType.UNKNOWN_ERROR, False

        return NormalizedError(
            type=error_type,
            message=message,
            provider_error_code=str(status),
            retryable=retryable,
            raw_error=raw_error,
        )

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
            if message is None and isinstance(error.get("error"), dict):
                # Some Google error bodies nest twice: {"error":{"error":{...}}}
                message = error["error"].get("message")
            if message is not None:
                return str(message)
            status = error.get("status")
            return str(status) if status is not None else None
        if isinstance(error, str):
            return error
        body = raw_error.get("body")
        return str(body) if body else None
