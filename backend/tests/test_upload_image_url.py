"""Tests for the remote image materialization service + endpoint.

Covers:
- POST /api/upload/image-url happy path returns UploadImageResponse-shaped JSON
  with the same keys as /api/upload/image, and the saved file is served by
  /api/uploads/{filename}.
- Non-image body / wrong content-type is rejected with 415.
- Oversized body is rejected with 422.
- SSRF: loopback / private / link-local hosts are rejected with 400.
- Redirection to a private host is also rejected.
- The /api/upload/image-url endpoint and the run-time sample materializer
  share the same helper, so cached files are reused on repeat hits.

Plus execute_lab_run materialization:
- A SampleRecord with an http(s) ImageRef.uri gets materialized into a local
  path before build_internal_request runs, so the adapter observes the local
  path in internal_request.images[*].resolved.path.

All network I/O is routed through ``httpx.MockTransport`` so the tests are
deterministic and never touch the public internet.
"""

from __future__ import annotations

import asyncio
import hashlib
from io import BytesIO
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.services.remote_image import (
    RemoteImageError,
    materialize_sample_images,
    materialize_url_image,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _png_bytes(width: int = 4, height: int = 4) -> bytes:
    buf = BytesIO()
    Image.new("RGB", (width, height), color=(120, 200, 80)).save(buf, format="PNG")
    return buf.getvalue()


class _MockTransportContext:
    """Patch ``httpx.AsyncClient`` with a mock transport and bypass DNS SSRF.

    The transport already intercepts every byte, so the resolver check is
    redundant during tests. The original ``AsyncClient`` and ``_validate_target``
    are restored on exit so other tests are unaffected.
    """

    def __init__(self, handler):
        from app.services import remote_image

        self._module = remote_image
        self._original_client = remote_image.httpx.AsyncClient
        self._original_validate = remote_image._validate_target
        self._handler = handler

    def __enter__(self):
        original_async = self._original_client
        handler = self._handler  # capture in closure for the inner class

        class _PatchedClient(original_async):  # type: ignore[misc]
            def __init__(self, *args, **kwargs):
                kwargs["transport"] = httpx.MockTransport(handler)
                super().__init__(*args, **kwargs)

        self._module.httpx.AsyncClient = _PatchedClient  # type: ignore[assignment]
        self._module._validate_target = lambda url: url
        return self

    def __exit__(self, *exc):
        self._module.httpx.AsyncClient = self._original_client  # type: ignore[assignment]
        self._module._validate_target = self._original_validate
        return False


# ---------------------------------------------------------------------------
# 1. Endpoint happy path
# ---------------------------------------------------------------------------


def test_upload_image_url_returns_upload_shape_and_persists_file(client: TestClient) -> None:
    png = _png_bytes()
    expected_sha = hashlib.sha256(png).hexdigest()

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=png, headers={"content-type": "image/png"})

    with _MockTransportContext(handler):
        response = client.post(
            "/api/upload/image-url",
            json={"url": "https://example.test/cat.png"},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    # Same six keys as /api/upload/image.
    assert set(body.keys()) == {"path", "filename", "mime_type", "size", "sha256", "url"}
    assert body["mime_type"] == "image/png"
    assert body["size"] == len(png)
    assert body["sha256"] == expected_sha
    assert body["url"].startswith("/api/uploads/")
    assert body["filename"] == body["url"].rsplit("/", 1)[-1]

    # File landed in uploads_dir and the same path the response advertises.
    saved = Path(body["path"])
    assert saved.exists()
    assert saved.read_bytes() == png

    # Same helper signature is reused at the HTTP layer for serving.
    serve = client.get(body["url"])
    assert serve.status_code == 200
    assert serve.content == png


# ---------------------------------------------------------------------------
# 2. Non-image content → 415
# ---------------------------------------------------------------------------


def test_upload_image_url_rejects_non_image_body(client: TestClient) -> None:
    html = b"<html>not an image</html>"

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=html, headers={"content-type": "text/html"})

    with _MockTransportContext(handler):
        response = client.post(
            "/api/upload/image-url",
            json={"url": "https://example.test/page.html"},
        )

    assert response.status_code == 415, response.text


# ---------------------------------------------------------------------------
# 3. Oversize via the helper directly (avoids shipping a 25 MiB body)
# ---------------------------------------------------------------------------


