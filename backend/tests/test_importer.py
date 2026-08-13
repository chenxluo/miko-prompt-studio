"""Regression tests for CSV importer whitespace handling."""

from pathlib import Path

from app.schemas.sample_record import ImageRef, SampleRecord
from app.services.importer import (
    ColumnMapping,
    _image_ref_from_value,
    import_csv,
    import_jsonl,
)


def test_image_ref_from_value_strips_whitespace_from_url():
    ref = _image_ref_from_value(" https://example.com/a.png ", "target", 0)
    assert ref == ImageRef(
        role="target",
        uri="https://example.com/a.png",
        path=None,
        display_name="a.png",
        order=0,
    )


def test_image_ref_from_value_strips_whitespace_from_local_path():
    ref = _image_ref_from_value("  /tmp/foo.png  ", "target", 0)
    assert ref == ImageRef(
        role="target",
        uri=None,
        path="/tmp/foo.png",
        display_name="foo.png",
        order=0,
    )


def test_import_csv_strips_whitespace_around_url_image(tmp_path: Path):
    csv_path = tmp_path / "samples.csv"
    csv_path.write_text("id,image\ns1, https://example.com/a.png \n", encoding="utf-8")

    records = import_csv(
        csv_path,
        mapping=ColumnMapping(
            id_column="id",
            image_columns=[{"column": "image", "role": "target"}],
        ),
    )

    assert len(records) == 1
    images = records[0].images
    assert len(images) == 1
    assert images[0].uri == "https://example.com/a.png"
    assert images[0].path is None


def test_imageref_coerces_url_in_path_to_uri():
    """A URL recorded under ``path`` (no ``uri``) is normalized so the
    executor treats it as remote instead of a missing local file."""
    ref = SampleRecord.model_validate(
        {"sample_id": "s1", "images": [{"role": "source", "path": "https://x.test/a.webp"}]}
    ).images[0]
    assert ref.path is None
    assert ref.uri == "https://x.test/a.webp"

    # A data: URI in path is moved the same way.
    ref2 = ImageRef(role="t", path="data:image/png;base64,AAA")
    assert ref2.path is None
    assert ref2.uri == "data:image/png;base64,AAA"

    # A genuine local path is left untouched.
    ref3 = ImageRef(role="t", path="/tmp/a.png")
    assert ref3.path == "/tmp/a.png"
    assert ref3.uri is None


def test_import_jsonl_normalizes_url_in_path(tmp_path: Path):
    """JSONL imports record the source URL under ``path`` (unlike CSV, which
    goes through _image_ref_from_value). Validation must still route it to
    ``uri`` or the batch run fails with FileNotFoundError at preprocess time."""
    jsonl = tmp_path / "samples.jsonl"
    jsonl.write_text(
        '{"sample_id": "s1", "images": [{"role": "source", '
        '"path": "https://x.test/a.webp"}]}\n',
        encoding="utf-8",
    )
    records = import_jsonl(jsonl)
    assert len(records) == 1
    img = records[0].images[0]
    assert img.path is None
    assert img.uri == "https://x.test/a.webp"
