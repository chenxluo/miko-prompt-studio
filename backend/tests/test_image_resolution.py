from pathlib import Path

from PIL import Image

from app.schemas.internal_request import ImagePreprocessConfig
from app.schemas.sample_record import ImageRef
from app.services.image_preprocess import preprocess_image, resize_to_total_pixels


def test_resize_to_total_pixels_preserves_aspect_and_caps_pixels() -> None:
    image = Image.new("RGB", (100, 50), color="red")
    side = 32  # side-length → total pixels = side²

    resized = resize_to_total_pixels(image, side * side)

    assert resized.width * resized.height <= side * side
    assert resized.size == (44, 23)


def test_resize_to_total_pixels_leaves_small_images_unchanged() -> None:
    image = Image.new("RGB", (20, 10), color="red")
    side = 32  # side-length → total pixels = side²

    resized = resize_to_total_pixels(image, side * side)

    assert resized is image
    assert resized.size == (20, 10)


def test_preprocess_image_limits_total_pixels_without_modifying_source(tmp_path: Path) -> None:
    source_path = tmp_path / "source.png"
    Image.new("RGB", (100, 50), color="blue").save(source_path)
    original_bytes = source_path.read_bytes()
    side = 32  # side-length → total pixels = side²

    request_image = preprocess_image(
        ImageRef(path=str(source_path), mime_type="image/png", order=0),
        ImagePreprocessConfig(mode="limit_total_pixels", target_pixels=side * side),
        tmp_path / "cache",
    )

    assert source_path.read_bytes() == original_bytes
    assert request_image.resolved is not None
    assert request_image.resolved.width is not None
    assert request_image.resolved.height is not None
    assert request_image.resolved.width * request_image.resolved.height <= side * side
    assert request_image.resolved.path != str(source_path)
    assert request_image.resolved.uri is not None
    assert request_image.resolved.uri.startswith("data:image/png;base64,")