def test_remote_image_rejects_oversize_and_cleans_up(tmp_path: Path) -> None:
    uploads = tmp_path / "uploads"
    big = b"\x00" * (5 * 1024)  # 5 KiB — exceeds the 1 KiB cap below.

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=big, headers={"content-type": "image/png"})

    with _MockTransportContext(handler), pytest.raises(RemoteImageError) as excinfo:
        asyncio.run(materialize_url_image("https://example.test/big.png", uploads, max_bytes=1024))

    assert excinfo.value.code == "too_large"
    # Temp file cleanup: nothing should remain in uploads_dir.
    assert not any(uploads.glob(".*.part"))


# ---------------------------------------------------------------------------
# 4. SSRF: loopback / private / link-local hosts are blocked
# ---------------------------------------------------------------------------


def test_remote_image_rejects_loopback_and_private_hosts(tmp_path: Path) -> None:
    uploads = tmp_path / "uploads"

    # These URLs use literal IPs or names so getaddrinfo is local — no DNS.
    for url in [
        "http://127.0.0.1/image.png",
        "http://localhost/image.png",  # resolves to 127.0.0.1 on most systems
        "http://10.0.0.5/image.png",
        "http://192.168.1.10/image.png",
        "http://169.254.169.254/latest/meta-data/",  # AWS link-local
        "http://[::1]/image.png",
        "file:///etc/passwd",  # non-http scheme
        "ftp://example.test/image.png",  # non-http scheme
    ]:
        with pytest.raises(RemoteImageError) as excinfo:
            asyncio.run(materialize_url_image(url, uploads))
        assert excinfo.value.code in {
            "blocked_address",
            "invalid_scheme",
            "invalid_host",
            "dns_failed",
        }, f"unexpected code {excinfo.value.code!r} for {url}"


# ---------------------------------------------------------------------------
# 5. SSRF: redirect to a private host must be rejected
# ---------------------------------------------------------------------------


def test_remote_image_rejects_redirect_to_private_host(tmp_path: Path, monkeypatch) -> None:
    uploads = tmp_path / "uploads"

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "public.example.test":
            return httpx.Response(302, headers={"location": "http://127.0.0.1/leak.png"})
        # Should never reach the private host.
        return httpx.Response(200, content=b"oh no", headers={"content-type": "image/png"})

    import socket as _socket

    from app.services import remote_image

    real_getaddrinfo = _socket.getaddrinfo

    def fake_getaddrinfo(host, port, *args, **kwargs):
        if host == "public.example.test":
            # Pretend it resolves to a public IP so the SSRF check passes for
            # the initial hop; the redirect target is the one we want blocked.
            return real_getaddrinfo("93.184.216.34", port, *args, **kwargs)
        return real_getaddrinfo(host, port, *args, **kwargs)

    monkeypatch.setattr(_socket, "getaddrinfo", fake_getaddrinfo)

    original_async = remote_image.httpx.AsyncClient

    class _PatchedClient(original_async):  # type: ignore[misc]
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(remote_image.httpx, "AsyncClient", _PatchedClient)
    # NOTE: do NOT bypass ``_validate_target`` here — this test exercises the
    # SSRF block for the redirect target.

    with pytest.raises(RemoteImageError) as excinfo:
        asyncio.run(materialize_url_image("https://public.example.test/x.png", uploads))

    assert excinfo.value.code == "blocked_address"


# ---------------------------------------------------------------------------
# 6. Cache reuse: second call for the same URL does not re-download
# ---------------------------------------------------------------------------


