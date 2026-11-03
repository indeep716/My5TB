import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createCipheriv,createHash} from 'node:crypto';

const base='http://127.0.0.1:5187';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5187','--strictPort'],{stdio:'ignore'});
const key=Buffer.alloc(32,1),nonce=Buffer.alloc(12,2);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const cipher=createCipheriv('aes-256-gcm',key,nonce);
const encrypted=Buffer.concat([nonce,cipher.update(png),cipher.final(),cipher.getAuthTag()]);
const sha=createHash('sha256').update(encrypted).digest('hex');
const model={id:'fixture-model',title:'Fixture',style:'Realism',artist_category:'Artists',artist_name:'Artist',media_title:'World',files:[{filename:'model.blend',size:10,sha256:'a'.repeat(64),url:'https://drive.google.com/file/d/test/view',formats:['BLEND']}],images:[0,1].map(i=>({key:`previews/${i}`,sha256:sha,role:i?'sub':'main',width:1,height:1}))};
let browser;
async function fixture(options={}){
  const page=await browser.newPage({viewport:options.viewport||{width:1440,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>sessionStorage.setItem('my5tb-age','yes'));
  await page.route('**/api/models?*',r=>r.fulfill({json:{items:[model],total:1,page:1,limit:15}}));
  await page.route('**/api/models/fixture-model',r=>r.fulfill({json:model}));
  await page.route('**/api/facets',r=>r.fulfill({json:{artist_name:['Artist','Other'],media_title:['World'],format:['BLEND']}}));
  let keyCalls=0;
  await page.route('**/api/preview-key',r=>{keyCalls++;return keyCalls===1&&options.failKey?r.fulfill({status:503,body:'unavailable'}):r.fulfill({json:{key:key.toString('base64')}})});
  await page.route('**/api/assets/**',r=>r.fulfill({body:encrypted,contentType:'application/octet-stream'}));
  await page.route('https://fonts.**',r=>r.abort());
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await expect(page.locator('.card-open')).toBeVisible();
  return {page,errors,keyCalls:()=>keyCalls};
}
const checks={
  async titleAndIcon(){
    const {page,errors}=await fixture();
    await expect(page).toHaveTitle('My5TB');
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href','/site-icon.png');
    await page.goto(base+'/Characters?asset_category=Characters',{waitUntil:'domcontentloaded'});
    await expect(page.locator('.card-open')).toBeVisible();
    await expect(page).toHaveTitle('Characters - My5TB');
    await page.goto(base+'/Characters/fixture-model',{waitUntil:'domcontentloaded'});
    await expect(page.locator('#detail-title')).toHaveText('Fixture');
    await expect(page).toHaveTitle('Characters - My5TB');
    expect(errors).toEqual([]);await page.close();
  },
  async palette(){
    const {page,errors}=await fixture();
    await page.waitForTimeout(240);
    const read=()=>page.evaluate(()=>{const root=getComputedStyle(document.documentElement),body=getComputedStyle(document.body);return {
      paper:root.getPropertyValue('--paper').trim(),surface:root.getPropertyValue('--surface').trim(),ink:root.getPropertyValue('--ink').trim(),
      muted:root.getPropertyValue('--muted').trim(),brand:root.getPropertyValue('--brand').trim(),blue:root.getPropertyValue('--blue').trim(),
      pale:root.getPropertyValue('--pale').trim(),danger:root.getPropertyValue('--danger').trim(),success:root.getPropertyValue('--success').trim(),
      bodyBackground:body.backgroundColor
    }});
    const light=await read();
    expect(light.paper).toBe('#f8f4f0');expect(light.surface).toBe('#fffdfb');expect(light.ink).toBe('#323835');
    expect(light.muted).toBe('#505756');expect(light.brand).toBe('#3a5455');expect(light.blue).toBe('#3a5455');
    expect(light.pale).toBe('#fbe9e0');expect(light.danger).toBe('#9d6466');expect(light.success).toBe('#5f786c');
    expect(light.bodyBackground).toBe('rgb(248, 244, 240)');
    expect(await page.locator('.brand').first().evaluate(e=>getComputedStyle(e).color)).toBe('rgb(58, 84, 85)');
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    await page.waitForTimeout(240);
    const dark=await read();
    expect(dark.paper).toBe('#1d2523');expect(dark.surface).toBe('#29322f');expect(dark.ink).toBe('#f8f4f0');
    expect(dark.brand).toBe('#3a5455');expect(dark.blue).not.toBe('#4c78c9');expect(dark.bodyBackground).toBe('rgb(29, 37, 35)');
    expect(await page.locator('.brand').first().evaluate(e=>getComputedStyle(e).color)).toBe('rgb(165, 189, 183)');
    expect(errors).toEqual([]);await page.close();
  },
  async sidebar(){
    const {page,errors}=await fixture({viewport:{width:390,height:1000}});await page.locator('#menu-toggle').click();
    const rows=await page.locator('#mobile-menu .mobile-type-nav>a,#mobile-menu .mobile-type-nav>button,#mobile-menu .mobile-utility-nav>a').evaluateAll(nodes=>nodes.map(e=>{const c=getComputedStyle(e),r=e.getBoundingClientRect();return {left:r.left+parseFloat(c.borderLeftWidth)+parseFloat(c.paddingLeft),height:r.height,line:c.lineHeight}}));
    expect(new Set(rows.map(r=>r.left)).size).toBe(1);for(const row of rows){expect(Math.abs(row.height-62)).toBeLessThan(.1);expect(row.line).toBe('20px')}
    const bounds=await page.locator('#mobile-menu').boundingBox();expect(bounds.width).toBe(390);expect(Math.abs(bounds.height-1000)).toBeLessThan(.1);
    const gap=await page.evaluate(()=>document.querySelector('.mobile-type-nav').getBoundingClientRect().top-document.querySelector('.mobile-menu-heading').getBoundingClientRect().bottom);expect(Math.abs(gap)).toBeLessThan(1);
    await page.locator('#mobile-menu').click({position:{x:180,y:650}});await expect(page.locator('#mobile-menu')).toBeVisible();await expect(page.locator('#menu-close')).toHaveCSS('border-top-width','1px');
    await page.locator('#menu-close').click();await expect(page.locator('#mobile-menu')).not.toBeVisible();
    await page.screenshot({path:'data/qa/sidebar-aligned.png'});expect(errors).toEqual([]);await page.close();
  },
  async header(){
    const {page,errors}=await fixture({viewport:{width:390,height:600}});await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';window.scrollTo(0,400)});await expect(page.locator('.header')).toHaveClass(/header-hidden/);
    await page.evaluate(()=>window.scrollBy(0,-5));await expect(page.locator('.header')).not.toHaveClass(/header-hidden/);
    await page.locator('#menu-toggle').click();await expect(page.locator('#mobile-menu')).toBeVisible();await expect(page.locator('.header')).not.toHaveClass(/header-hidden/);
    await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:900});await expect(page.locator('.header')).not.toHaveClass(/header-hidden/);expect(errors).toEqual([]);await page.close();
  },
  async details(){
    const {page,errors}=await fixture();
    await page.route('**/api/models/fixture-model',r=>r.fulfill({json:{...model,upload_by:'Uploader',link:'https://example.com/'+ 'long'.repeat(100),description:'First line\nSecond line\nThird line\nFourth line'}}));
    await page.locator('.card-open').click();await expect(page.locator('.detail-uploader')).toHaveText('Uploader');await expect(page).toHaveURL(/\/Characters\/fixture-model/);
    const link=page.locator('.model-external-link');await expect(link).toHaveAttribute('target','_blank');await expect(link.locator('.material-symbols-outlined')).toHaveText('open_in_new');
    await expect(page.locator('.description-text')).toHaveCSS('-webkit-line-clamp','3');await page.locator('#description-toggle').click();await expect(page.locator('#description-toggle')).toHaveAttribute('aria-expanded','true');await expect(page.locator('.description-text')).toHaveClass(/expanded/);expect(errors).toEqual([]);await page.close();
  },
  async slide(){
    const {page,errors}=await fixture();await page.locator('.card-open').click();await expect(page.locator('#detail-image')).toHaveAttribute('alt','Fixture preview 1 of 2');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(()=>document.querySelector('#detail-image').getAnimations().some(a=>a.effect.getKeyframes()[0].transform==='translateX(100%)'));
    await page.waitForTimeout(250);await expect(page.locator('.gallery-outgoing')).toHaveCount(0);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(()=>document.querySelector('#detail-image').getAnimations().some(a=>a.effect.getKeyframes()[0].transform==='translateX(-100%)'));
    await page.emulateMedia({reducedMotion:'reduce'});await page.keyboard.press('ArrowRight');await expect(page.locator('#detail-image')).toHaveAttribute('alt','Fixture preview 2 of 2');
    expect(await page.locator('#detail-image').evaluate(e=>e.getAnimations().length)).toBe(0);await expect(page.locator('.gallery-outgoing')).toHaveCount(0);
    expect(errors).toEqual([]);await page.close();
  },
  async bfcache(){
    const {page,errors}=await fixture();await expect(page.locator('.card-visual img')).toHaveJSProperty('naturalWidth',1);
    const old=await page.locator('.card-visual img').getAttribute('src');
    await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    expect(await page.evaluate(async url=>(await fetch(url)).ok,old)).toBe(true);
    await page.locator('.card-open').click();await expect(page.locator('#detail-image')).toHaveJSProperty('naturalWidth',1);
    await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false})));
    expect(await page.evaluate(async url=>{try{await fetch(url);return false}catch{return true}},old)).toBe(true);
    await page.keyboard.press('ArrowRight');await expect(page.locator('#detail-image')).toHaveAttribute('alt','Fixture preview 2 of 2');
    await page.keyboard.press('ArrowLeft');await expect(page.locator('#detail-image')).toHaveAttribute('alt','Fixture preview 1 of 2');
    await expect(page.locator('#detail-image')).toHaveJSProperty('naturalWidth',1);
    expect(await page.locator('#detail-image').getAttribute('src')).not.toBe(old);
    expect(errors).toEqual([]);await page.close();
  },
  async viewport(){
    const {page,errors}=await fixture({viewport:{width:640,height:300}});await page.locator('.card-open').click();
    await expect(page.locator('#detail-title')).toHaveText('Fixture');
    const before=await page.locator('#detail-dialog').boundingBox();const info=await page.locator('.detail-info').boundingBox();expect(info.height).toBeGreaterThan(100);
    await page.locator('.download-row a').scrollIntoViewIfNeeded();await expect(page.locator('.download-row a')).toBeInViewport();
    await page.keyboard.press('ArrowRight');await expect(page.locator('#detail-image')).toHaveAttribute('alt','Fixture preview 2 of 2');
    const after=await page.locator('#detail-dialog').boundingBox();expect(Math.abs(after.height-before.height)).toBeLessThan(.5);expect(errors).toEqual([]);await page.close();
  },
  async combobox(){
    const {page,errors}=await fixture();const input=page.locator('#artist_name');
    await input.focus();await input.press('ArrowDown');
    let id=await input.getAttribute('aria-activedescendant');expect(id).toBeTruthy();await expect(page.locator('#'+id)).toHaveClass(/active/);
    await input.press('Escape');await expect(input).toBeFocused();await expect(input).toHaveAttribute('aria-expanded','false');
    await input.press('ArrowUp');id=await input.getAttribute('aria-activedescendant');await expect(page.locator('#'+id)).toHaveText('Other');
    await input.press('Enter');await expect(input).toHaveValue('Other');await expect(input).toBeFocused();await expect(input).not.toHaveAttribute('aria-activedescendant');
    await input.click();await page.locator('#media_title').focus();await expect(input).toHaveAttribute('aria-expanded','false');
    expect(errors).toEqual([]);await page.close();
  },
  async dialog(){
    const {page,errors}=await fixture();await page.locator('.card-open').click();
    await expect(page.locator('#detail-title')).toHaveText('Fixture');
    await page.evaluate(()=>{document.querySelector('#close-detail').click();history.pushState({},'', '/models/fixture-model');dispatchEvent(new PopStateEvent('popstate'))});
    await page.waitForTimeout(250);
    await expect(page.locator('#detail-dialog')).toBeVisible();await expect(page.locator('#detail-title')).toHaveText('Fixture');
    expect(errors).toEqual([]);await page.close();
  },
  async preview(){
    const {page,errors,keyCalls}=await fixture({failKey:true});
    await expect(page.locator('.card-visual img')).toHaveAttribute('alt','Preview unavailable');
    await page.locator('.card-open').click();
    await expect(page.locator('#detail-image')).toHaveJSProperty('naturalWidth',1);
    expect(keyCalls()).toBe(2);expect(errors).toEqual([]);await page.close();
  }
};
try{
  let ready=false;for(let i=0;i<60;i++){try{ready=(await fetch(base)).ok;if(ready)break}catch{}await new Promise(r=>setTimeout(r,100))}
  if(!ready)throw new Error('Vite test server unavailable');
  browser=await chromium.launch({channel:'msedge',headless:true});
  const selected=process.argv.slice(2);if(selected.some(name=>!checks[name]))throw new Error('Unknown regression check');for(const [name,check] of Object.entries(checks)){if(selected.length&&!selected.includes(name))continue;await check();console.log('PASS',name)}
}finally{await browser?.close();server.kill()}
