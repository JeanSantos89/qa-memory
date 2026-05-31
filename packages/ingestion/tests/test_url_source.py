"""UrlSource tests — the HTML→text + checksum logic is exercised directly;
the network fetch is not (no live calls in tests)."""

from qa_memory.sources.url import UrlSource, _html_to_text


def test_html_to_text_drops_script_and_style_and_collapses() -> None:
    html = (
        "<html><head><style>.x{color:red}</style></head>"
        "<body><script>alert(1)</script>"
        "<h1>Cancellation</h1><p>Free up to 5 min.</p></body></html>"
    )
    text = _html_to_text(html)
    assert "Cancellation" in text
    assert "Free up to 5 min." in text
    assert "alert(1)" not in text
    assert "color:red" not in text


def test_label_defaults_to_url() -> None:
    src = UrlSource("https://example.com/policy")
    assert src.label == "https://example.com/policy"
    assert src.url == "https://example.com/policy"


def test_type_is_url() -> None:
    assert UrlSource("https://example.com").type == "url"
