// src/jobs/refreshComments.js
const { makeLogger } = require("../core/logger");
const { newContext } = require("../core/browser");
const { listAdsForCommentsRefresh, updateCommentsOnly } = require("../core/db");
const { refreshCommentsOnly } = require("../scrape/ad");
const { sleep, hours } = require("../util/time");
const { humanDelay } = require("../core/human");

const log = makeLogger("CMTS");

async function refreshCommentsLoop(browser, settings, storageStatePath) {
  const baseWaitMs = hours(settings.commentsRefreshHours);
  const batchSize = Number(settings.commentsBatch || 200) || 200;

  while (true) {
    let ctx = null;

    try {
      await humanDelay(1200, 4500);

      const batch = await listAdsForCommentsRefresh(batchSize, settings);
      log.info("Refreshing comments batch", { count: batch.length });

      if (!batch.length) {
        log.info("No eligible ads for comments refresh (24h+ & <=30d & stale).");
        await sleep(Math.max(60_000, Math.floor(baseWaitMs * 0.6)));
        continue;
      }

      // ✅ NEW CONTEXT for the whole comments batch (or you can do per-ad if you want)
      ctx = await newContext(browser, settings, storageStatePath);

      for (const ad of batch) {
        const postId = String(ad?._id || "").trim();
        if (!postId) continue;

        try {
          await humanDelay(900, 3200);

          const payload = await refreshCommentsOnly(ctx, ad, settings); // { comments: [...] }
          const comments = Array.isArray(payload?.comments) ? payload.comments : null;

          if (comments) {
            await updateCommentsOnly(postId, comments);
            log.info("Comments updated", { postId, count: comments.length });
          } else {
            log.warn("No comments payload captured", { postId });
          }

          await humanDelay(250, 900);
        } catch (e) {
          log.error("Comments refresh failed", { postId, err: String(e) });
          await humanDelay(1200, 3500);
        }
      }

      log.info("Comments cycle done");
    } catch (e) {
      log.error("Comments cycle error", { err: String(e) });
    } finally {
      await ctx?.close().catch(() => {});
    }

    const jitter = Math.floor(baseWaitMs * (Math.random() * 0.25));
    log.info("Sleeping after comments cycle", { ms: baseWaitMs + jitter });
    await sleep(baseWaitMs + jitter);
  }
}

module.exports = { refreshCommentsLoop };
