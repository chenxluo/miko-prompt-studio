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
