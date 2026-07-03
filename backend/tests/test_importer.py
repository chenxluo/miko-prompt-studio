"""Regression tests for CSV importer whitespace handling."""

from pathlib import Path

import pytest

from app.services.importer import ColumnMapping, _image_ref_from_value, import_csv
from app.schemas.sample_record import ImageRef


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
