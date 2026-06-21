"""Application-level exceptions and error helpers."""

from __future__ import annotations

from app.schemas.common import ErrorType, NormalizedError


class AppError(Exception):
    """Base exception for all application errors."""

    def __init__(self, message: str, error_type: ErrorType = ErrorType.UNKNOWN_ERROR):
        super().__init__(message)
        self.message = message
        self.error_type = error_type

    def to_normalized(self) -> NormalizedError:
        return NormalizedError(
            type=self.error_type,
            message=self.message,
            retryable=self.error_type in _RETRYABLE,
        )


_RETRYABLE = frozenset(
    {ErrorType.RATE_LIMIT, ErrorType.TIMEOUT, ErrorType.NETWORK_ERROR}
)


class ValidationError(AppError):
    def __init__(self, message: str):
        super().__init__(message, ErrorType.INVALID_REQUEST)


class ProviderError(AppError):
    def __init__(self, message: str, provider_code: str | None = None):
        super().__init__(message, ErrorType.PROVIDER_ERROR)
        self.provider_code = provider_code


class AuthError(AppError):
    def __init__(self, message: str = "Authentication failed"):
        super().__init__(message, ErrorType.AUTH_ERROR)


class RateLimitError(AppError):
    def __init__(self, message: str = "Rate limit exceeded"):
        super().__init__(message, ErrorType.RATE_LIMIT)


class TimeoutError(AppError):
    def __init__(self, message: str = "Request timed out"):
        super().__init__(message, ErrorType.TIMEOUT)


class NetworkError(AppError):
    def __init__(self, message: str = "Network error"):
        super().__init__(message, ErrorType.NETWORK_ERROR)


class CapabilityError(AppError):
    def __init__(self, message: str):
        super().__init__(message, ErrorType.UNSUPPORTED_CAPABILITY)


class SafetyBlockedError(AppError):
    def __init__(self, message: str = "Content was blocked by safety filters"):
        super().__init__(message, ErrorType.SAFETY_BLOCKED)


class EmptyResponseError(AppError):
    def __init__(self, message: str = "Provider returned an empty response"):
        super().__init__(message, ErrorType.EMPTY_RESPONSE)
