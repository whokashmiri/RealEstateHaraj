// src/index.js
const fs = require("fs");
const { getSettings } = require("./core/config");
const { makeLogger } = require("./core/logger");
const { connectMongo, closeMongo } = require("./core/db");
const { launchBrowser, newContext } = require("./core/browser");
const { loginAndSaveState } = require("./core/login");
const { runFullScrape } = require("./jobs/fullScrape");
const { pollNewAdsWithFreshBrowser } = require("./jobs/pollNewAds");
const { refreshCommentsLoop } = require("./jobs/refreshComments");

const log = makeLogger("MAIN");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureAuthState(browser, settings) {
  if (fs.existsSync(settings.storageStatePath)) {
    log.info("Using existing storageState", { path: settings.storageStatePath });
    return settings.storageStatePath;
  }

  log.info("No storageState found; logging in...");
  const ctx = await newContext(browser, settings);
  try {
    const p = await loginAndSaveState(ctx, settings);
    log.info("StorageState saved", { path: p });
    return p;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  const settings = getSettings();
  await connectMongo(settings, log);

  // Create storageState once
  const authBrowser = await launchBrowser(settings, log);
  const storageStatePath = await ensureAuthState(authBrowser, settings);
  await authBrowser.close().catch(() => {});

  const mode = (settings.mode || "").toLowerCase();
  log.info("Runner start", { mode: mode || "all" });

  const tasks = [];

  // FULL
  if (!mode || mode === "full") {
    tasks.push((async () => {
      log.info("FULL task start");
      const fullBrowser = await launchBrowser(settings, log);
      const fullCtx = await newContext(fullBrowser, settings, storageStatePath);
      try {
        await runFullScrape(fullCtx, settings);
        log.info("FULL task done");
      } catch (e) {
        log.error("FULL task crashed", { err: String(e) });
      } finally {
        await fullCtx.close().catch(() => {});
        await fullBrowser.close().catch(() => {});
      }
    })());
  }

  // POLL (delay start once)
  if (!mode || mode === "poll") {
    tasks.push((async () => {
      const pollDelayMs = (Number(settings.pollMinutes || 5) || 5) * 60 * 1000;
      log.info("POLL task will start after delay", { ms: pollDelayMs });
      await sleep(pollDelayMs);
      log.info("POLL task start");
      await pollNewAdsWithFreshBrowser(settings, storageStatePath);
    })().catch((e) => {
      log.error("POLL task crashed", { err: String(e) });
    }));
  }

  // CMTS
  if (!mode || mode === "refresh") {
    tasks.push((async () => {
      log.info("CMTS task start");
      const commentsBrowser = await launchBrowser(settings, log);
      try {
        await refreshCommentsLoop(commentsBrowser, settings, storageStatePath);
      } catch (e) {
        log.error("CMTS task crashed", { err: String(e) });
      } finally {
        await commentsBrowser.close().catch(() => {});
      }
    })());
  }

  if (!tasks.length) {
    log.warn("No tasks to run. Set MODE=full|poll|refresh or leave empty.");
    await closeMongo().catch(() => {});
    return;
  }

  await Promise.allSettled(tasks);
  log.warn("All tasks settled; exiting");
}

main().catch(async (e) => {
  log.error("Fatal", { err: String(e), stack: e?.stack });
  try { await closeMongo(); } catch {}
  process.exit(1);
});

process.on("SIGINT", async () => {
  log.warn("SIGINT received, exiting");
  try { await closeMongo(); } catch {}
  process.exit(0);
});
