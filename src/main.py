from __future__ import annotations

import nodriver as uc

from .auth import ensure_logged_in
from .browser import save_cookies, start_browser
from .db import ensure_indexes
from .scraper import scrape_tag_page
from .urls import BASE_URL


async def amain() -> None:
    await ensure_indexes()
    browser = await start_browser()

    try:
        tab = await browser.get(BASE_URL)
        await ensure_logged_in(browser, tab)
        await save_cookies(browser)
        await scrape_tag_page(browser)

    finally:
        try:
            browser.stop()
        except Exception:
            pass


def main() -> None:
    uc.loop().run_until_complete(amain())


if __name__ == '__main__':
    main()
