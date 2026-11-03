import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const base='http://127.0.0.1:5189';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5189','--strictPort'],{stdio:'ignore'});
let browser;
const zip={name:'character.zip',mimeType:'application/zip',buffer:Buffer.from([0x50,0x4b,3,4,0,0,0,0])};
const png={name:'reference.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')};
const gif={name:'animated.gif',mimeType:'image/gif',buffer:Buffer.from('R0lGODlhCAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBFAABACwAAAAACAAIAIEAAP8AAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7','base64')};
async function pageAt(path,viewport={width:1440,height:1000}){
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>sessionStorage.setItem('my5tb-age','yes'));
  // Match production CSP; Blob URL fetches are deliberately not allowed.
  await page.route(base+'/**',async route=>{
    if(route.request().resourceType()!=='document'){await route.fallback();return}
    const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self'; base-uri 'self'; form-action 'self'"}});
  });
  await page.route('https://fonts.**',r=>r.abort());
  await page.route('**/api/facets',r=>r.fulfill({json:{artist_category:['Artists'],artist_name:['Studio'],media_title:['World'],character_name:['Character']}}));
  await page.goto(base+path,{waitUntil:'domcontentloaded'});return {page,errors};
}
async function fill(page){for(const [name,value] of Object.entries({source:'Artists',artist:'ศิลปิน',media_title:'World',character_name:'Character'}))await page.locator('#submission-'+name).fill(value);await page.locator('#submission-archive').setInputFiles(zip)}
try{
  for(let i=0;i<60;i++){try{if((await fetch(base)).ok)break}catch{}await new Promise(r=>setTimeout(r,200))}
  browser=await chromium.launch({channel:'msedge',headless:true});
  {
    const {page,errors}=await pageAt('/contribute');
    await expect(page).toHaveTitle('Contribute - My5TB');
    await page.locator('#submission-images').setInputFiles(gif);const image=page.locator('.submission-image img');await expect(image).toHaveJSProperty('naturalWidth',8);
    const animation=await image.getAttribute('src');
    await image.scrollIntoViewIfNeeded();await page.waitForTimeout(250);const frames=new Set();for(let i=0;i<8;i++){frames.add((await image.screenshot()).toString('base64'));await page.waitForTimeout(60)}expect(frames.size).toBeGreaterThan(1);
    await expect(page.locator('#submission-motion')).toHaveCount(0);await page.emulateMedia({reducedMotion:'reduce'});await expect.poll(()=>image.getAttribute('src')).not.toBe(animation);
    await page.getByRole('button',{name:'Remove animated.gif',exact:true}).click();await expect(image).toHaveCount(0);expect(errors).toEqual([]);await page.close();console.log('PASS animated GIF thumbnail, pause/play, reduced motion and removal');
  }
  {
    const {page,errors}=await pageAt('/contribute');let creates=0;
    await page.route('**/api/submissions',r=>{creates++;return r.fulfill({status:201,json:{id:'archive-test',token:'token',part_size:33554432}})});
    await page.route('**/api/submissions/archive-test/parts/*',r=>r.fulfill({json:{etag:'part'}}));
    await page.route('**/api/submissions/archive-test/complete',r=>r.fulfill({json:{id:'archive-test',status:'READY',report:{inspection:'metadata',summary:'Manual review required',model_presence:'declared'}}}));
    await fill(page);await page.locator('#submission-archive').setInputFiles({...zip,name:'wrong.rar'});await page.locator('#submit-contribution').click();await expect(page.locator('#submission-status')).toContainText('do not match');expect(creates).toBe(0);
    for(const name of ['declared-model-compressed-rar5.rar','model-lzma2-solid.7z']){
      await page.locator('#submission-archive').setInputFiles({name,mimeType:'application/octet-stream',buffer:readFileSync('cloud/tests/fixtures/archives/'+name)});
      await page.locator('#submit-contribution').click();await expect(page.locator('#submission-status')).toContainText('model contents require manual review');await expect(page.locator('#submit-contribution')).toBeEnabled();
    }
    expect(creates).toBe(2);expect(errors).toEqual([]);await page.close();console.log('PASS RAR/7z form acceptance, signature mismatch and manual-review receipt');
  }
  {
    const {page,errors}=await pageAt('/about',{width:390,height:844});
    await expect(page.locator('#community-title')).toContainText('A personal archive.');await expect(page.locator('.contact-email')).toHaveAttribute('href','mailto:indeep716@gmail.com');
    await expect(page.locator('.collection')).toBeHidden();await page.locator('#menu-toggle').click();await expect(page.locator('.mobile-utility-nav')).toBeVisible();await page.locator('#mobile-theme').click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);await page.close();console.log('PASS contact mobile navigation/theme');
  }
  {
    const {page,errors}=await pageAt('/about',{width:1440,height:1200});await page.waitForTimeout(300);
    const gap=await page.evaluate(()=>Math.abs(document.querySelector('footer').getBoundingClientRect().bottom-innerHeight));expect(gap).toBeLessThan(1);
    expect(errors).toEqual([]);await page.close();console.log('PASS contact footer anchors to viewport bottom');
  }
  {
    const {page,errors}=await pageAt('/contribute');let created=0,parts=0,images=0;
    await page.route('**/api/submissions',async r=>{created++;const data=r.request().postDataJSON();expect(data.artist).toBe('ศิลปิน');expect(data.image_count).toBe(1);await r.fulfill({status:201,json:{id:'sample',token:'test-token',part_size:33554432}})});
    await page.route('**/api/submissions/sample/parts/*',r=>{parts++;return r.fulfill({json:{etag:'part'}})});
    await page.route('**/api/submissions/sample/images/*',r=>{images++;return r.fulfill({json:{ok:true}})});
    await page.route('**/api/submissions/sample/complete',r=>r.fulfill({json:{id:'sample',status:'READY',report:{models:['character.blend']}}}));
    await page.locator('#submit-contribution').click();expect(created).toBe(0);await expect(page.locator('.contribution-fields input[aria-invalid=true]')).toHaveCount(4);await expect(page.locator('#archive-drop')).toHaveAttribute('aria-invalid','true');await expect(page.locator('#archive-drop')).toHaveCSS('border-top-style','solid');await expect(page.locator('#submission-source')).toBeFocused();expect(await page.evaluate(()=>scrollY)).toBeGreaterThan(0);
    await fill(page);await page.locator('#submission-images').setInputFiles([png,{...png,name:'other.png'}]);await expect(page.locator('.submission-image')).toHaveCount(2);await page.getByRole('button',{name:'Remove other.png',exact:true}).click();await expect(page.locator('.submission-image')).toHaveCount(1);
    await page.locator('#submit-contribution').click();await expect(page.locator('#submission-status')).toContainText('Submission received for private review');expect(created).toBe(1);expect(parts).toBe(1);expect(images).toBe(1);await expect(page.locator('#submission-progress')).toHaveJSProperty('value',100);await expect(page.locator('.submission-image')).toHaveCount(0);expect(errors).toEqual([]);await page.close();console.log('PASS required fields, Thai input, file/image removal and upload completion');
  }
  {
    const {page,errors}=await pageAt('/contribute',{width:390,height:844});let deleted=0;
    await page.route('**/api/submissions',r=>r.fulfill({status:201,json:{id:'cancel',token:'token',part_size:33554432}}));
    await page.route('**/api/submissions/cancel/parts/*',async r=>{await new Promise(resolve=>setTimeout(resolve,1200));try{await r.fulfill({json:{etag:'part'}})}catch{}});
    await page.route('**/api/submissions/cancel',r=>{deleted++;return r.fulfill({json:{ok:true}})});
    await fill(page);await page.locator('#submit-contribution').click();await expect(page.locator('#cancel-contribution')).toBeVisible();await page.locator('#cancel-contribution').click();await expect(page.locator('#submission-status')).toContainText('Upload cancelled');expect(deleted).toBeLessThanOrEqual(1);await expect(page.locator('.selected-archive')).toBeVisible();await expect(page.locator('#submit-contribution')).toBeEnabled();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);await page.close();console.log('PASS upload cancellation and preserved selection on mobile');
  }
  {
    const {page,errors}=await pageAt('/contribute');let cleanupFails=true,deletes=0;
    await page.route('**/api/submissions',r=>r.fulfill({status:201,json:{id:'cleanup',token:'token',part_size:33554432}}));
    await page.route('**/api/submissions/cleanup/parts/*',r=>r.fulfill({status:503,json:{error:'Transfer interrupted'}}));
    await page.route('**/api/submissions/cleanup',r=>{deletes++;return cleanupFails?r.fulfill({status:409,json:{error:'Another operation is in progress'}}):r.fulfill({json:{deleted:true}})});
    await fill(page);await page.locator('#submit-contribution').click();await expect(page.locator('#submission-status')).toContainText('Cleanup is pending');expect(deletes).toBe(3);
    cleanupFails=false;await page.getByRole('button',{name:'Retry cleanup',exact:true}).click();await expect(page.locator('#submission-status')).toHaveText('Temporary upload removed.');expect(deletes).toBe(4);await expect(page.locator('#cancel-contribution')).toBeHidden();await expect(page.locator('.selected-archive')).toBeVisible();expect(errors).toEqual([]);await page.close();console.log('PASS cleanup race retains capability and can retry');
  }
  {
    const {page,errors}=await pageAt('/contribute');
    await page.route('**/api/submissions',r=>r.fulfill({status:429,json:{error:'Submission quota reached. Please try later.'}}));await fill(page);await page.locator('#submit-contribution').click();await expect(page.locator('#submission-status')).toContainText('Submission quota reached');await expect(page.locator('#submit-contribution')).toBeEnabled();await expect(page.locator('.selected-archive')).toBeVisible();expect(errors).toEqual([]);await page.close();console.log('PASS server rejection retains form and ends pending state');
  }
}finally{await browser?.close();server.kill()}
