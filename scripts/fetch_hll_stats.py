import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

BASE_PROFILE_URL = "https://hllrecords.com/profiles"
COMMON_EXECUTABLES = [
    Path("/usr/bin/chromium"),
    Path("/usr/bin/chromium-browser"),
    Path("/usr/bin/google-chrome"),
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
]

ROLE_TO_BUCKET = {
    "Infantry": "Infantry",
    "Machine Gunner": "Infantry",
    "Sniper": "Infantry",
    "Artillery": "Artillery",
    "Armor": "Armor",
    "Tanker": "Armor",
    "Tank Commander": "Armor",
    "Crewman": "Armor",
}


def build_profile_url(steam_id64: str) -> str:
    return f"{BASE_PROFILE_URL}/{steam_id64}?period=180d&comp="


def detect_browser_executable() -> str | None:
    configured = os.environ.get("BROWSER_EXECUTABLE_PATH", "").strip()
    if configured and Path(configured).exists():
        return configured

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


def extract_role_percentages(page_html: str) -> dict[str, float]:
    role_percents: dict[str, float] = {}

    for role_name in ROLE_TO_BUCKET.keys():
        pattern = re.compile(
            rf"<div>\s*<div>{re.escape(role_name)}</div>[\s\S]{{0,700}}?"
            r'barValue">\s*(\d+(?:\.\d+)?)(?:<!--\s*-->\s*)?%\s*</div>',
            flags=re.IGNORECASE,
        )
        match = pattern.search(page_html)
        if match:
            role_percents[role_name] = float(match.group(1))

    if role_percents:
        return role_percents

    role_names = "|".join(re.escape(role) for role in ROLE_TO_BUCKET.keys())
    quote = r'(?:\\"|")'
    pattern = re.compile(
        rf"{quote}children{quote}\s*:\s*{quote}(?P<role>{role_names}){quote}"
        r"[\s\S]{0,400}?"
        rf"{quote}children{quote}\s*:\s*\[(?P<pct>\d+(?:\.\d+)?),\s*{quote}%{quote}\]"
    )

    for match in pattern.finditer(page_html):
        role = match.group("role")
        pct = float(match.group("pct"))
        if role not in role_percents or pct > role_percents[role]:
            role_percents[role] = pct

    return role_percents


def determine_main_role(role_percents: dict[str, float]) -> str | None:
    bucket_scores: dict[str, float] = {
        "Infantry": 0.0,
        "Artillery": 0.0,
        "Armor": 0.0,
    }

    for role_name, pct in role_percents.items():
        bucket = ROLE_TO_BUCKET.get(role_name)
        if not bucket:
            continue
        bucket_scores[bucket] = max(bucket_scores[bucket], pct)

    top_score = max(bucket_scores.values()) if bucket_scores else 0
    if top_score <= 0:
        return None

    for bucket in ["Infantry", "Artillery", "Armor"]:
        if bucket_scores[bucket] == top_score:
            return bucket

    return None


def stats_are_present(page_html: str) -> bool:
    return (
        extract_area_raw_value(page_html, "KPM") is not None
        or extract_area_raw_value(page_html, "Duel strength") is not None
    )


def wait_for_stats_payload(page) -> tuple[str, str]:
    last_html = ""
    last_title = ""

    try:
        page.wait_for_load_state("networkidle", timeout=4000)
    except Exception:
        pass

    for _ in range(18):
        try:
            last_title = page.title()
            last_html = page.content()
        except Exception:
            page.wait_for_timeout(300)
            continue

        if stats_are_present(last_html):
            return last_title, last_html

        page.wait_for_timeout(500)

    return last_title, last_html


def fetch_stats(steam_id64: str) -> dict[str, object]:
    results = fetch_stats_batch([steam_id64])
    result = results[0]
    if result.get("error"):
        raise RuntimeError(str(result["error"]))
    return result


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
    launch_kwargs = build_launch_kwargs(executable_path)
    browser = None
    launch_error = None

    for attempt in range(2):
        try:
            browser = playwright.chromium.launch(**launch_kwargs)
            break
        except Exception as exc:
            launch_error = exc
            if attempt == 0:
                continue
            raise

    if browser is None:
        raise RuntimeError(f"Unable to launch browser: {launch_error}")

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

    return browser, context, page


def fetch_stats_batch(steam_ids: list[str]) -> list[dict[str, object]]:
    if not steam_ids:
        return []

    with sync_playwright() as playwright:
        browser = None
        context = None
        page = None

        try:
            browser, context, page = create_context(playwright)
            results: list[dict[str, object]] = []

            for steam_id64 in steam_ids:
                source_url = build_profile_url(steam_id64)

                try:
                    page.goto(source_url, wait_until="domcontentloaded", timeout=60000)
                    title, html = wait_for_stats_payload(page)

                    kpm_180 = extract_area_raw_value(html, "KPM")
                    duel_strength_180 = extract_area_raw_value(html, "Duel strength")
                    role_percents = extract_role_percentages(html)
                    main_role = determine_main_role(role_percents)

                    if kpm_180 is None and duel_strength_180 is None:
                        raise RuntimeError(f"Unable to extract stats. Page title was: {title}")

                    results.append(
                        {
                            "steamId64": steam_id64,
                            "sourceUrl": source_url,
                            "pageTitle": title,
                            "kpm180": kpm_180,
                            "duelStrength180": duel_strength_180,
                            "mainRole": main_role,
                        }
                    )
                except Exception as exc:
                    results.append(
                        {
                            "steamId64": steam_id64,
                            "sourceUrl": source_url,
                            "kpm180": None,
                            "duelStrength180": None,
                            "mainRole": None,
                            "error": str(exc),
                        }
                    )

            return results
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception:
                    pass
            if browser is not None:
                try:
                    browser.close()
                except Exception:
                    pass


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "At least one Steam ID is required."}))
        return 1

    steam_ids = [value.strip() for value in sys.argv[1:] if value.strip()]

    try:
        if len(steam_ids) == 1:
            result = fetch_stats(steam_ids[0])
        else:
            result = fetch_stats_batch(steam_ids)
        print(json.dumps(result))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
