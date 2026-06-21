"""Image preprocessing helpers for internal requests."""

from __future__ import annotations

import base64
import hashlib
import shutil
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageOps, UnidentifiedImageError

from app.schemas.internal_request import (
    ImagePreprocessConfig,
    RequestImage,
    ResolvedImage,
)
from app.schemas.sample_record import ImageMetadata, ImageRef

_FORMAT_TO_MIME = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
_EXT_TO_FORMAT = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}


def preprocess_image(
    image_ref: ImageRef,
    config: ImagePreprocessConfig,
    cache_dir: Path,
) -> RequestImage:
    """Preprocess a local image and return its request image representation."""

    if image_ref.path is None:
        if image_ref.uri:
            return RequestImage(
                request_image_id=f"rimg_{uuid4().hex}",
                source_image_id=image_ref.image_id,
                role=image_ref.role,
                path=None,
                mime_type=image_ref.mime_type,
                order=image_ref.order,
                preprocess=config,
                resolved=ResolvedImage(
                    uri=image_ref.uri,
                    mime_type=image_ref.mime_type or "image/png",
                ),
            )
        raise ValueError("ImageRef must include either path or uri.")

    source_path = Path(image_ref.path).expanduser()
    if not source_path.exists():
        raise FileNotFoundError(f"Image file not found: {source_path}")
    cache_dir.mkdir(parents=True, exist_ok=True)

    try:
        with Image.open(source_path) as opened:
            image = ImageOps.exif_transpose(opened).copy()
    except UnidentifiedImageError as exc:
        raise ValueError(f"Corrupt or unsupported image: {source_path}") from exc

    image = _apply_transform(image, config)
    output_format = _target_format(source_path, image, config)
    output_path = _cache_path(source_path, config, output_format, cache_dir)

    original_format = _target_format(source_path, image, ImagePreprocessConfig())
    if config.mode == "original" and output_format == original_format:
        shutil.copyfile(source_path, output_path)
    else:
        save_kwargs: dict[str, int | bool] = {}
        if output_format in {"JPEG", "WEBP"} and config.quality is not None:
            save_kwargs["quality"] = config.quality
        if output_format == "JPEG":
            image = image.convert("RGB")
            save_kwargs["optimize"] = True
        image.save(output_path, format=output_format, **save_kwargs)

    metadata = compute_image_metadata(output_path)
    mime_type = _FORMAT_TO_MIME.get(output_format, image_ref.mime_type or "image/png")
    return RequestImage(
        request_image_id=f"rimg_{uuid4().hex}",
        source_image_id=image_ref.image_id,
        role=image_ref.role,
        path=str(source_path),
        mime_type=image_ref.mime_type,
        order=image_ref.order,
        preprocess=config,
        resolved=ResolvedImage(
            path=str(output_path),
            uri=image_to_data_uri(output_path, mime_type),
            mime_type=mime_type,
            width=metadata.width,
            height=metadata.height,
            file_size=metadata.file_size,
            sha256=metadata.sha256,
        ),
    )


def compute_image_metadata(path: Path) -> ImageMetadata:
    """Compute dimensions, file size, and sha256 for an image file."""

    if not path.exists():
        raise FileNotFoundError(f"Image file not found: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    try:
        with Image.open(path) as image:
            width, height = image.size
    except UnidentifiedImageError as exc:
        raise ValueError(f"Corrupt or unsupported image: {path}") from exc
    return ImageMetadata(
        width=width,
        height=height,
        file_size=path.stat().st_size,
        sha256=digest.hexdigest(),
    )


def image_to_data_uri(path: Path, mime_type: str) -> str:
    """Convert an image file to a base64 data URI."""

    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _apply_transform(image: Image.Image, config: ImagePreprocessConfig) -> Image.Image:
    mode = config.mode
    if mode == "resize_long_edge" and config.long_edge:
        return _resize_by_edge(image, config.long_edge, use_long=True)
    if mode == "resize_short_edge" and config.short_edge:
        return _resize_by_edge(image, config.short_edge, use_long=False)
    if mode == "fit_within_box" and config.box_width and config.box_height:
        copy = image.copy()
        copy.thumbnail((config.box_width, config.box_height), Image.Resampling.LANCZOS)
        return copy
    if mode == "center_crop" and config.box_width and config.box_height:
        return ImageOps.fit(
            image,
            (config.box_width, config.box_height),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
    if mode in {"original", "convert_format"}:
        return image
    return image


def _resize_by_edge(image: Image.Image, edge: int, *, use_long: bool) -> Image.Image:
    width, height = image.size
    current = max(width, height) if use_long else min(width, height)
    if current <= 0 or current == edge:
        return image
    scale = edge / current
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(size, Image.Resampling.LANCZOS)


def _target_format(source_path: Path, image: Image.Image, config: ImagePreprocessConfig) -> str:
    if config.format:
        return "JPEG" if config.format.lower() in {"jpg", "jpeg"} else config.format.upper()
    return _EXT_TO_FORMAT.get(source_path.suffix.lower()) or (image.format or "PNG")


def _cache_path(
    source_path: Path,
    config: ImagePreprocessConfig,
    output_format: str,
    cache_dir: Path,
) -> Path:
    key = "|".join(
        (
            str(source_path.resolve()),
            str(source_path.stat().st_mtime_ns),
            config.model_dump_json(),
            output_format,
        )
    )
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    suffix = ".jpg" if output_format == "JPEG" else f".{output_format.lower()}"
    return cache_dir / f"{source_path.stem}_{digest[:24]}{suffix}"
