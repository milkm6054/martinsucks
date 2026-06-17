import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_PROFILE_URL = "https://hllrecords.com/profiles"
COMMON_EXECUTABLES = [
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
]


def build_profile_url(steam_id64: str) -> str:
    return f"{BASE_PROFILE_URL}/{steam_id64}?period=180d&comp="


def detect_browser_executable() -> str | None:
    for candidate in COMMON_EXECUTABLES:
        if candidate.exists():
            return str(candidate)
    return None


def extract_area_raw_value(raw_text: str, area_name: str) -> float | None:
    quote = r'(?:\\"|")'
    pattern = (
        rf"{quote}area{quote}\s*:\s*{quote}{re.escape(area_name)}{quote}"
        rf"\s*,\s*{quote}rawValue{quote}\s*:\s*([-+]?\d+(?:\.\d+)?)"
    )
    match = re.search(pattern, raw_text)
    if not match:
        return None
    return float(match.group(1))


def fetch_stats(steam_id64: str) -> dict[str, object]:
    executable_path = detect_browser_executable()
    if not executable_path:
        raise RuntimeError("No Chrome or Edge executable was found on this machine.")

    source_url = build_profile_url(steam_id64)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=executable_path,
            channel="chrome" if "chrome.exe" in executable_path.lower() else None,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )

        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/137.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1366, "height": 900},
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

        page.goto(source_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(10000)

        title = page.title()
        html = page.content()

        context.close()
        browser.close()

    kpm_180 = extract_area_raw_value(html, "KPM")
    duel_strength_180 = extract_area_raw_value(html, "Duel strength")

    if kpm_180 is None and duel_strength_180 is None:
        raise RuntimeError(f"Unable to extract stats. Page title was: {title}")

    return {
        "sourceUrl": source_url,
        "pageTitle": title,
        "kpm180": kpm_180,
        "duelStrength180": duel_strength_180,
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Steam ID is required."}))
        return 1

    steam_id64 = sys.argv[1].strip()

    try:
        result = fetch_stats(steam_id64)
        print(json.dumps(result))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
