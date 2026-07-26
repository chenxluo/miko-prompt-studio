"""Download remote images referenced by ImageRef.uri into the local uploads dir.

Centralizes the download/cache/validate logic so both the
``POST /api/upload/image-url`` endpoint and the Lab / batch / compare
sample-materialization path share one hardened implementation.

Security posture:
- Only ``http`` / ``https`` schemes are accepted.
- Each URL (initial + every redirect hop) has its hostname resolved and the
  resulting IP checked against a deny list of loopback / private / link-local
  ranges. Redirects are followed manually so every hop is re-validated.
- Response body is bounded by ``max_bytes`` and streamed to disk so a hostile
  server cannot exhaust memory.
- The downloaded bytes are validated as an image (PIL ``Image.verify``) before
  being committed to the uploads directory. Any failure cleans up the
  partial temp file.
- Files are cached by URL hash; a repeat hit for the same URL returns the
  already-persisted file without re-downloading (extension-agnostic so JPEG
  vs PNG formats both hit the same cache slot).

The helper returns a plain dict shaped exactly like ``UploadImageResponse``
so the HTTP endpoint and the in-process materializer both see the same
contract.
"""

from __future__ import annotations

import hashlib
import ipaddress
import mimetypes
import socket
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse
from uuid import uuid4

import httpx
from PIL import Image, UnidentifiedImageError

DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_MAX_BYTES = 25 * 1024 * 1024  # 25 MiB

# Anything in these families must never be reached by an outgoing fetch.
_DENY_NETWORKS = [
    # Loopback ranges — never reach localhost / ::1 directly or via redirect.
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    # Private IPv4 / IPv6 (RFC 1918, 4193, 6598).
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::/128"),
    # Carrier-grade NAT — included to keep desktop LANs/ISPs out.
    ipaddress.ip_network("100.64.0.0/10"),
]


class RemoteImageError(ValueError):
    """Raised when a remote image cannot be materialized safely."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _is_blocked_ip(ip: ipaddress._BaseAddress) -> bool:
    return any(ip in net for net in _DENY_NETWORKS)


def _validate_target(url: str) -> str:
    """Return the URL string after scheme/host checks, or raise."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise RemoteImageError(
            "invalid_scheme", f"Only http/https URLs are allowed: {parsed.scheme!r}"
        )
    hostname = parsed.hostname
    if not hostname:
        raise RemoteImageError("invalid_host", "URL is missing a hostname.")
    # Resolve once and check every returned address. ``getaddrinfo`` may hand
    # back multiple records for round-robin / dual-stack hosts.
    try:
        infos = socket.getaddrinfo(
            hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
        )
    except socket.gaierror as exc:
        raise RemoteImageError("dns_failed", f"Could not resolve {hostname}: {exc}") from exc
    addresses: set[str] = set()
    for info in infos:
        sockaddr = info[4]
        if sockaddr:
            addresses.add(sockaddr[0])
    if not addresses:
        raise RemoteImageError("dns_failed", f"Could not resolve hostname: {hostname}")
    for raw in addresses:
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError as exc:  # pragma: no cover - never happens for real hosts
            raise RemoteImageError("dns_failed", f"Unparseable resolved address: {raw}") from exc
        if _is_blocked_ip(ip):
            raise RemoteImageError(
                "blocked_address",
                f"Refusing to fetch {hostname} (resolved to {ip}); "
                "private/loopback destinations are not allowed.",
            )
    return url


def _guess_extension(mime_type: str | None) -> str:
    if mime_type:
        ext = mimetypes.guess_extension(mime_type.split(";")[0].strip())
        if ext:
            return ext
    return ".png"


