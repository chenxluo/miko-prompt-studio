from app.services.html_export import render_run_html


def _make_session(**kwargs):
    return {"run_id": "test-run", "name": "Test Run", **kwargs}


def _make_item(response_boxes=None, with_image=True):
    images = []
    if with_image:
        images = [
            {
                "uri": "data:image/png;base64,iVBORw0KGgo=",
                "order": 0,
            }
        ]
    return {
        "run_item_id": "ri1",
        "sample_id": "s1",
        "status": "succeeded",
        "internal_request_snapshot": {
            "images": images,
            "prompt": {"render_context": {}},
        },
        "response": {
            "raw_text": "bbox:[45,55,570,960]: A woman in white dress",
            "parsed": None,
            "boxes": response_boxes,
        },
    }


def test_render_run_html_includes_bbox_overlay():
    session = _make_session()
    items = [
        _make_item(
            response_boxes=[
                {
                    "x1": 0.045,
                    "y1": 0.055,
                    "x2": 0.570,
                    "y2": 0.960,
                    "label": "A woman in white dress",
                    "raw_match": "bbox:[45,55,570,960]",
                }
            ]
        )
    ]

    html = render_run_html(session, items)

    assert "bbox-overlay" in html
    assert "<rect" in html
    assert "bbox-label" in html
    assert "A woman in white dress" in html
    assert "img-wrap" in html


def test_render_run_html_no_boxes_does_not_add_overlay():
    session = _make_session()
    html = render_run_html(session, [_make_item(response_boxes=None)])

    assert "img-wrap" in html
    # The overlay helper exists in the inline script, but it is gated by `boxes.length`.
    assert "boxes.length ? renderBBoxOverlay(boxes) : ''" in html
    assert '"boxes": null' in html


def test_render_run_html_empty_boxes_does_not_add_overlay():
    session = _make_session()
    html = render_run_html(session, [_make_item(response_boxes=[])])

    assert "img-wrap" in html
    assert "boxes.length ? renderBBoxOverlay(boxes) : ''" in html
    assert '"boxes": []' in html


def test_render_run_html_no_image_no_overlay():
    session = _make_session()
    html = render_run_html(session, [_make_item(response_boxes=None, with_image=False)])

    assert '<div class="main-img"><span class="none">No images</span></div>' in html


def test_render_run_html_bbox_details_listed_in_overlay():
    """bbox 详情区列出每个 box 的 label 和 coords"""
    session = _make_session()
    items = [{
        "run_item_id": "ri1",
        "sample_id": "s1",
        "status": "succeeded",
        "internal_request_snapshot": {
            "images": [{"uri": "data:image/png;base64,iVBORw0KGgo=", "order": 0}],
            "prompt": {"render_context": {}},
        },
        "response": {
            "raw_text": "bbox:[45,55,570,960]: A woman in white dress",
            "parsed": None,
            "boxes": [
                {"x1": 0.045, "y1": 0.055, "x2": 0.570, "y2": 0.960,
                 "label": "A woman in white dress",
                 "raw_match": "bbox:[45,55,570,960]: A woman in white dress"},
                {"x1": 0.6, "y1": 0.4, "x2": 0.75, "y2": 0.8,
                 "label": None, "raw_match": "bbox:[600,400,750,800]"},
            ],
        },
    }]
    html = render_run_html(session, items)

    # The helper functions and static strings are inlined in the script.
    assert "Bounding Boxes" in html
    assert "bbox-list" in html
    assert "bbox-row" in html
    assert "bbox-detail-label" in html
    assert "formatCoords" in html
    assert "toFixed(4)" in html
    # The raw payload values are embedded in the JSON blob.
    assert "A woman in white dress" in html
    assert "0.045" in html
    assert "未命名" in html


def test_render_run_html_no_boxes_no_details_section():
    """boxes 为 None 时，条件渲染不会生成 details 区"""
    session = _make_session()
    html = render_run_html(session, [_make_item(response_boxes=None)])
    assert '"boxes": null' in html
    assert "Array.isArray(boxes) && boxes.length" in html


def test_render_run_html_empty_boxes_no_details_section():
    """boxes 为 [] 时，条件渲染不会生成 details 区"""
    session = _make_session()
    html = render_run_html(session, [_make_item(response_boxes=[])])
    assert '"boxes": []' in html
    assert "Array.isArray(boxes) && boxes.length" in html


def test_render_run_html_bbox_details_skips_invalid_box():
    """bbox 项缺少 x1 等数值坐标时会被跳过"""
    session = _make_session()
    items = [
        _make_item(
            response_boxes=[
                {"x1": 0.1, "y1": 0.2, "x2": 0.3, "y2": 0.4, "label": "valid", "raw_match": ""},
                {"label": "bad", "raw_match": "bad"},
            ]
        )
    ]
    html = render_run_html(session, items)
    assert "Bounding Boxes" in html
    assert "valid" in html
    assert "typeof b.x1 !== 'number'" in html


def test_render_run_html_bbox_payload_is_embedded():
    session = _make_session()
    boxes = [
        {
            "x1": 0.1,
            "y1": 0.2,
            "x2": 0.3,
            "y2": 0.4,
            "label": "foo",
            "raw_match": "bbox:[1,2,3,4]",
        }
    ]
    html = render_run_html(session, [_make_item(response_boxes=boxes)])

    assert '"boxes"' in html
    assert "bbox:[1,2,3,4]" in html

def test_render_run_html_multi_image_badge_and_thumb_index():
    item = _make_item()
    item["internal_request_snapshot"]["images"] = [
        {"uri": "data:image/png;base64,iVBORw0KGgo=", "order": i}
        for i in range(3)
    ]

    html = render_run_html(_make_session(), [item])

    assert html.count('"src": "data:image/png;base64,iVBORw0KGgo="') == 3
    assert "'<span class=\"thumb-idx\">'+(i+1)+'</span>" in html
    assert "'<div class=\"img-badge\" id=\"o-imgbadge\">1 / '+imgs.length+'</div>'" in html
    assert "ArrowUp" in html
    assert "ArrowDown" in html
