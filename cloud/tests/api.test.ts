import { describe,it,expect,beforeAll,afterAll } from 'vitest';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { readFileSync,readdirSync } from 'node:fs';
import worker from '../src/index';
import {canonical,sha256} from '../src/contracts';

let mf:Miniflare, env:any;
const token='test-admin-secret-32-characters-long';
async function request(path:string,body?:unknown,auth=true){
  return worker.fetch(new Request('https://api.test'+path,{method:body?'POST':'GET',headers:{...(auth?{Authorization:`Bearer ${token}`} : {}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env);
}
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['PREVIEWS'],compatibilityDate:'2026-08-06'}));
  env={DB:await mf.getD1Database('DB'),PREVIEWS:await mf.getR2Bucket('PREVIEWS'),ADMIN_TOKEN:token,PREVIEW_KEY_B64:Buffer.alloc(32,1).toString('base64'),SITE_ORIGIN:'https://site.test',DATASET_ID:'models'};
  // D1 exec accepts one statement per line; use prepare per complete SQL statement.
  for(const file of readdirSync('cloud/migrations').filter(f=>f.endsWith('.sql')).sort())for(const sql of readFileSync('cloud/migrations/'+file,'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterAll(async()=>{await mf?.dispose()});
describe('API contract',()=>{
  it('requires authentication for administration',async()=>expect((await request('/api/admin/control',undefined,false)).status).toBe(401));
  it('protects the server-rendered admin dashboard',async()=>{
    expect((await request('/admin',undefined,false)).status).toBe(401);
    const response=await worker.fetch(new Request('https://api.test/admin',{headers:{Authorization:'Basic '+Buffer.from('admin:'+token).toString('base64')}}),env);
    expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('excludes public responses from indexing',async()=>{
    const res=await request('/api/models',undefined,false);
    expect(res.status).toBe(200); expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect((await res.json() as any).items).toEqual([]);
  });
  it('does not expose future sections',async()=>expect((await (await request('/api/sections',undefined,false)).json() as any[]).map(x=>x.id)).toEqual(['models']));
  it('serializes ownership and fences stale writers after recovery',async()=>{
    expect((await request('/api/admin/begin',{run_id:'run1',generation:0,epoch:0})).status).toBe(200);
    expect((await request('/api/admin/begin',{run_id:'run2',generation:0,epoch:0})).status).toBe(409);
    const lock=await (await request('/api/admin/recovery/lock',{owner:'restore1'})).json() as any;
    expect(lock.mode).toBe('RECOVERY_LOCKED'); expect(lock.lock_epoch).toBe(1);
    expect((await request('/api/admin/tombstone',{run_id:'run1',path:'Realism/A/B/C',generation:0,epoch:0})).status).toBe(409);
    expect((await request('/api/admin/recovery/unlock',{owner:'wrong',epoch:1,generation:0,verified:true})).status).toBe(409);
    expect((await request('/api/models',undefined,false)).status).toBe(200);
  });
  it('publishes an atomic verified snapshot and exposes no private originals',async()=>{
    expect((await request('/api/admin/recovery/unlock',{owner:'restore1',epoch:1,generation:0,verified:true})).status).toBe(200);
    const fence={run_id:'publish1',generation:0,epoch:2};
    expect((await request('/api/admin/begin',fence)).status).toBe(200);
    const preview=new Uint8Array([1,2,3]).buffer,previewHash=await sha256(preview);
    await env.PREVIEWS.put('previews/test.bin',preview,{customMetadata:{sha256:previewHash}});
    const m={id:'model-1',asset_category:'Characters',local_relative_path:'Characters/Realism/Artists/Artist (Alt)/World/Character',style:'Realism',artist_category:'Artists',artist_name:'Artist (Alt)',media_title:'World',character_name:'Character ไทย',status:'ACTIVE',roles:{'picture/main.png':'main'},files:[
      {path:'file/model.pmx',kind:'model',size:10,mtime_ns:'1793600000123456789',sha256:'a'.repeat(64),remote_id:'public-model'},
      {path:'picture/main.png',kind:'image',size:10,mtime_ns:'1793600000123456789',sha256:'b'.repeat(64),remote_id:'private-original',role:'main',preview_r2_key:'previews/test.bin',preview_sha256:previewHash}
    ]};
    expect((await request('/api/admin/stage',{...fence,model:m})).status).toBe(200);
    expect((await (await request('/api/models',undefined,false)).json() as any).total).toBe(0);
    const manifest={schema:1,dataset_id:'models',generation:1,models:[{...m,artist_name:'Artist | Alt'}]};
    const body={...fence,manifest,manifest_remote_id:'private-manifest',manifest_sha256:await sha256(canonical(manifest))};
    const published=await request('/api/admin/publish',body);
    expect(published.status,await published.clone().text()).toBe(200);
    expect((await request('/api/admin/publish',body)).status).toBe(200);
    const publicResponse=await request('/api/models',undefined,false),publicText=await publicResponse.text();
    expect(JSON.parse(publicText).total).toBe(1);expect(publicText).not.toContain('private-original');expect(publicText).not.toContain('local_relative_path');
    expect(JSON.parse(publicText).items[0].asset_category).toBe('Characters');
    expect(JSON.parse(publicText).items[0].artist_name).toBe('Artist | Alt');
    expect(JSON.parse(publicText).items[0].formats).toEqual(['MMD']);
    expect(typeof JSON.parse(publicText).items[0].created_at).toBe('number');
    expect((await (await request('/api/models?format=MMD',undefined,false)).json() as any).total).toBe(1);
    expect((await (await request('/api/models?artist_name='+encodeURIComponent('Artist | Alt'),undefined,false)).json() as any).total).toBe(1);
    const paged=await (await request('/api/models?page=99&format=MMD',undefined,false)).json() as any;
    expect(paged.limit).toBe(15);expect(paged.page).toBe(1);expect(paged.items).toHaveLength(1);
    expect((await (await request('/api/models?format=BLEND',undefined,false)).json() as any).total).toBe(0);
    expect((await (await request('/api/facets',undefined,false)).json() as any).format).toEqual(['MMD']);
    expect((await (await request('/api/facets',undefined,false)).json() as any).artist_name).toEqual(['Artist | Alt']);
    expect((await (await request('/api/admin/normalize-artists',{})).json() as any).total).toBe(1);
    expect((await (await request('/api/models?asset_category=Props',undefined,false)).json() as any).total).toBe(0);
    expect((await (await request('/api/models?asset_category=Characters',undefined,false)).json() as any).total).toBe(1);
    expect((await (await request('/api/facets',undefined,false)).json() as any).asset_category).toEqual(['Characters']);
    const base=await (await request('/api/admin/baseline')).json() as any[];
    expect(base[0].files[0].mtime_ns).toBe('1793600000123456789');
    expect((await request('/api/admin/stage',{...fence,model:m})).status).toBe(409);
    const tombstone={run_id:'delete1',generation:1,epoch:2};
    expect((await request('/api/admin/begin',tombstone)).status).toBe(200);
    expect((await request('/api/admin/tombstone',{...tombstone,path:m.local_relative_path})).status).toBe(200);
    expect((await (await request('/api/models',undefined,false)).json() as any).total).toBe(0);
    // Disaster recovery undoes an uncommitted tombstone from the last complete generation.
    const lock=await (await request('/api/admin/recovery/lock',{owner:'restore2'})).json() as any;
    expect((await request('/api/admin/recovery/unlock',{owner:'restore2',epoch:lock.lock_epoch,generation:1,verified:true})).status).toBe(200);
    expect((await (await request('/api/models',undefined,false)).json() as any).total).toBe(1);
  });
  it('abandons a fenced run and allows a replacement but rejects resurrection',async()=>{
    const control=await (await request('/api/admin/control')).json() as any;
    const fence={run_id:'abandoned1',generation:control.generation,epoch:control.lock_epoch};
    expect((await request('/api/admin/begin',fence)).status).toBe(200);
    expect((await request('/api/admin/abandon',fence)).status).toBe(200);
    expect((await request('/api/admin/begin',fence)).status).toBe(409);
    expect((await request('/api/admin/begin',{...fence,run_id:'replacement1'})).status).toBe(200);
    expect((await request('/api/admin/abandon',{...fence,run_id:'replacement1'})).status).toBe(200);
  });
  it('never serves private backups through the asset route',async()=>{
    await env.PREVIEWS.put('manifests/private.json','private');
    expect((await request('/api/assets/manifests%2Fprivate.json',undefined,false)).status).toBe(404);
  });
  it('can recover and unlock after a committed deletion',async()=>{
    const c=await (await request('/api/admin/control')).json() as any;
    const fence={run_id:'delete-committed',generation:c.generation,epoch:c.lock_epoch};
    expect((await request('/api/admin/begin',fence)).status).toBe(200);
    expect((await request('/api/admin/tombstone',{...fence,path:'Characters/Realism/Artists/Artist (Alt)/World/Character'})).status).toBe(200);
    const manifest={schema:1,dataset_id:'models',generation:c.generation+1,models:[]};
    expect((await request('/api/admin/publish',{...fence,manifest,manifest_remote_id:'empty-manifest',manifest_sha256:await sha256(canonical(manifest))})).status).toBe(200);
    const locked=await (await request('/api/admin/recovery/lock',{owner:'after-delete'})).json() as any;
    const response=await request('/api/admin/recovery/unlock',{owner:'after-delete',epoch:locked.lock_epoch,generation:manifest.generation,verified:true});
    expect(response.status,await response.clone().text()).toBe(200);
  });
  it('resets test catalog with authentication and fencing while retaining sections',async()=>{
    const c=await (await request('/api/admin/control')).json() as any;
    const body={owner:'test-reset:fixture',generation:c.generation,epoch:c.lock_epoch};
    expect((await request('/api/admin/test-reset/start',body,false)).status).toBe(401);
    const locked=await (await request('/api/admin/test-reset/start',body)).json() as any;
    expect(locked.mode).toBe('MAINTENANCE');
    expect((await request('/api/admin/begin',{run_id:'stale-reset',generation:c.generation,epoch:c.lock_epoch})).status).toBe(409);
    expect((await request('/api/admin/test-reset/step',{owner:'wrong',epoch:locked.lock_epoch})).status).toBe(409);
    await env.PREVIEWS.put('previews/test.enc','preview');
    let done=false;
    for(let i=0;i<10&&!done;i++)done=(await (await request('/api/admin/test-reset/step',{owner:body.owner,epoch:locked.lock_epoch})).json() as any).done;
    expect(done).toBe(true);
    expect((await env.PREVIEWS.list()).objects).toHaveLength(0);
    expect((await (await request('/api/admin/control')).json() as any).generation).toBe(0);
    expect((await (await request('/api/sections')).json() as any[])).toHaveLength(1);
    expect((await (await request('/api/admin/snapshots')).json() as any[])).toHaveLength(0);
  });

  it('keeps original images and manifests private on R2 and prevents overwrite',async()=>{
    const c=await (await request('/api/admin/control')).json() as any;
    const key='originals/private-migration-test';
    const put=async(text:string)=>worker.fetch(new Request('https://api.test/api/admin/blobs?key='+key,{method:'PUT',headers:{Authorization:'Bearer '+token,'X-Generation':String(c.generation),'X-Lock-Epoch':String(c.lock_epoch)},body:text}),env);
    expect((await put('original-image')).status).toBe(200);
    expect((await request('/api/admin/blobs?key='+key,undefined,false)).status).toBe(401);
    const get=await request('/api/admin/blobs?key='+key);
    expect(await get.text()).toBe('original-image');
    expect((await request('/api/assets/'+encodeURIComponent(key),undefined,false)).status).toBe(404);
    expect((await put('different-image')).status).toBe(409);
    expect((await put('original-image')).status).toBe(200);
  });

  it('rejects ambient Basic credentials on all admin APIs without changing state',async()=>{
    const before=await (await request('/api/admin/control')).json();
    const auth='Basic '+Buffer.from('admin:'+token).toString('base64');
    const payload='{"owner":"attacker","unused":"="}\r\n';
    for(const path of ['/api/admin/recovery/lock','/api/admin/normalize-artists','/api/admin/test-reset/start']){
      const res=await worker.fetch(new Request('https://api.test'+path,{method:'POST',headers:{Authorization:auth,'Content-Type':'text/plain'},body:payload}),env);
      expect(res.status).toBe(401);
    }
    const res=await worker.fetch(new Request('https://api.test/api/admin/blobs?key=originals/csrf',{method:'PUT',headers:{Authorization:auth},body:'bad'}),env);
    expect(res.status).toBe(401);expect(await env.PREVIEWS.head('originals/csrf')).toBeNull();
    expect(await (await request('/api/admin/control')).json()).toEqual(before);
    expect((await worker.fetch(new Request('https://api.test/api/admin/control',{headers:{Authorization:auth}}),env)).status).toBe(401);
    expect((await worker.fetch(new Request('https://api.test/api/admin/recovery/lock',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'text/plain'},body:payload}),env)).status).toBe(415);
    expect((await request('/api/admin/control')).status).toBe(200);
  });

  it('excludes private, draft and disabled-section records from facets and assets',async()=>{
    await env.DB.prepare("INSERT INTO site_sections VALUES('hidden-test','Hidden','/hidden-test',0,99)").run();
    const fixtures=[['visible-test','models','ACTIVE','PUBLIC'],['private-test','models','ACTIVE','PRIVATE'],['disabled-test','hidden-test','ACTIVE','PUBLIC'],['draft-test','models','DRAFT','PUBLIC'],['unpublished-test','models','ACTIVE','PUBLIC']];
    try{
      for(const [id,section,status,visibility] of fixtures){
        const payload={id,character_name:id,artist_name:id,media_title:id,style:'Realism',artist_category:'Artists',files:[{kind:'model',path:'file/model.blend',formats:[id.toUpperCase()],remote_id:'id'}]};
        await env.DB.prepare('INSERT INTO content_items(id,section_id,slug,title,status,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,0,0)').bind(id,section,id,id,status,visibility).run();
        await env.DB.prepare('INSERT INTO models VALUES(?,?,?,?,?,?,?,?)').bind(id,'Realism','Artists',id,id,id,id,JSON.stringify(payload)).run();
        await env.DB.prepare('INSERT INTO model_images VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,id,'image.png','private-original','a'.repeat(64),1,'previews/'+id,'b'.repeat(64),'main',0,1,1).run();
        await env.PREVIEWS.put('previews/'+id,'preview');
      }
      const beforeControl=await (await request('/api/admin/control')).json();
      expect((await request('/api/admin/publication',{ids:['unpublished-test'],published:false})).status).toBe(200);
      const facets=await (await request('/api/facets',undefined,false)).json() as any;
      expect(facets.artist_name).toContain('visible-test');expect(facets.format).toContain('VISIBLE-TEST');
      for(const id of ['private-test','disabled-test','draft-test','unpublished-test']){
        expect(JSON.stringify(facets)).not.toContain(id);expect(facets.format).not.toContain(id.toUpperCase());
        expect((await request('/api/assets/previews/'+id,undefined,false)).status).toBe(404);
        expect((await request('/api/models/'+id,undefined,false)).status).toBe(404);
      }
      expect((await request('/api/assets/previews/visible-test',undefined,false)).status).toBe(200);
      const catalog=await (await request('/api/models',undefined,false)).json() as any;
      expect(catalog.items.some((item:any)=>item.id==='unpublished-test')).toBe(false);
      expect((await request('/api/admin/publication',{ids:['unpublished-test'],published:true})).status).toBe(200);
      expect((await request('/api/models/unpublished-test',undefined,false)).status).toBe(200);
      expect(await (await request('/api/admin/control')).json()).toEqual(beforeControl);
    }finally{
      for(const [id] of fixtures){await env.DB.prepare('DELETE FROM publication_overrides WHERE content_id=?').bind(id).run();await env.DB.prepare('DELETE FROM model_images WHERE content_id=?').bind(id).run();await env.DB.prepare('DELETE FROM models WHERE content_id=?').bind(id).run();await env.DB.prepare('DELETE FROM content_items WHERE id=?').bind(id).run();await env.PREVIEWS.delete('previews/'+id)}
      await env.DB.prepare("DELETE FROM site_sections WHERE id='hidden-test'").run();
    }
  });

});
