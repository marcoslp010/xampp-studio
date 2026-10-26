// Run with playwright-cli run-code --filename=tests/ui-states.js.
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:1440,height:960});
  await page.goto(new URL('/',page.url()).href);
  await page.waitForFunction(() => document.querySelector('#liveStatusLabel')?.textContent.includes('LEITURA LOCAL ATIVA'));
  const saved = await page.evaluate(() => localStorage.getItem('xamppStudioVersions'));
  try {
    await page.evaluate(() => localStorage.setItem('xamppStudioVersions', '{}'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#liveStatusLabel')?.textContent.includes('LEITURA LOCAL ATIVA'));
    await page.locator('[data-page="php"]').click();
    await page.locator('.runtime-config').first().click();
    await page.locator('#page-version.active-page').waitFor();
    for (const tab of ['overview','dlls','settings']) {
      await page.locator(`.detail-tab[data-detail-tab="${tab}"]`).click();
      await page.locator(`[data-detail-panel="${tab}"]`).waitFor({state:'visible'});
    }
    await page.locator('[data-page="overview"]').click();
    await page.locator('#bannerClose').click();
    await page.route('**/api/**', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Simulação de agente indisponível'})}));
    await page.locator('#refreshStatus').click();
    await page.waitForFunction(() => /desconectado/i.test(document.querySelector('#connectionBanner').textContent));
    assert(await page.locator('#connectionBanner').isVisible(),'Dismissed banner did not return on failure');
    assert(/desconectado/i.test(await page.locator('#connectionBanner').innerText()),'Missing offline notice');
    await page.locator('[data-page="php"]').click();
    assert(await page.locator('#versionList .current-version').count() === 0,'Offline state still claims active runtime');
    await page.screenshot({path:'docs/ui-offline.png',fullPage:true,animations:'disabled'});
    await page.unroute('**/api/**');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#liveStatusLabel')?.textContent.includes('LEITURA LOCAL ATIVA'));
    await page.setViewportSize({width:390,height:844});
    assert(await page.locator('#appSidebar').evaluate(el=>el.inert),'Closed mobile drawer is focusable');
    await page.locator('#mobileMenuButton').click();
    assert(!(await page.locator('#appSidebar').evaluate(el=>el.inert)),'Open drawer is inert');
    for (let i=0;i<20;i++) {
      await page.keyboard.press('Tab');
      assert(await page.evaluate(()=>document.querySelector('#appSidebar').contains(document.activeElement)),'Focus escaped mobile drawer');
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.activeElement.id==='mobileMenuButton');
    assert(await page.locator('#appSidebar').evaluate(el=>el.inert),'Drawer did not become inert');
    assert(errors.length===0,errors.join('\n'));
    return {passed:true,checks:['malformed saved versions','PHP detail tabs','offline refresh','no stale active runtime','reconnect','mobile drawer inert','mobile focus trap','mobile Escape'],pageErrors:errors};
  } finally {
    await page.unroute('**/api/**');
    await page.evaluate(saved=>saved===null?localStorage.removeItem('xamppStudioVersions'):localStorage.setItem('xamppStudioVersions',saved),saved);
  }
}
