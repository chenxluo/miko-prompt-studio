from app.adapters.openai_compat import OpenAICompatAdapter
from app.schemas.internal_request import RequestImage, ResolvedImage


def test_openai_content_interleaves_repeated_missing_and_unreferenced_images() -> None:
    adapter = OpenAICompatAdapter()
    images = [
        RequestImage(
            request_image_id=f"i{index}",
            order=index,
            resolved=ResolvedImage(
                uri=f"data:image/png;base64,{data}", mime_type="image/png"
            ),
        )
        for index, data in enumerate(("AAAA", "BBBB", "CCCC"))
    ]

    content = adapter._build_user_content(
        "A {{image:1}} B {{image:1}} C {{image:9}} D", images
    )

    assert content == [
        {"type": "text", "text": "A"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBBB"}},
        {"type": "text", "text": "B"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBBB"}},
        {"type": "text", "text": "C"},
        {"type": "text", "text": "[image 9 not available]"},
        {"type": "text", "text": "D"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,CCCC"}},
    ]



def test_openai_content_emits_video_url_for_video_assets() -> None:
    adapter = OpenAICompatAdapter()
    video = RequestImage(
        request_image_id="v0",
        order=0,
        resolved=ResolvedImage(
            uri="data:video/mp4;base64,AAAA", mime_type="video/mp4"
        ),
    )

    content = adapter._build_user_content("{{image:0}}", [video])

    assert content == [
        {"type": "video_url", "video_url": {"url": "data:video/mp4;base64,AAAA"}},
    ]


def test_openai_content_image_only_assets_still_use_image_url() -> None:
    adapter = OpenAICompatAdapter()
    image = RequestImage(
        request_image_id="i0",
        order=0,
        resolved=ResolvedImage(
            uri="data:image/png;base64,BBBB", mime_type="image/png"
        ),
    )

    content = adapter._build_user_content("{{image:0}}", [image])

    assert content == [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBBB"}},
    ]