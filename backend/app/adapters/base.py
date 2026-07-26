"""Base provider adapter interface and shared execution helpers."""

from __future__ import annotations

import copy
import time
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import httpx

from app.schemas.common import AttemptStatus, ErrorType, NormalizedError
from app.schemas.internal_request import InternalRequest
from app.schemas.model_config import ProviderCapability
from app.schemas.run_record import AdapterResult, NormalizedResponse, SafetyInfo, StreamEvent, Usage


class BaseAdapter(ABC):
    """Abstract base class for provider adapters.

    Adapters convert an :class:`InternalRequest` into a provider-specific HTTP
    payload, dispatch it, and normalize the provider response into an
    :class:`AdapterResult`.
    """

    adapter_id: str

    @abstractmethod
    def list_models(self) -> list[str]:
        """Return model IDs supported by this adapter (static catalog)."""

    async def fetch_models(
        self,
        api_key: str,
        base_url: str | None,
        timeout: int = 30,
    ) -> list[str]:
        """Fetch the live model list from the provider's ``/v1/models`` endpoint.

        Subclasses can override this for non-standard discovery APIs.
        Returns an empty list if the adapter does not support discovery.
        """

        return []

    @abstractmethod
    def get_capability(self, model_id: str) -> ProviderCapability:
        """Return capability metadata for a model."""

    @abstractmethod
    def build_provider_request(self, request: InternalRequest) -> dict[str, Any]:
        """Convert an internal request into a provider-specific JSON payload."""

    @abstractmethod
    async def send(
        self,
        provider_request: dict[str, Any],
        api_key: str,
        base_url: str | None,
        timeout: int,
    ) -> httpx.Response:
        """Send the provider request and return the raw HTTP response."""

    @abstractmethod
    async def stream(
        self,
        provider_request: dict[str, Any],
        api_key: str,
        base_url: str | None,
        timeout: int,
    ) -> AsyncIterator[StreamEvent]:
        """Send the provider request and yield normalized streaming events."""

    @abstractmethod
    def parse_response(self, response: httpx.Response, request: InternalRequest) -> AdapterResult:
        """Normalize a successful provider response."""

    @abstractmethod
    def parse_usage(self, response_data: dict[str, Any]) -> Usage:
        """Extract usage information from provider response data."""

    @abstractmethod
    def normalize_error(
        self,
        response: httpx.Response | None,
        exception: Exception | None,
    ) -> NormalizedError:
        """Convert provider HTTP errors or client exceptions to a normalized error."""

    def _enforce_image_limit(self, request: InternalRequest) -> AdapterResult | None:
        """Return a failed AdapterResult when the request exceeds the model's
        ``max_images`` capability. Runs before build/send/stream so we never
        reach the network. ``max_images=None`` means unknown/unlimited."""

        capability = self.get_capability(request.model.model_id)
        max_images = capability.max_images
        if max_images is None:
            return None
        actual = len(request.images)
        if actual <= max_images:
            return None
        # ponytail: single error type covers all "too many images" aborts;
        # we never call build/send/stream here by construction.
        error = NormalizedError(
            type=ErrorType.UNSUPPORTED_CAPABILITY,
            message=(
                f"Model {request.model.model_id!r} accepts at most "
                f"{max_images} images per request, got {actual}."
            ),
            retryable=False,
        )
        return AdapterResult(
            status=AttemptStatus.FAILED,
            error=error,
        )

    async def execute(
        self,
        request: InternalRequest,
        api_key: str,
        base_url: str | None = None,
        timeout: int = 120,
    ) -> AdapterResult:
        """Build, send, parse, and normalize a single provider API call."""

        started = time.perf_counter()
        provider_request: dict[str, Any] | None = None
        snapshot: dict[str, Any] | None = None

        try:
            blocked = self._enforce_image_limit(request)
            if blocked is not None:
                return blocked
            provider_request = self.build_provider_request(request)
            snapshot = self.redact_provider_request(provider_request)
            response = await self.send(provider_request, api_key, base_url, timeout)

            if response.is_error:
                error = self.normalize_error(response=response, exception=None)
                return AdapterResult(
                    status=self._status_from_error(error),
                    error=error,
                    latency_ms=self._elapsed_ms(started),
                    provider_request_snapshot=snapshot,
                    provider_response_raw=self._response_snapshot(response),
                )

            result = self.parse_response(response, request)
            result.latency_ms = result.latency_ms or self._elapsed_ms(started)
            result.provider_request_snapshot = result.provider_request_snapshot or snapshot
            result.provider_response_raw = result.provider_response_raw or self._response_snapshot(
                response
            )
            return result
        except Exception as exc:
            error = self.normalize_error(response=None, exception=exc)
            return AdapterResult(
                status=self._status_from_error(error),
                error=error,
                latency_ms=self._elapsed_ms(started),
                provider_request_snapshot=snapshot or self.redact_provider_request(provider_request)
                if provider_request is not None
                else None,
            )

    async def execute_stream(
        self,
        request: InternalRequest,
        api_key: str,
        base_url: str | None = None,
        timeout: int = 120,
        on_event: Callable[[StreamEvent], Awaitable[None]] | None = None,
    ) -> AdapterResult:
        """Build, stream, accumulate, and normalize a provider API call."""

        started = time.perf_counter()
        provider_request: dict[str, Any] | None = None
        snapshot: dict[str, Any] | None = None

        try:
            blocked = self._enforce_image_limit(request)
            if blocked is not None:
                return blocked
            provider_request = self.build_provider_request(request)
            provider_request["stream"] = True
            snapshot = self.redact_provider_request(provider_request)
            return await self._result_from_stream_events(
                self.stream(provider_request, api_key, base_url, timeout),
                request=request,
                started=started,
                provider_request_snapshot=snapshot,
                on_event=on_event,
            )
        except Exception as exc:
            error = self.normalize_error(response=None, exception=exc)
            return AdapterResult(
                status=self._status_from_error(error),
                error=error,
                latency_ms=self._elapsed_ms(started),
                provider_request_snapshot=snapshot or self.redact_provider_request(provider_request)
                if provider_request is not None
                else None,
            )

    async def _result_from_stream_events(
        self,
        events: AsyncIterator[StreamEvent],
        request: InternalRequest,
        started: float | None = None,
        provider_request_snapshot: dict[str, Any] | None = None,
        on_event: Callable[[StreamEvent], Awaitable[None]] | None = None,
    ) -> AdapterResult:
        reasoning_parts: list[str] = []
        content_parts: list[str] = []
        raw_usage: dict[str, Any] | None = None
        stream_error: NormalizedError | None = None
        finish_reason: str | None = None

        async for event in events:
            if on_event is not None:
                await on_event(event)

            if event.event == "reasoning" and event.delta:
                reasoning_parts.append(event.delta)
            elif event.event == "content" and event.delta:
                content_parts.append(event.delta)
            elif event.event == "usage" and event.usage:
                raw_usage = event.usage
            elif event.event == "done" and event.finish_reason:
                finish_reason = event.finish_reason
            elif event.event == "error":
                stream_error = self._stream_error_to_normalized(event.error)
                break

        usage = self._usage_from_stream(raw_usage, request)
        text = "".join(content_parts)
        reasoning_text = "".join(reasoning_parts) or None

        # Check finish_reason for truncation / content filter
        if stream_error is None and finish_reason:
            if finish_reason == "content_filter":
                stream_error = NormalizedError(
                    type=ErrorType.SAFETY_BLOCKED,
                    message="Response was blocked by content filter.",
                    retryable=False,
                )
            elif finish_reason == "length":
                stream_error = NormalizedError(
                    type=ErrorType.PROVIDER_ERROR,
                    message="Response was truncated due to max token limit.",
                    retryable=False,
                )

        status = (
            AttemptStatus.SUCCEEDED
            if stream_error is None
            else self._status_from_error(stream_error)
        )

        return AdapterResult(
            status=status,
            normalized_response=NormalizedResponse(
                text=text,
                finish_reason=finish_reason,
                reasoning_text=reasoning_text,
                safety=SafetyInfo(),
            )
            if stream_error is None or text or reasoning_text
            else None,
            usage=usage,
            error=stream_error,
            latency_ms=self._elapsed_ms(started) if started is not None else None,
            provider_request_snapshot=provider_request_snapshot,
            provider_response_raw={
                "stream": True,
                "usage": raw_usage,
                "finish_reason": finish_reason,
            },
        )

    def _usage_from_stream(
        self,
        raw_usage: dict[str, Any] | None,
        request: InternalRequest,
    ) -> Usage:
        usage = self.parse_usage({"usage": raw_usage or {}})
        usage.image_count = len(request.images)
        if usage.image_tokens is None:
            image_pixels = 0
            for image in request.images:
                resolved = image.resolved
                if resolved and resolved.width and resolved.height:
                    image_pixels += resolved.width * resolved.height
            usage.image_tokens = image_pixels or None
        return usage

    def _stream_error_to_normalized(
        self,
        error_data: dict[str, Any] | None,
    ) -> NormalizedError:
        if not error_data:
            return NormalizedError(
                type=ErrorType.UNKNOWN_ERROR,
                message="Unknown streaming provider error.",
                retryable=False,
            )
        try:
            return NormalizedError(**error_data)
        except Exception:
            message = error_data.get("message") or error_data.get("detail") or str(error_data)
            return NormalizedError(
                type=ErrorType.UNKNOWN_ERROR,
                message=str(message),
                retryable=False,
                raw_error=error_data,
            )

    def redact_provider_request(
        self, provider_request: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        """Return a request snapshot with sensitive values redacted.

        Scrubs: bearer/API keys (``Authorization``, ``api_key``, ``sk-...``),
        raw image base64 payloads (``data:...;base64,...`` URIs, ``b64_json``
        blobs, large inline base64 strings) and URL query strings so secrets
        embedded as ``?token=...`` / ``?signature=...`` parameters never land
        in the snapshot. The outgoing ``provider_request`` is NOT mutated —
        only the returned deep-copy.
        """

        if provider_request is None:
            return None
        redacted = copy.deepcopy(provider_request)
        self._redact_mapping(redacted)
        return redacted

    @staticmethod
    def redact_internal_request_snapshot(
        internal_request: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        """Return a redacted copy of an InternalRequest-shaped snapshot.

        Persists the same shape as :meth:`redact_provider_request` but
        tailored to ``RunItem.internal_request_snapshot``: the
        ``images[*].resolved.uri`` and ``images[*].source_uri`` ``data:`` URI
        base64 is stripped, and signed URL queries are removed from both
        fields. Source URL path/host remain observable so reviewers can still
        see what was referenced.
        The original dict is NOT mutated. Lives on the base class so any
        ``BaseAdapter`` subclass — including legacy fakes — gets it without
        needing new methods.
        """
        if internal_request is None:
            return None
        redacted = copy.deepcopy(internal_request)
        for image in redacted.get("images") or []:
            if not isinstance(image, dict):
                continue
            resolved = image.get("resolved")
            if isinstance(resolved, dict):
                uri = resolved.get("uri")
                if isinstance(uri, str) and uri.startswith("data:") and ";base64," in uri:
                    resolved["uri"] = BaseAdapter._redact_data_uri(uri)
                elif (
                    isinstance(uri, str)
                    and "?" in uri
                    and ("://" in uri or uri.startswith(("http", "gs://")))
                ):
                    # Direct ``resolved.uri`` for gs/http(s) duplicates the
                    # signed query — strip it from the snapshot too.
                    image_resolved_uri = uri
                    resolved["uri"] = BaseAdapter._redact_url_query(image_resolved_uri)
            source_uri = image.get("source_uri")
            if (
                isinstance(source_uri, str)
                and source_uri.startswith("data:")
                and ";base64," in source_uri
            ):
                image["source_uri"] = BaseAdapter._redact_data_uri(source_uri)
            elif (
                isinstance(source_uri, str)
                and "?" in source_uri
                and ("://" in source_uri or source_uri.startswith(("http", "gs://")))
            ):
                image["source_uri"] = BaseAdapter._redact_url_query(source_uri)
        return redacted

    def _redact_mapping(
        self, value: Any, parent_key: str | None = None, sibling_mime: str | None = None
    ) -> None:
        if isinstance(value, dict):
            mime_hint = self._sibling_mime(value, sibling_mime)
            for key, item in value.items():
                if isinstance(item, str):
                    value[key] = self._redact_string(str(key).lower(), item, mime_hint)
                else:
                    self._redact_mapping(item, str(key).lower(), mime_hint)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                if isinstance(item, str):
                    value[index] = self._redact_string(parent_key, item, sibling_mime)
                else:
                    self._redact_mapping(item, None, sibling_mime)

    @staticmethod
    def _sibling_mime(value: dict[str, Any], fallback: str | None) -> str | None:
        """Pick up a ``mimeType`` / ``mime_type`` hint from a sibling dict so
        short ``data:...;base64,...`` payloads (which can be <256 chars) still
        get redacted when their context is an image part."""
        for key in ("mimeType", "mime_type"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate:
                return candidate
        return fallback

    def _redact_string(self, key: str | None, text: str, sibling_mime: str | None = None) -> str:
        if not text:
            return text
        normalized_key = (key or "").lower()
        # Bearer / sk- API tokens always win.
        if text.lower().startswith("bearer "):
            return "Bearer sk-***"
        if text.startswith("sk-"):
            return "sk-***"
        # Any ``data:...;base64,...`` string is an inline image payload;
        # scrub it unconditionally regardless of key name or length.
        if text.startswith("data:") and ";base64," in text:
            return self._redact_data_uri(text)
        # Image base64 by dict key — length-agnostic, catches short payloads.
        if normalized_key in {"data", "b64_json"} and self._looks_like_image_payload(
            text, sibling_mime
        ):
            return f"<redacted {len(text)}-char image base64>"
        # ``b64_json`` OpenAI image-gen entries are always image blobs.
        if normalized_key == "b64_json":
            return f"<redacted {len(text)}-char b64_json>"
        # URL query strings carry signed-access tokens (GCS, S3 pre-sign,
        # CDN signatures). Strip them so secrets never land in the snapshot.
        if "?" in text and ("://" in text or text.startswith(("http", "gs://"))):
            return self._redact_url_query(text)
        return text

    @staticmethod
    def _looks_like_image_payload(text: str, sibling_mime: str | None) -> bool:
        """True when ``text`` is almost certainly an encoded image body."""
        if not text:
            return False
        # data: URI image payload.
        if text.startswith("data:image/"):
            return True
        # Sibling says it's an image part.
        if sibling_mime and sibling_mime.lower().startswith("image/"):
            return True
        # Otherwise, treat as image data only if it looks like raw base64 with
        # enough length to be a real blob — short tokens (e.g. ``"AAA"``)
        # aren't worth scrubbing on a generic ``data`` key.
        if len(text) < 256 or len(text) > 5_000_000:
            return False
        import re

        return bool(re.fullmatch(r"[A-Za-z0-9+/=\s]+", text))

    @staticmethod
    def _redact_data_uri(text: str) -> str:
        head, _, payload = text.partition(";base64,")
        return f"{head};base64,<redacted {len(payload)}-char base64>"

    @staticmethod
    def _redact_url_query(text: str) -> str:
        scheme_split = text.split("://", 1)
        if len(scheme_split) != 2:
            return text
        scheme, rest = scheme_split
        path, _, query = rest.partition("?")
        if not query:
            return text
        return f"{scheme}://{path}?<redacted query>"

    def _redact_secret(self, value: str) -> str:
        if value.lower().startswith("bearer "):
            return "Bearer sk-***"
        if value.startswith("sk-"):
            return "sk-***"
        return "***"

    def _response_snapshot(self, response: httpx.Response) -> dict[str, Any]:
        try:
            body: Any = response.json()
        except ValueError:
            body = response.text
        return {
            "status_code": response.status_code,
            "headers": dict(response.headers),
            "body": body,
        }

    def _elapsed_ms(self, started: float) -> int:
        return round((time.perf_counter() - started) * 1000)

    def _status_from_error(self, error: NormalizedError) -> AttemptStatus:
        if error.type == ErrorType.TIMEOUT:
            return AttemptStatus.TIMEOUT
        if error.type == ErrorType.RATE_LIMIT:
            return AttemptStatus.RATE_LIMITED
        if error.type == ErrorType.SAFETY_BLOCKED:
            return AttemptStatus.BLOCKED
        return AttemptStatus.FAILED
