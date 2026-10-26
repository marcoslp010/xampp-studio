// UI fixture for two PHP installs with the same version. No installation or download.
async page => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const versionsResponse = await page.request.get(new URL('/api/versions', page.url()).href);
  const payload = await versionsResponse.json();
  const first = payload.versions[0];
  const second = { ...first, root: `${first.root}-scope-fixture`, current: false };
  await page.route('**/api/versions', route => route.fulfill({ json: { ...payload, versions: [first, second] } }));
  await page.route('**/api/extensions/downloads?*', route => route.fulfill({ json: { phpRoot: new URL(route.request().url()).searchParams.get('phpRoot'), downloads: [] } }));
  const targets = [];
  await page.route('**/api/pecl/versions', route => {
    targets.push(route.request().postDataJSON().phpRoot);
    return route.fulfill({ json: { package: 'opentelemetry', packageUrl: 'https://pecl.php.net/package/opentelemetry', target: {}, releases: [], error: 'Fixture de escopo' } });
  });
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.reload();
    await page.locator('[data-page="php"]').click();
    await page.locator('.runtime-config').nth(1).waitFor();
    for (const [index, runtime] of [first, second].entries()) {
      await page.locator('.runtime-config').nth(index).click();
      await page.locator('.detail-tab[data-detail-tab="dlls"]').click();
      assert((await page.locator('#catalogRuntime').innerText()).includes(runtime.root), 'Wrong fixed target');
      assert(await page.locator('.catalog-builds').count() === 0, 'Previous PHP results leaked');
      await page.locator('#catalogQuery').fill('ext-opentelemetry');
      await page.locator('#catalogForm button').click();
      await page.locator('.catalog-builds').first().click();
      await page.getByText('Fixture de escopo').waitFor();
      await page.locator('#backToPhpVersions').click();
    }
    assert(JSON.stringify(targets) === JSON.stringify([first.root, second.root]), 'Request was sent to another PHP');
    return { passed: true, targets, tested: ['same version, distinct PHP paths', 'search cleared on switch', 'build lookup bound to opened PHP'] };
  } finally {
    await page.unroute('**/api/versions');
    await page.unroute('**/api/extensions/downloads?*');
    await page.unroute('**/api/pecl/versions');
    await page.reload();
  }
}