def _cache_digest(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def _cache_path_for(url: str, mime_type: str | None, uploads_dir: Path) -> Path:
    return uploads_dir / f"{_cache_digest(url)}{_guess_extension(mime_type)}"


def _find_cached(uploads_dir: Path, digest: str) -> Path | None:
    """Return any cached file whose name starts with ``digest`` regardless of
    extension — a JPEG cached as ``<digest>.jpg`` should hit the same lookup
    that would otherwise default to ``<digest>.png``."""
    if not uploads_dir.exists():
        return None
    for candidate in uploads_dir.iterdir():
        if candidate.is_file() and candidate.stem == digest:
            return candidate
    return None


def _existing_cached(candidate: Path) -> dict[str, Any] | None:
    """Return the cached metadata if ``candidate`` already exists and is an image."""
    if not candidate.exists() or not candidate.is_file():
        return None
    try:
        data = candidate.read_bytes()
    except OSError:
        return None
    detected_format: str | None = None
    try:
        with Image.open(candidate) as opened:
            opened.verify()
            detected_format = opened.format
    except (UnidentifiedImageError, OSError, ValueError):
        return None
    mime_type = Image.MIME.get(detected_format) or "image/png"
    return {
        "path": str(candidate),
        "filename": candidate.name,
        "mime_type": mime_type,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "url": f"/api/uploads/{candidate.name}",
    }


def _validate_image_bytes(data: bytes) -> str:
    """Return the detected mime type, or raise ``RemoteImageError``."""
    try:
        from io import BytesIO

        with Image.open(BytesIO(data)) as opened:
            opened.verify()
            fmt = opened.format
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise RemoteImageError(
            "not_an_image", f"Downloaded content is not a valid image: {exc}"
        ) from exc
    return Image.MIME.get(fmt) or "image/png"


async def materialize_url_image(
    url: str,
    uploads_dir: Path,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_bytes: int = DEFAULT_MAX_BYTES,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Download ``url`` into ``uploads_dir`` and return an UploadImageResponse-shaped dict.

    A repeat call for the same URL reuses the existing cached file. Raises
    :class:`RemoteImageError` on any failure; the error's ``code`` is suitable
    for surfacing in HTTP responses (400/415/422).
    """
    if not isinstance(url, str) or not url.strip():
        raise RemoteImageError("invalid_url", "URL must be a non-empty string.")
    url = url.strip()

    uploads_dir.mkdir(parents=True, exist_ok=True)

    # Cache key is the URL itself; first attempt to reuse an existing file.
    # Extension-agnostic so a JPEG cached from an earlier run still hits.
    cached_path = _find_cached(uploads_dir, _cache_digest(url))
    if cached_path is not None:
        cached = _existing_cached(cached_path)
        if cached is not None:
            return cached

    # Manual redirect walk — every hop is re-validated against the SSRF deny list.
    current_url = _validate_target(url)
    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=timeout),
            follow_redirects=False,
            headers={"User-Agent": "miko-prompt-studio/1.0"},
        )
    try:
        for _ in range(6):  # cap the chain length like most browsers do
            try:
                async with client.stream("GET", current_url) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            raise RemoteImageError(
                                "redirect_failed",
                                "Redirect response missing Location header.",
                            )
                        # Resolve relative redirects against the previous URL.
                        next_url = urljoin(current_url, location)
                        current_url = _validate_target(next_url)
                        continue

                    if response.status_code >= 400:
                        # Drain to keep the connection healthy, then raise.
                        async for _ in response.aiter_raw():
                            pass
                        raise RemoteImageError(
                            "http_error",
                            f"Remote image fetch failed with status {response.status_code}.",
                        )

                    # Reject non-image content types before touching the body.
                    declared_mime = (
                        response.headers.get("content-type", "").split(";")[0].strip().lower()
                    )
                    if declared_mime and not declared_mime.startswith("image/"):
                        raise RemoteImageError(
                            "not_an_image",
                            "Remote URL did not return an image "
                            f"(Content-Type: {declared_mime!r}).",
                        )

                    # Stream into a temp file while enforcing the size cap.
                    # Use a sibling temp path so a successful move avoids a copy.
                    temp_path = uploads_dir / f".{uuid4().hex}.part"
                    total = 0
                    try:
                        with temp_path.open("wb") as out:
                            # ``httpx.MockTransport`` returns fully-buffered
                            # responses, which raise ``StreamConsumed`` from
                            # ``aiter_raw()``. Fall back to ``response.content``
                            # for that path; real HTTP still streams chunk by
                            # chunk and the cap is enforced incrementally.
                            try:
                                async for chunk in response.aiter_raw():
                                    if not chunk:
                                        continue
                                    total += len(chunk)
                                    if total > max_bytes:
                                        raise RemoteImageError(
                                            "too_large",
                                            f"Remote image exceeds the {max_bytes} byte limit.",
                                        )
                                    out.write(chunk)
                            except httpx.StreamConsumed:
                                # Buffered path: enforce the cap once and bail
                                # out by raising before we ever touch the disk.
                                buffered = response.content
                                if len(buffered) > max_bytes:
                                    raise RemoteImageError(
                                        "too_large",
                                        f"Remote image exceeds the {max_bytes} byte limit.",
                                    ) from None
                                total = len(buffered)
                                out.write(buffered)

                        # Confirm it really is an image before promoting the file.
                        mime = _validate_image_bytes(temp_path.read_bytes())
                        target = _cache_path_for(url, mime, uploads_dir)
                        try:
                            temp_path.replace(target)
                            final_path: Path = target
                        except FileExistsError:
                            # Another fetch of this URL landed first, possibly
                            # with a different extension. Reuse whichever file
                            # is on disk so callers always see the same path.
                            temp_path.unlink(missing_ok=True)
                            existing = _find_cached(uploads_dir, _cache_digest(url))
                            final_path = existing if existing is not None else target

                        data = final_path.read_bytes()
                        return {
                            "path": str(final_path),
                            "filename": final_path.name,
                            "mime_type": mime,
                            "size": len(data),
                            "sha256": hashlib.sha256(data).hexdigest(),
                            "url": f"/api/uploads/{final_path.name}",
                        }
                    except BaseException:
                        # Cleanup the temp file on every failure path,
                        # including ``RemoteImageError`` and cancellation.
                        temp_path.unlink(missing_ok=True)
                        raise
            except (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError) as exc:
                raise RemoteImageError(
                    "transport_failed",
                    f"Remote image fetch failed: {exc.__class__.__name__}: {exc}",
                ) from exc
            except httpx.HTTPError as exc:
                raise RemoteImageError(
                    "transport_failed",
                    f"Remote image fetch failed: {exc}",
                ) from exc
        raise RemoteImageError("redirect_loop", "Too many redirects while fetching image URL.")
    finally:
        if owns_client:
            await client.aclose()


async def materialize_sample_images(
    sample: Any,
    uploads_dir: Path,
) -> Any:
    """Return a copy of ``sample`` whose ImageRef.url entries point to local files.

    ImageRefs with ``path`` already set (or a non-http ``uri``) pass through
    unchanged. The returned sample keeps role/order/display_name/image_id/
    mime_type intact; only ``path`` and ``uri`` are rewritten so the downstream
    ``preprocess_image`` step takes the local-preprocess branch.
    """
    images = getattr(sample, "images", None) or []
    if not images:
        return sample

    new_images = []
    changed = False
    for ref in images:
        uri = (ref.uri or "").strip()
        if ref.path or not uri.startswith(("http://", "https://")):
            new_images.append(ref)
            continue
        materialized = await materialize_url_image(uri, uploads_dir)
        new_images.append(
            ref.model_copy(
                update={
                    "path": materialized["path"],
                    "uri": None,
                    # Keep mime_type if it was explicitly set; otherwise inherit
                    # the detected one so downstream code has accurate metadata.
                    "mime_type": ref.mime_type or materialized["mime_type"],
                }
            )
        )
        changed = True

    if not changed:
        return sample
    return sample.model_copy(update={"images": new_images})
