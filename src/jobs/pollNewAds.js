// src/jobs/pollNewAds.js
const PQueue = require("p-queue").default;
const { makeLogger } = require("../core/logger");
const { launchBrowser, newContext } = require("../core/browser");
const { waitForListing, readAdsRange, getPostCount, loadMoreAds } = require("../scrape/listing");
const { scrapeAdInNewTab } = require("../scrape/ad");
const { isAdExists, upsertAd } = require("../core/db");
const { sleep, minutes } = require("../util/time");
const { humanDelay } = require("../core/human");

const log = makeLogger("POLL");

async function openTagPageWithRecovery(page, settings, log) {
  const url = settings.tagUrl;

  // 1) First try
  const resp1 = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);

  // Quick hint from status (may be null depending on navigation)
  const st1 = resp1?.status?.() || null;
  if (st1 === 403 || st1 === 429) {
    log.warn("Tag page blocked", { status: st1 });
  }

  try {
    await waitForListing(page); // your existing function
    return;
  } catch (e1) {
    log.warn("Listing not ready, trying reload", { err: String(e1) });
  }

  // 2) Soft recovery: reload once
  await humanDelay(1200, 3500);
  const resp2 = await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);

  const st2 = resp2?.status?.() || null;
  if (st2 === 403 || st2 === 429) {
    log.warn("Blocked after reload", { status: st2 });
  }

  try {
    await waitForListing(page);
    return;
  } catch (e2) {
    log.warn("Still not ready after reload, retrying navigation", { err: String(e2) });
  }

  // 3) Hard recovery: one more clean goto
  await humanDelay(2000, 6000);
  const resp3 = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);

  const st3 = resp3?.status?.() || null;
  if (st3 === 403 || st3 === 429) {
    log.warn("Blocked after retry", { status: st3 });
  }

  // Final attempt
  await waitForListing(page); // if this fails -> throw -> caller handles
}


async function pollOnce(context, settings) {
  const stopAt = Number(settings.consecutiveExisting || 5) || 5;
  const maxLoadSteps = Number(settings.pollMaxLoadSteps || 6) || 6;

  const scanBatch = Number(settings.maxVisibleAds || 20) || 20; // scan chunk size

  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  let consecutiveExisting = 0;
  let scrapedThisCycle = 0;
  let scanned = 0;

  try {
    await humanDelay(600, 1600);
    log.info("Poll cycle start", { url: settings.tagUrl });

    await openTagPageWithRecovery(page, settings, log);
    await humanDelay(600, 1600);

    const queue = new PQueue({ concurrency: settings.detailConcurrency });

    // ✅ important: track by DB id (urlId) not listing postId
    const checked = new Set();

    let offset = 0;

    for (let step = 0; step <= maxLoadSteps; step++) {
      let total = await getPostCount(page);

      // Ensure we have enough cards loaded to scan next range
      while (total < offset + 1) {
        const res = await loadMoreAds(page, settings);
        if (!res.changed) break;
        total = res.after;
        await humanDelay(400, 1200);
      }

      total = await getPostCount(page);
      const end = Math.min(total, offset + scanBatch);

      if (end <= offset) {
        log.info("No more items to scan", { offset, total });
        break;
      }

      // ✅ Scan next range, not the top again
      const ads = await readAdsRange(page, settings, offset, end);

      if (!ads.length) {
        log.info("Empty range read", { offset, end, total });
        break;
      }

      for (const ad of ads) {
        if (!ad?.url) continue;

        // ✅ Use urlId for DB check
        const urlId = (() => {
          try {
            const u = new URL(ad.url);
            return u.pathname.split("/").filter(Boolean)[0] || null;
          } catch {
            return null;
          }
        })();

        const dbId = String(urlId || ad.postId || "").trim();
        if (!dbId) continue;

        if (checked.has(dbId)) continue;
        checked.add(dbId);

        scanned += 1;
        await humanDelay(200, 650);

        const exists = await isAdExists(dbId);

        if (exists) {
          consecutiveExisting += 1;

          if (consecutiveExisting >= stopAt) {
            log.info("Stop threshold reached (consecutive existing)", {
              stopAt,
              consecutiveExisting,
              scanned,
              step,
            });
            step = maxLoadSteps + 1; // break outer
            break;
          }
          continue;
        }

        consecutiveExisting = 0;

        queue.add(async () => {
          const openId = dbId;

          // LINE 1
          log.info("OPEN", { postId: openId });

          try {
            await humanDelay(700, 2200);

            const scraped = await scrapeAdInNewTab(context, ad, settings);

            // ✅ Skip null or missing item
            if (!scraped || !scraped.item) {
              // LINE 2
              log.warn("FAILED", { postId: openId });
              return;
            }

            await upsertAd(scraped);

            scrapedThisCycle += 1;

            // LINE 2
            log.info("SAVED", { postId: scraped._id || scraped.postId || openId });
          } catch (e) {
            // LINE 2
            log.warn("FAILED", { postId: openId, err: String(e) });
          }
        });
      }

      await queue.onIdle();

      if (consecutiveExisting >= stopAt) break;

      // Move offset deeper
      offset = end;

      // If we consumed everything loaded so far, load more to continue
      const totalAfter = await getPostCount(page);
      if (offset >= totalAfter) {
        await humanDelay(500, 1500);
        const res = await loadMoreAds(page, settings);
        if (!res.changed) {
          log.info("No more ads loaded in poll", { step, scanned, totalOnPage: res.after });
          break;
        }
        log.info("Loaded more ads in poll", { step, before: res.before, after: res.after });
        await humanDelay(500, 1500);
      }
    }

    log.info("Poll cycle done", { scrapedThisCycle, scanned, consecutiveExisting });
  } catch (e) {
    log.error("Poll cycle error", { err: String(e) });
  } finally {
    await page.close().catch(() => {});
  }
}



async function pollNewAdsWithFreshBrowser(settings, storageStatePath) {
  const pollMs = minutes(settings.pollMinutes);

  while (true) {
    let browser = null;
    let context = null;

    try {
      // Fresh browser each cycle
      browser = await launchBrowser(settings, makeLogger("MAIN"));
      context = await newContext(browser, settings, storageStatePath);

      await pollOnce(context, settings);
    } catch (e) {
      log.error("Poll loop error", { err: String(e) });
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }

    log.info("Sleeping after poll cycle", { minutes: settings.pollMinutes, ms: pollMs });
    await sleep(pollMs);
  }
}

module.exports = { pollNewAdsWithFreshBrowser, pollOnce };
