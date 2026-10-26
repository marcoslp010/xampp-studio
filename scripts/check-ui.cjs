// Runs read-only checks against an already running local Studio.
// PLAYWRIGHT_MODULE can point to a bundled Playwright installation.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const reports = [];
  try {
    for (const file of process.argv.slice(2)) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      page.setDefaultTimeout(15000);
      try {
        await page.goto(process.env.STUDIO_URL || 'http://127.0.0.1:43197');
        const run = vm.runInThisContext(fs.readFileSync(path.resolve(file), 'utf8'), { filename: file });
        reports.push({ file, result: await run(page) });
      } catch (error) {
        reports.push({ file, error: error.message });
        process.exitCode = 1;
      } finally { await page.close(); }
    }
    console.log(JSON.stringify(reports, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
