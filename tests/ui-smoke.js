// Run through playwright-cli run-code --filename=tests/ui-smoke.js.
// Read-only navigation; no service, runtime, firewall or configuration mutations.
async page => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(new URL('/',page.url()).href);
  await page.waitForFunction(() => document.querySelector('#liveStatusLabel')?.textContent.includes('LEITURA LOCAL ATIVA'));
  const pages = ['overview','php','apache','mysql','database','services','performance','firewall','activity'];
  const layouts = [];
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 960 });
    for (const name of pages) {
      const navigation = page.locator(`[data-page="${name}"]`);
      const toggle = page.locator('#mobileMenuButton');
      if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await navigation.click();
      await page.locator(`#page-${name}.active-page`).waitFor({ state: 'visible' });
      assert(await navigation.getAttribute('aria-current') === 'page', `Navigation state: ${name}`);
      const metrics = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth }));
      layouts.push({ width, page: name, overflow: metrics.body - metrics.width });
      assert(metrics.body <= metrics.width + 1, `Horizontal overflow ${width}/${name}: ${metrics.body}`);
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('[data-page="overview"]').click();
  await page.locator('#openExtensionsModal').click();
  await page.locator('#modal[open]').waitFor();
  const loadedNames = await page.locator('#extensionModalGrid .extension-item strong').allTextContents();
  await page.locator('#extensionModalSearch').fill(loadedNames[0] || 'curl');
  if (loadedNames.length) {
    assert((await page.locator('#extensionModalGrid .extension-item strong').allTextContents()).every(name => name.toLowerCase().includes(loadedNames[0].toLowerCase())), 'Extension filter failed');
    assert(await page.locator('#extensionModalGrid .extension-item').count() > 0, 'Filter removed the matching extension');
  } else assert((await page.locator('#extensionModalGrid').innerText()).includes('Nenhuma extensão lida'), 'Missing unavailable inventory state');
  await page.locator('#extensionModalSearch').press('1');
  assert(await page.locator('#modal[open]').isVisible(), 'Typing closed the dialog');
  assert(await page.locator('#page-overview.active-page').isVisible(), 'Typing triggered navigation shortcut');
  await page.keyboard.press('Escape');
  await page.locator('#toolsMenu summary').click();
  await page.locator('#helpButton').click();
  await page.locator('#modal[open]').waitFor();
  await page.keyboard.press('1');
  assert(await page.locator('#page-overview.active-page').isVisible(), 'Shortcut triggered inside dialog');
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.querySelector('#modal').contains(document.activeElement)), 'Dialog focus escaped');
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement === document.querySelector('#toolsMenu summary'));
  await page.locator('[data-page="services"]').click();
  await page.screenshot({ path: 'docs/ui-services.png', fullPage: true, animations: 'disabled' });
  await page.locator('[data-page="overview"]').click();
  await page.screenshot({ path: 'docs/ui-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'docs/ui-mobile.png', fullPage: true, animations: 'disabled' });
  assert(errors.length === 0, errors.join('\n'));
  return JSON.stringify({ passed: true, layouts, pageErrors: errors, tested: ['navigation','responsive overflow','extensions dialog','input shortcuts','dialog shortcuts','focus trap','Escape','focus restoration'] }, null, 2);
}


