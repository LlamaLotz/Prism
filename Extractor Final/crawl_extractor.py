import argparse
import asyncio
import shlex
from collections import deque
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlparse

from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode


def _canonical_url(url: str) -> str | None:
    """Return a crawlable URL without fragments, or None for non-web links."""
    url, _fragment = urldefrag(url)
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return url


def _internal_links(page_url: str, links) -> list[str]:
    """Resolve Crawl4AI's discovered links and keep only same-host URLs."""
    page_host = (urlparse(page_url).hostname or "").lower()
    discovered = []
    for link in links or []:
        href = link.get("href") if isinstance(link, dict) else link
        if not href:
            continue
        absolute = _canonical_url(urljoin(page_url, href))
        if absolute and (urlparse(absolute).hostname or "").lower() == page_host:
            discovered.append(absolute)
    return discovered


async def extract_webpage_to_markdown(
    url: str,
    output_dir: str = "prism_output",
    follow_links: bool = False,
    max_pages: int = 10,
):
    """Extract a page and optionally crawl its same-domain internal links.

    ``follow_links`` is opt-in. ``max_pages`` includes the starting page and
    prevents a site-wide crawl; it is also clamped to a safe positive value.
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    start_url = _canonical_url(url)
    if not start_url:
        raise ValueError(f"Invalid web URL: {url}")

    page_limit = max(1, max_pages) if follow_links else 1
    pending = deque([start_url])
    queued = {start_url}
    pages = []

    print(f"\n🌐 Crawling Webpage: {start_url}")
    if follow_links:
        print(f"🔗 Following same-domain links (maximum {page_limit} pages)")

    config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        word_count_threshold=10,
        remove_overlay_elements=True,
    )

    async with AsyncWebCrawler() as crawler:
        while pending and len(pages) < page_limit:
            page_url = pending.popleft()
            try:
                result = await crawler.arun(url=page_url, config=config)
                if not result.success:
                    print(f"⚠️ Failed to crawl {page_url}: {result.error_message}")
                    continue

                markdown_text = (result.markdown or "").strip()
                if not markdown_text:
                    print(f"⚠️ Empty page skipped: {page_url}")
                    continue

                title = result.metadata.get("title", page_url)
                pages.append((page_url, title, markdown_text))
                print(f"✅ Crawled {len(pages)}/{page_limit}: {page_url}")

                if follow_links and len(pages) < page_limit:
                    internal = (result.links or {}).get("internal", [])
                    for next_url in _internal_links(page_url, internal):
                        if next_url not in queued:
                            queued.add(next_url)
                            pending.append(next_url)
            except Exception as exc:
                print(f"⚠️ Failed to crawl {page_url}: {exc}")

    if not pages:
        raise RuntimeError("No pages could be extracted.")

    out_file = output_path / "extracted_web_content.md"
    sections = []
    for page_url, title, markdown_text in pages:
        sections.append(f"## {title}\n\nURL: {page_url}\n\n{markdown_text}")
    out_file.write_text("\n\n---\n\n".join(sections), encoding="utf-8")

    print("\n" + "=" * 50)
    print(f"🎉 SUCCESS! {len(pages)} webpage(s) extracted.")
    print(f"📁 Saved to: {out_file.absolute()}")
    print("=" * 50)
    print(f"\n🔍 Preview (First 400 chars):\n\n{pages[0][2][:400]}...")

    return "\n\n---\n\n".join(markdown_text for _, _, markdown_text in pages)


def main():
    parser = argparse.ArgumentParser(description="Extract a webpage with Crawl4AI")
    parser.add_argument("url", nargs="?", help="Starting webpage URL")
    parser.add_argument(
        "--follow-links",
        action="store_true",
        help="Also crawl same-domain links discovered on each page",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=10,
        help="Maximum pages to crawl when --follow-links is enabled (default: 10)",
    )
    args = parser.parse_args()

    if args.url is None:
        # Accept flags at the interactive prompt too, e.g.
        # `https://example.com --follow-links --max-pages 20`.
        entered = input("Enter a website URL [options: --follow-links --max-pages N]: ").strip()
        if not entered:
            return
        args = parser.parse_args(shlex.split(entered))

    asyncio.run(
        extract_webpage_to_markdown(
            args.url,
            follow_links=args.follow_links,
            max_pages=args.max_pages,
        )
    )


if __name__ == "__main__":
    main()