async def test_remote_image_caches_by_url(tmp_path: Path) -> None:
    uploads = tmp_path / "uploads"
    png = _png_bytes()
    counter = {"calls": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        counter["calls"] += 1
        return httpx.Response(200, content=png, headers={"content-type": "image/png"})

    with _MockTransportContext(handler):
        first = await materialize_url_image("https://example.test/cached.png", uploads)
        second = await materialize_url_image("https://example.test/cached.png", uploads)

    assert first["sha256"] == second["sha256"]
    assert first["path"] == second["path"]
    assert counter["calls"] == 1, "second call should hit the URL cache"


# ---------------------------------------------------------------------------
# 6b. Cache lookup is extension-agnostic (JPEG cached first still hits)
# ---------------------------------------------------------------------------


async def test_remote_image_cache_lookup_is_extension_agnostic(tmp_path: Path) -> None:
    """A repeat fetch for the same URL must reuse the cached file even when
    the extension on disk differs from the default the cache lookup would
    otherwise pick (e.g. .jpg vs .png)."""
    uploads = tmp_path / "uploads"
    jpeg_bytes = BytesIO()
    Image.new("RGB", (4, 4), color=(200, 60, 60)).save(jpeg_bytes, format="JPEG")
    jpeg_bytes = jpeg_bytes.getvalue()
    counter = {"calls": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        counter["calls"] += 1
        return httpx.Response(200, content=jpeg_bytes, headers={"content-type": "image/jpeg"})

    with _MockTransportContext(handler):
        first = await materialize_url_image("https://example.test/portrait.jpg", uploads)
        second = await materialize_url_image("https://example.test/portrait.jpg", uploads)

    assert counter["calls"] == 1, "JPEG repeat fetch should reuse the cache"
    assert first["mime_type"] == "image/jpeg"
    assert second["mime_type"] == "image/jpeg"
    assert Path(first["path"]).suffix == ".jpg"
    assert first["path"] == second["path"]


# ---------------------------------------------------------------------------
# 6c. Streaming cap is enforced chunk-by-chunk (no buffering before reject)
# ---------------------------------------------------------------------------


async def test_remote_image_streaming_cap_rejects_before_full_download(
    tmp_path: Path,
) -> None:
    """The size cap must abort on the chunk that crosses the limit, not after
    buffering the entire response body."""
    uploads = tmp_path / "uploads"
    sent_chunks = {"count": 0}
    cap = 1024
    chunk_size = 512

    class _ChunkingByteStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            while True:
                if sent_chunks["count"] * chunk_size >= cap * 4:  # bound the test
                    return
                sent_chunks["count"] += 1
                yield b"\x00" * chunk_size

        async def aclose(self) -> None:
            return None

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            stream=_ChunkingByteStream(),
            headers={"content-type": "image/octet-stream"},
        )

    with _MockTransportContext(handler), pytest.raises(RemoteImageError) as excinfo:
        await materialize_url_image("https://example.test/stream.bin", uploads, max_bytes=cap)

    assert excinfo.value.code == "too_large"
    # The handler stopped sending well before exhausting the test budget.
    assert sent_chunks["count"] <= 4
    # No partial file should remain on disk.
    assert not any(uploads.glob(".*.part"))


# ---------------------------------------------------------------------------
# 6d. Transport errors are wrapped as readable RemoteImageError
# ---------------------------------------------------------------------------


async def test_remote_image_wraps_connect_error_as_readable(tmp_path: Path) -> None:
    """A connect error from the transport must surface as
    ``RemoteImageError("transport_failed", ...)`` instead of leaking the
    raw httpx exception to the caller."""
    uploads = tmp_path / "uploads"

    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    with _MockTransportContext(handler), pytest.raises(RemoteImageError) as excinfo:
        await materialize_url_image("https://example.test/down.png", uploads)

    assert excinfo.value.code == "transport_failed"
    assert "ConnectError" in str(excinfo.value)


# ---------------------------------------------------------------------------
# 7. execute_lab_run materializes URL ImageRef before preprocessing
# ---------------------------------------------------------------------------


class _CapturingAdapter:
    """Fake adapter that records the InternalRequest handed to it."""

    last_request = None

    def get_capability(self, model_id: str):
        from app.schemas.model_config import ProviderCapability

        return ProviderCapability(
            provider_id="openai_compat",
            model_id=model_id,
            supports_image=True,
            supports_multi_image=True,
            direct_image_uri_schemes=["http", "https"],
            supports_inline_image_data=True,
            max_direct_images=20,
        )

    async def execute(self, request, api_key: str, base_url: str | None = None, timeout: int = 120):
        type(self).last_request = request
        from app.schemas.common import AttemptStatus
        from app.schemas.run_record import AdapterResult, NormalizedResponse, Usage

        return AdapterResult(
            status=AttemptStatus.SUCCEEDED,
            normalized_response=NormalizedResponse(text="ok"),
            usage=Usage(input_tokens=1, output_tokens=1, total_tokens=2, image_count=1),
            latency_ms=1,
            provider_request_snapshot={"model": request.model.model_id},
            provider_response_raw={"ok": True},
        )


def test_execute_lab_run_materializes_url_image_ref(client: TestClient, monkeypatch) -> None:
    """An ImageRef with path=None and uri=https://… must end up resolved to a
    local file path before the adapter sees the InternalRequest."""
    png = _png_bytes()
    captured_urls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        captured_urls.append(str(request.url))
        return httpx.Response(200, content=png, headers={"content-type": "image/png"})

    with _MockTransportContext(handler):
        # Patch the adapter registry used by run_executor.
        import app.adapters.registry as registry
        import app.services.run_executor as run_executor

        adapter = _CapturingAdapter()
        monkeypatch.setattr(registry, "get_adapter", lambda adapter_id: adapter)
        monkeypatch.setattr(run_executor, "get_adapter", lambda adapter_id: adapter)

        provider = client.post(
            "/api/provider-configs",
            json={"name": "url-img-provider", "adapter_id": "openai", "api_key": "sk-test"},
        )
        assert provider.status_code == 200, provider.text

        response = client.post(
            "/api/lab/run",
            json={
                "sample": {
                    "sample_id": "url-sample",
                    "images": [
                        {
                            "image_id": "img-1",
                            "role": "target",
                            "path": None,
                            "uri": "https://example.test/cat.png",
                            "mime_type": None,
                            "display_name": "the cat",
                            "order": 0,
                        }
                    ],
                    "vars": {},
                    "metadata": {},
                },
                "system_prompt": "",
                "user_prompt": "describe",
                "provider_config_id": provider.json()["provider_config_id"],
                "model_id": "test-model",
                "parameters": {"stream": False},
                "url_image_transport": "inline",
            },
        )

    assert response.status_code == 200, response.text

    # Adapter saw exactly one image and it came from a local file path,
    # not a remote URL. ``preprocess_image`` swaps in a data: URI inside
    # ``resolved.uri``, but ``resolved.path`` is the local file path.
    captured = _CapturingAdapter.last_request
    assert captured is not None
    assert len(captured.images) == 1
    resolved = captured.images[0].resolved
    assert resolved is not None
    assert resolved.path is not None
    assert resolved.path.endswith(".png")
    assert Path(resolved.path).exists()
    assert resolved.uri is not None
    assert resolved.uri.startswith("data:image/png;base64,")

    # The remote fetcher was invoked exactly once.
    assert len(captured_urls) == 1
    assert captured_urls[0] == "https://example.test/cat.png"

    # run_executor never asks the provider to fetch from a public URL.
    for ri in captured.images:
        assert ri.resolved.uri is None or ri.resolved.uri.startswith("data:")


@pytest.mark.parametrize("explicit_policy", [False, True])
def test_execute_lab_run_auto_sends_signed_https_url_directly(
    client: TestClient, monkeypatch, explicit_policy: bool
) -> None:
    signed_url = "https://cdn.example.test/cat.png?token=secret&expires=999"
    fetched_urls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        fetched_urls.append(str(request.url))
        raise AssertionError("AUTO direct URL transport must not fetch image bytes")

    with _MockTransportContext(handler):
        import app.adapters.registry as registry
        import app.services.run_executor as run_executor

        adapter = _CapturingAdapter()
        monkeypatch.setattr(registry, "get_adapter", lambda adapter_id: adapter)
        monkeypatch.setattr(run_executor, "get_adapter", lambda adapter_id: adapter)

        provider = client.post(
            "/api/provider-configs",
            json={"name": "auto-url-provider", "adapter_id": "openai", "api_key": "sk-test"},
        )
        assert provider.status_code == 200, provider.text

        payload = {
            "sample": {
                "sample_id": "auto-url-sample",
                "images": [
                    {
                        "image_id": "img-1",
                        "role": "target",
                        "path": None,
                        "uri": signed_url,
                        "mime_type": "image/png",
                        "display_name": "signed cat",
                        "order": 0,
                    }
                ],
                "vars": {},
                "metadata": {},
            },
            "system_prompt": "",
            "user_prompt": "describe",
            "provider_config_id": provider.json()["provider_config_id"],
            "model_id": "test-model",
            "parameters": {"stream": False},
        }
        if explicit_policy:
            payload["url_image_transport"] = "auto"

        response = client.post("/api/lab/run", json=payload)

    assert response.status_code == 200, response.text
    assert fetched_urls == []

    captured = _CapturingAdapter.last_request
    assert captured is not None
    assert captured.url_image_transport.value == "auto"
    assert len(captured.images) == 1
    assert captured.images[0].source_uri == signed_url
    assert captured.images[0].resolved.uri == signed_url
    assert captured.images[0].resolved.transport.value == "direct_url"

    detail = client.get(f"/api/runs/{response.json()['run_id']}")
    assert detail.status_code == 200, detail.text
    snapshot = detail.json()["items"][0]["internal_request_snapshot"]
    assert snapshot["url_image_transport"] == "auto"
    expected_redacted_url = "https://cdn.example.test/cat.png?<redacted query>"
    assert snapshot["images"][0]["source_uri"] == expected_redacted_url
    assert snapshot["images"][0]["resolved"]["uri"] == expected_redacted_url
    assert snapshot["images"][0]["resolved"]["transport"] == "direct_url"


# ---------------------------------------------------------------------------
# 8. execute_lab_run still works when no URL image is present (regression)
# ---------------------------------------------------------------------------


def test_execute_lab_run_passes_through_local_path(
    client: TestClient, monkeypatch, tmp_path: Path
) -> None:
    source = tmp_path / "local.png"
    Image.new("RGB", (2, 2), "red").save(source, format="PNG")

    class _CaptureAdapter:
        last_request = None

        async def execute(
            self,
            request,
            api_key: str,
            base_url: str | None = None,
            timeout: int = 120,
        ):
            type(self).last_request = request
            from app.schemas.common import AttemptStatus
            from app.schemas.run_record import AdapterResult, NormalizedResponse, Usage

            return AdapterResult(
                status=AttemptStatus.SUCCEEDED,
                normalized_response=NormalizedResponse(text="ok"),
                usage=Usage(input_tokens=1, output_tokens=1, total_tokens=2, image_count=1),
                latency_ms=1,
                provider_request_snapshot={"model": request.model.model_id},
                provider_response_raw={"ok": True},
            )

    import app.adapters.registry as registry
    import app.services.run_executor as run_executor

    adapter = _CaptureAdapter()
    monkeypatch.setattr(registry, "get_adapter", lambda adapter_id: adapter)
    monkeypatch.setattr(run_executor, "get_adapter", lambda adapter_id: adapter)

    provider = client.post(
        "/api/provider-configs",
        json={"name": "local-p", "adapter_id": "openai", "api_key": "sk-test"},
    )
    assert provider.status_code == 200, provider.text

    response = client.post(
        "/api/lab/run",
        json={
            "sample": {
                "sample_id": "local-sample",
                "images": [
                    {
                        "image_id": "img-local",
                        "role": "target",
                        "path": str(source),
                        "uri": None,
                        "display_name": "local",
                        "order": 0,
                    }
                ],
                "vars": {},
                "metadata": {},
            },
            "system_prompt": "",
            "user_prompt": "x",
            "provider_config_id": provider.json()["provider_config_id"],
            "model_id": "test-model",
            "parameters": {"stream": False},
        },
    )
    assert response.status_code == 200, response.text
    captured = _CaptureAdapter.last_request
    assert captured is not None
    assert captured.images[0].resolved.path is not None
    assert Path(captured.images[0].resolved.path).exists()


# ---------------------------------------------------------------------------
# 9. materialize_sample_images: keeps role/order/display_name/image_id
# ---------------------------------------------------------------------------


async def test_materialize_sample_images_preserves_metadata(tmp_path: Path) -> None:
    uploads = tmp_path / "uploads"
    png = _png_bytes()

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=png, headers={"content-type": "image/png"})

    with _MockTransportContext(handler):
        from app.schemas.sample_record import ImageRef, SampleRecord

        sample = SampleRecord(
            sample_id="s",
            images=[
                ImageRef(
                    image_id="original-id",
                    role="reference",
                    path=None,
                    uri="https://example.test/keep.png",
                    mime_type=None,
                    display_name="keep me",
                    order=7,
                ),
            ],
        )
        materialized = await materialize_sample_images(sample, uploads)

    assert materialized is not sample
    assert len(materialized.images) == 1
    only = materialized.images[0]
    assert only.image_id == "original-id"
    assert only.role == "reference"
    assert only.display_name == "keep me"
    assert only.order == 7
    assert only.path is not None and Path(only.path).exists()
    assert only.uri is None
