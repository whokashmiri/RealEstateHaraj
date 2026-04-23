// src/jobs/fullScrape.js
const PQueue = require("p-queue").default;
const { makeLogger } = require("../core/logger");
const {
  waitForListing,
  readVisibleAds,
  readAdsRange,
  getPostCount,
  loadMoreUntilStuck,
} = require("../scrape/listing");
const { scrapeAdInNewTab } = require("../scrape/ad");
const { isAdExists, upsertAd } = require("../core/db");
const { humanDelay } = require("../core/human");

const log = makeLogger("FULL");

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


function extractUrlId(adUrl) {
  // adUrl example: https://haraj.com.sa/11175523663/slug...
  try {
    const u = new URL(adUrl);
    const first = u.pathname.split("/").filter(Boolean)[0];
    return first ? String(first) : null;
  } catch {
    return null;
  }
}

async function runFullScrape(context, settings) {
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

 log.info("Full scrape start", { url: settings.tagUrl });
await openTagPageWithRecovery(page, settings, log);


  const queue = new PQueue({ concurrency: settings.detailConcurrency });

  // track duplicates per-run using URL id when possible
  const seen = new Set();

  let totalScraped = 0;

  async function enqueueAds(ads) {
    if (!Array.isArray(ads) || ads.length === 0) return;

    for (const ad of ads) {
      if (settings.maxAds && totalScraped >= settings.maxAds) {
        log.info("Max ads reached", { maxAds: settings.maxAds, totalScraped });
        return;
      }

      if (!ad?.url) {
        log.warn("Skip ad: missing url", { ad });
        continue;
      }

      // Prefer URL-based id (matches your Mongo _id)
      const urlId = extractUrlId(ad.url);
      const key = urlId || String(ad.postId || ad.url);

      if (seen.has(key)) continue;
      seen.add(key);

      
queue.add(async () => {
  const listingPostId = String(ad.postId || "");
  const dbId = urlId || listingPostId;

  // LINE 1 (OPEN)
  log.info("OPEN", { postId: dbId });

  try {
    await humanDelay(800, 2500);

    const exists = await isAdExists(dbId);
    if (exists) {
      // If you want strictly “open+saved” only, don’t log here.
      // Just return quietly.
      return;
    }

    await humanDelay(800, 2500);

    const scraped = await scrapeAdInNewTab(context, ad, settings);
    if (!scraped) {
      // LINE 2 (FAILED)
      log.warn("FAILED", { postId: dbId });
      return;
    }

    await upsertAd(scraped);
    totalScraped += 1;

    // LINE 2 (SAVED)
    log.info("SAVED", { postId: scraped._id || scraped.postId });
  } catch (e) {
    // LINE 2 (FAILED)
    log.warn("FAILED", { postId: dbId, err: String(e) });
  }
});


    }
  }

  // 1) Initial batch (top)
  let ads = await readVisibleAds(page, settings);
  log.info("Initial ads read", { count: ads.length });

  await enqueueAds(ads);

  // Track how many cards exist on the listing page
  let lastTotal = await getPostCount(page);

  // Used by loadMoreUntilStuck to stop after several no-growth attempts
  const state = { noGrowth: 0 };

  // 2) Load-more/scroll loop until stuck
  while (!settings.maxAds || totalScraped < settings.maxAds) {
    await humanDelay(700, 2000);

    const res = await loadMoreUntilStuck(page, settings, state);

    // When res.changed becomes false => we are stuck, stop full scrape.
    if (!res.changed) break;

    const after = res.after;

    if (after > lastTotal) {
      await humanDelay(400, 1200);

      const newAds = await readAdsRange(page, settings, lastTotal, after);

      // ✅ Only log when there is actual growth
      log.info("Loaded more ads", {
        before: lastTotal,
        after,
        added: after - lastTotal,
      });

      await enqueueAds(newAds);
      lastTotal = after;
    } else {
      await humanDelay(500, 1500);
    }

    // backpressure (log only when it triggers)
    const maxQueue = settings.detailConcurrency * 5;
    const resumeAt = settings.detailConcurrency * 3;

    if (queue.size > maxQueue) {
      log.info("Queue backpressure", {
        queued: queue.size,
        pending: queue.pending,
        concurrency: settings.detailConcurrency,
      });
      await queue.onSizeLessThan(resumeAt);
    }
  }

  await queue.onIdle();
  await page.close().catch(() => {});

  log.info("Full scrape done", {
    totalScraped,
    uniqueSeen: seen.size,
  });
}

module.exports = { runFullScrape };
