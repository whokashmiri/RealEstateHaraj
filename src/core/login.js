const { makeLogger } = require("./logger");

async function loginAndSaveState(context, settings) {
  const log = makeLogger("LOGIN");
  const page = await context.newPage();

  try {
    log.info("Login start");

    await page.goto(settings.base, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Open login modal
    await page.locator('button[data-testid="login-link"]').waitFor({ timeout: 60000 });
    await page.locator('button[data-testid="login-link"]').click();

    // Username step
    await page.locator('input[data-testid="auth_username"]').waitFor({ timeout: 60000 });
    await page.locator('input[data-testid="auth_username"]').fill(settings.username);
    await page.locator('button[data-testid="auth_submit_username"]').click();

    // Password step
    await page.locator('input[data-testid="auth_password"]').waitFor({ timeout: 60000 });
    await page.locator('input[data-testid="auth_password"]').fill(settings.password);
    await page.locator('button[data-testid="auth_submit_login"]').click();

    // Let UI settle
    await page.waitForTimeout(1200);
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});

    // Save storage state
    await context.storageState({ path: settings.storageStatePath });
    log.info("Storage state saved", { path: settings.storageStatePath });

    return settings.storageStatePath;
  } catch (e) {
    log.error("Login failed", { err: String(e) });
    throw e;
  } finally {
    await page.close().catch(() => {});
    log.info("Login done");
  }
}

module.exports = { loginAndSaveState };
