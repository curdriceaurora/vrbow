async function enableSearchBadging(context) {
  const page = await context.newPage();
  try {
    await page.goto("chrome://extensions/");
    const item = page.locator("extensions-item").filter({ hasText: "Vrbow" });
    await item.waitFor();
    const extensionId = await item.getAttribute("id");
    if (!extensionId) throw new Error("Could not resolve the Vrbow extension ID");

    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await page.evaluate(() => new Promise((resolve, reject) => {
      chrome.storage.local.set({ vrbow_enable_search_badging: true }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    }));
  } finally {
    await page.close();
  }
}

module.exports = { enableSearchBadging };
