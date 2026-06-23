import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

COMMON_EXECUTABLES = [
    Path("/usr/bin/chromium"),
    Path("/usr/bin/chromium-browser"),
    Path("/usr/bin/google-chrome"),
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
]


def detect_browser_executable() -> str | None:
    configured = os.environ.get("BROWSER_EXECUTABLE_PATH", "").strip()
    if configured and Path(configured).exists():
        return configured

    for candidate in COMMON_EXECUTABLES:
        if candidate.exists():
            return str(candidate)
    return None


def build_launch_kwargs(executable_path: str | None) -> dict[str, Any]:
    launch_kwargs: dict[str, Any] = {
        "headless": True,
        "args": [
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
        ],
        "chromium_sandbox": False,
    }

    if executable_path:
        launch_kwargs["executable_path"] = executable_path
        if "chrome.exe" in executable_path.lower():
            launch_kwargs["channel"] = "chrome"

    return launch_kwargs


def create_context(playwright):
    executable_path = detect_browser_executable()
    browser = playwright.chromium.launch(**build_launch_kwargs(executable_path))
    context = browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/137.0.0.0 Safari/537.36"
        ),
        viewport={"width": 1366, "height": 2000},
        locale="en-US",
    )

    page = context.new_page()
    page.add_init_script(
        """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
window.chrome = { runtime: {} };
"""
    )

    return browser, context, page


def normalize_source_url(raw_url: str) -> str:
    parsed = urlparse(raw_url.strip())
    if parsed.scheme not in {"http", "https"} or parsed.netloc.lower() != "hllrecords.com":
        raise RuntimeError("Source URL must be an hllrecords.com http or https URL.")

    return raw_url.strip()


def parse_card(card: dict[str, Any], source_order: int) -> dict[str, Any]:
    lines = [str(value).strip() for value in card.get("lines", []) if str(value).strip()]
    if len(lines) < 5:
        raise RuntimeError("Recent 100+ kill card did not contain the expected five lines.")

    kill_match = re.search(
        r"(?P<kills>\d+)\s+kills\((?P<kpm>\d+(?:\.\d+)?)\s+kpm\s+·\s+(?P<kd>\d+(?:\.\d+)?)\s+KD\)",
        lines[1],
        flags=re.IGNORECASE,
    )
    if not kill_match:
        raise RuntimeError(f"Unable to parse kill line: {lines[1]}")

    weapon = lines[2].removeprefix("Most used:").strip() or None
    match_line = lines[3]
    map_match = re.match(r"(?P<map>.+)\s+\((?P<duration>\d+:\d{2}:\d{2})\)$", match_line)
    map_name = map_match.group("map").strip() if map_match else match_line
    duration = map_match.group("duration") if map_match else None

    played_on = lines[4]
    played_at_iso = None
    played_match = re.match(r"(?P<server>.+)\s+·\s+(?P<date>\d{1,2}\s+\w{3}\s+\d{4}\s+\d{2}:\d{2})$", played_on)
    if played_match:
      try:
          played_at_iso = datetime.strptime(played_match.group("date"), "%d %b %Y %H:%M").isoformat()
      except ValueError:
          played_at_iso = None

    profile_url = str(card.get("profileUrl") or "").strip()
    steam_id = profile_url.rstrip("/").split("/")[-1] if profile_url else None

    return {
        "sourceOrder": source_order,
        "playerName": str(card.get("player") or lines[0]).strip(),
        "profileUrl": profile_url,
        "steamId": steam_id,
        "kills": int(kill_match.group("kills")),
        "kpm": float(kill_match.group("kpm")),
        "kd": float(kill_match.group("kd")),
        "weapon": weapon,
        "mapName": map_name,
        "duration": duration,
        "playedOn": played_on,
        "playedAt": played_at_iso,
        "rawLines": lines,
    }


def fetch_recent_kills(source_url: str) -> dict[str, Any]:
    source_url = normalize_source_url(source_url)

    with sync_playwright() as playwright:
        browser = None
        context = None
        try:
            browser, context, page = create_context(playwright)
            page.goto(source_url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(7000)

            cards = page.evaluate(
                """
() => {
  const headings = Array.from(document.querySelectorAll('h2, h3'));
  const h = headings.find((el) => (el.textContent || '').trim().toLowerCase() === 'recent 100+ kill matches');
  if (!h || !h.parentElement) return [];
  const allLinks = Array.from(h.parentElement.querySelectorAll('a[href*="/profiles/"]'));
  const cards = [];

  for (const a of allLinks) {
    let node = a;
    for (let i = 0; i < 6 && node.parentElement; i += 1) {
      node = node.parentElement;
      const text = node.innerText || '';
      if (/\\d+ kills\\(/.test(text) && /Most used:/.test(text)) break;
    }

    const lines = (node.innerText || '').split(/\\n+/).map((line) => line.trim()).filter(Boolean);
    if (!lines.some((line) => /\\d+ kills\\(/.test(line))) continue;

    cards.push({
      player: (a.innerText || '').trim(),
      profileUrl: new URL(a.getAttribute('href'), location.origin).href,
      lines,
    });
  }

  const seen = new Set();
  return cards.filter((card) => {
    const key = card.player + card.profileUrl + card.lines.join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}
"""
            )

            return {
                "sourceUrl": page.url,
                "pageTitle": page.title(),
                "results": [parse_card(card, index + 1) for index, card in enumerate(cards)],
            }
        finally:
            if context is not None:
                context.close()
            if browser is not None:
                browser.close()


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "HLLRecords source URL is required."}))
        return 1

    try:
        print(json.dumps(fetch_recent_kills(sys.argv[1]), ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
