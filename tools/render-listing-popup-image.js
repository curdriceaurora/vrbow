const { chromium } = require("@playwright/test");
const path = require("path");
const { pathToFileURL } = require("url");

async function renderListingPopup() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });

  const demoUrl = pathToFileURL(path.join(__dirname, "readme-listing-demo.html")).href;
  await page.goto(demoUrl);
  await page.waitForFunction(() => window.__readmeDemoReady === true);

  await page.locator("#paw-panel").screenshot({
    path: path.join(__dirname, "../docs/listing-summary-popup.png"),
    omitBackground: true,
  });

  await browser.close();
  console.log("Saved docs/listing-summary-popup.png from the current panel renderer");
}

renderListingPopup().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
