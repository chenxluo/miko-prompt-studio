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
                provider_request_snapshot=snapshot
                or self.redact_provider_request(provider_request)
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
                provider_request_snapshot=snapshot
                or self.redact_provider_request(provider_request)
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
        """Return a request snapshot with credential-looking values redacted."""

        if provider_request is None:
            return None
        redacted = copy.deepcopy(provider_request)
        self._redact_mapping(redacted)
        return redacted

    def _redact_mapping(self, value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                lowered = str(key).lower()
                if lowered in {"authorization", "api_key", "apikey", "x-api-key"}:
                    value[key] = self._redact_secret(str(item))
                elif isinstance(item, str) and item.startswith("sk-"):
                    value[key] = "sk-***"
                else:
                    self._redact_mapping(item)
        elif isinstance(value, list):
            for item in value:
                self._redact_mapping(item)

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
