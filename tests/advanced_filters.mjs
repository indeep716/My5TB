import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';

const base='http://127.0.0.1:5188';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5188','--strictPort'],{stdio:'ignore'});
let browser;
try{
  for(let i=0;i<60;i++){try{if((await fetch(base)).ok)break}catch{}await new Promise(r=>setTimeout(r,100))}
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>sessionStorage.setItem('my5tb-age','yes'));
    let delay=false,failModels=false,lastURL;
    await page.route('**/api/models?*',async route=>{
      lastURL=new URL(route.request().url());
      if(delay)await new Promise(r=>setTimeout(r,250));
      if(failModels){await route.fulfill({status:503,json:{error:'offline fixture'}});return}
      const filtered=[...lastURL.searchParams.keys()].some(k=>k.startsWith('exclude_'));
      const total=filtered?0:lastURL.searchParams.has('q')?7:32;
      await route.fulfill({json:{items:[],total,page:Number(lastURL.searchParams.get('page')||1),limit:15}});
    });
    await page.route('**/api/facets',r=>r.fulfill({json:{artist_category:['Artists','Official'],artist_name:['Artist A','Artist B'],media_title:['Known world'],character_name:['Character ไทย'],filename:['folder/model.blend'],format:['BLEND']}}));
    await page.route('https://fonts.**',r=>r.abort());
    await page.goto(base,{waitUntil:'domcontentloaded'});await expect(page.locator('[data-page="2"]')).toBeVisible();
    await expect(page.locator('#count')).toHaveText('32 models');
    await expect(page.locator('#filter-summary')).toHaveText('All models');
    await page.locator('[data-page="2"]').click();await expect.poll(()=>lastURL.searchParams.get('page')).toBe('2');
    const disclosure=page.locator('#advanced-filters');await expect(disclosure).not.toHaveAttribute('open');
    await disclosure.locator('summary').click();await expect(disclosure).toHaveAttribute('open','');
    const artist=page.locator('#exclude-artist');await artist.fill('Artist A');await artist.press('ArrowDown');
    const activeID=await artist.getAttribute('aria-activedescendant');expect(activeID).toBeTruthy();await expect(page.locator('#'+activeID)).toHaveText('Artist A');
    delay=true;await artist.press('Enter');await expect(artist).toBeFocused();await expect(page.locator('.collection-loading')).toBeVisible();
    await expect.poll(()=>lastURL.searchParams.getAll('exclude_artist')).toEqual(['Artist A']);expect(lastURL.searchParams.get('page')).toBe('1');await expect(page.locator('#count')).toHaveText('0 models');
    await artist.fill('Artist B');await artist.press('Enter');await expect.poll(()=>lastURL.searchParams.getAll('exclude_artist')).toEqual(['Artist A','Artist B']);
    const world=page.locator('#exclude-world');await world.fill('Custom world ไทย');await world.press('Enter');
    await expect.poll(()=>lastURL.searchParams.get('exclude_world')).toBe('Custom world ไทย');
    await page.locator('#exclude-filename').fill('folder/');await page.locator('#exclude-filename').press('ArrowDown');await page.locator('#exclude-filename').press('Enter');
    await expect.poll(()=>lastURL.searchParams.get('exclude_filename')).toBe('folder/model.blend');
    const source=page.locator('#exclude-source');await source.fill('official');await source.press('ArrowDown');await source.press('Enter');
    await expect.poll(()=>lastURL.searchParams.getAll('exclude_source')).toEqual(['Official']);
    await source.fill('official');await source.press('Enter');await expect(page.locator('#exclude-status')).toHaveText('That name is already excluded.');
    expect(lastURL.searchParams.getAll('exclude_source')).toEqual(['Official']);
    await page.getByRole('button',{name:'Remove excluded artist Artist A',exact:true}).click();
    await expect.poll(()=>lastURL.searchParams.getAll('exclude_artist')).toEqual(['Artist B']);
    await expect(page.getByRole('button',{name:'Remove excluded artist Artist B',exact:true})).toBeFocused();
    await world.focus();await world.press('ArrowDown');await world.press('Escape');await expect(world).toBeFocused();await expect(world).toHaveAttribute('aria-expanded','false');
    await page.locator('#clear').click();await expect.poll(()=>[...lastURL.searchParams.keys()].filter(k=>k.startsWith('exclude_'))).toEqual([]);await expect(page.locator('#filter-summary')).toHaveText('All models');
    const search=page.getByRole('searchbox',{name:'Search collection'});await search.fill('query');await expect.poll(()=>lastURL.searchParams.get('q')).toBe('query');await expect(page.locator('#count')).toHaveText('7 models');
    await search.fill('');await expect.poll(()=>lastURL.searchParams.get('q')).toBeNull();await expect(page.locator('#count')).toHaveText('32 models');
    await expect(page.locator('.exclude-tag')).toHaveCount(0);
    await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    await page.locator('#exclude-character').fill('Character ไทย');await page.locator('#exclude-character').press('Enter');
    await expect.poll(()=>lastURL.searchParams.get('exclude_character')).toBe('Character ไทย');
    failModels=true;await artist.fill('Offline artist');await artist.press('Enter');
    await expect(page.locator('#retry')).toBeVisible();await expect(page.getByRole('button',{name:'Remove excluded artist Offline artist',exact:true})).toBeAttached();
    failModels=false;await page.locator('#retry').click();await expect(page.locator('#retry')).toHaveCount(0);await expect(page.locator('.collection-loading')).toHaveCount(0);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);expect(overflow).toBe(false);
    expect(errors).toEqual([]);await page.close();console.log('PASS advanced exclusions',viewport.width);
  }
}finally{await browser?.close();server.kill()}
