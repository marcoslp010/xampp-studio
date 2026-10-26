// Run against the updated local server with playwright-cli run-code --filename=tests/ui-extension-catalog.js.
// Uses the page's current origin. Downloads only; does not install or change php.ini.
async page => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.locator('[data-page="php"]').click();
  await page.locator('.runtime-dlls').first().click();
  assert(await page.locator('[data-page="catalog"], select#catalogRuntime').count() === 0, 'Global catalog still present');
  await page.locator('#catalogQuery').fill('ext-opentelemetry');
  await page.locator('#catalogForm button').click();
  await page.locator('.catalog-builds').first().click();
  await page.locator('.catalog-builds-holder .download-pecl-build').first().waitFor({ timeout: 30000 });
  const target = await page.locator('.catalog-builds-holder .download-pecl-build').first().getAttribute('data-root');
  await page.locator('.catalog-builds-holder .download-pecl-build').first().click();
  await page.waitForFunction(() => document.querySelector('#modalKicker')?.textContent.includes('DOWNLOAD CONCLUÍDO'), null, { timeout: 90000 });
  assert((await page.locator('#modalContent').innerText()).includes('O php.ini não foi alterado'), 'Download mode missing');
  const downloaded = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('link', { name: 'Salvar cópia da DLL' }).click();
  const download = await downloaded;
  assert(download.suggestedFilename() === 'php_opentelemetry.dll', 'Unexpected DLL name');
  assert(await download.failure() === null, 'Download failed');
  await page.locator('#cancelAction').click();
  await page.locator('#extensionDownloads a[download]').first().waitFor();
  const saved = await page.request.get(new URL(`/api/extensions/downloads?phpRoot=${encodeURIComponent(target)}`, page.url()).href);
  assert((await saved.json()).downloads.every(item => item.phpRoot.toLowerCase() === target.toLowerCase()), 'Downloads belong to another PHP');

  await page.route('**/api/pecl/versions', route => route.fulfill({ json: { package: 'opentelemetry', packageUrl: 'https://pecl.php.net/package/opentelemetry', target: { version: '9.0.0', phpMinor: '9.0', threadSafety: 'ts', architecture: 'x64', compiler: 'VS17' }, releases: [{ version: '1.4.2', available: true, builds: [], compatibleBuilds: [] }] } }));
  await page.locator('.catalog-builds').first().click();
  await page.locator('.catalog-builds').first().click();
  await page.getByText('Nenhum build compatível foi encontrado', { exact: false }).waitFor();
  assert(await page.locator('.download-pecl-build, .install-pecl-build').count() === 0, 'Incompatible build enabled');
  await page.unroute('**/api/pecl/versions');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#catalogQuery').fill('php_opentelemetry.dll');
  await page.locator('#catalogForm button').click();
  await page.locator('.catalog-builds').first().waitFor();
  await page.screenshot({ path: 'docs/ui-extension-catalog-mobile.png', fullPage: true, animations: 'disabled' });
  await page.locator('.catalog-builds').first().click();
  await page.locator('.catalog-builds-holder .download-pecl-build').first().waitFor();
  const overflow = await page.evaluate(() => { const holder = document.querySelector('.catalog-builds-holder'); return { page: document.documentElement.scrollWidth > innerWidth, holder: holder.scrollWidth > holder.clientWidth }; });
  assert(!overflow.page && !overflow.holder, 'Mobile overflow');
  await page.screenshot({ path: 'docs/ui-extension-builds-mobile.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: 'docs/ui-extension-catalog.png', fullPage: true, animations: 'disabled' });
  assert(!errors.length, errors.join('\n'));
  return { passed: true, target, downloaded: download.suggestedFilename(), tested: ['PHP list -> Extensões opens DLLs tab', 'live catalog', 'inline compatible builds', 'real DLL download', 'downloads scoped to PHP', 'incompatible build blocked (fixture)', 'mobile layout'], errors };
}
