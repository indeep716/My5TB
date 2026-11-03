import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {publicationRoute} from '../src/publication';

let mf:Miniflare,env:any;
const token='publication-admin-token-with-32-characters';
async function req(body?:unknown,auth=true,path='/api/admin/publication'){
  return (await publicationRoute(new Request('https://api.test'+path,{method:body===undefined?'GET':'POST',headers:{...(auth?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env))!;
}
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],compatibilityDate:'2026-08-06'}));
  env={DB:await mf.getD1Database('DB'),ADMIN_TOKEN:token};
  for(const file of ['0001.sql','0002_publication.sql','0004_model_details.sql'])for(const sql of readFileSync('cloud/migrations/'+file,'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))await env.DB.prepare(sql).run();
  for(const id of ['a','b']){
    await env.DB.prepare("INSERT INTO content_items(id,section_id,slug,title,status,created_at,updated_at) VALUES(?,'models',?,?,'ACTIVE',1,1)").bind(id,id,id).run();
    await env.DB.prepare("INSERT INTO models VALUES(?,'Realism','Artists','Artist','World',?,?,?)").bind(id,id,'Realism/Artist/World/'+id,JSON.stringify({id,status:'ACTIVE'})).run();
  }
});
afterAll(async()=>{await mf?.dispose()});
describe('persistent publication control',()=>{
  it('stores optional details and rejects unsafe links',async()=>{
    const body={id:'a',upload_by:'Uploader',link:'https://example.com',description:'Details'};
    expect((await req(body,true,'/api/admin/publication/details')).status).toBe(200);
    expect((await env.DB.prepare("SELECT upload_by FROM model_details WHERE content_id='a'").first() as any).upload_by).toBe('Uploader');
    expect((await req({...body,link:'javascript:alert(1)'},true,'/api/admin/publication/details')).status).toBe(400);
    expect((await req({...body,upload_by:'',link:'',description:''},true,'/api/admin/publication/details')).status).toBe(200);
  });
  it('requires JSON and stops reading an oversized streamed body',async()=>{
    const wrongType=await publicationRoute(new Request('https://api.test/api/admin/publication',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'text/plain'},body:JSON.stringify({ids:['a'],published:true})}),env);
    expect(wrongType?.status).toBe(415);
    let pulls=0,cancelled=false;
    const stream=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(12000));if(pulls===100)controller.close()},cancel(){cancelled=true}});
    const request=new Request('https://api.test/api/admin/publication',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:stream,duplex:'half'} as RequestInit);
    expect((await publicationRoute(request,env))?.status).toBe(413);
    expect(pulls).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });
  it('requires a configured Bearer token and bounds input',async()=>{
    expect((await req(undefined,false)).status).toBe(401);
    for(const body of [{ids:[],published:false},{ids:['a'],published:'false'},{ids:['../a'],published:true},{ids:Array(201).fill('a'),published:true}])expect((await req(body)).status).toBe(400);
    expect((await req(undefined,true,'/api/admin/publication?limit=999')).status).toBe(400);
  });
  it('preserves snapshot payload and sync generation across hide and later upsert',async()=>{
    const baseline=await env.DB.prepare("SELECT payload FROM models WHERE content_id='a'").first();
    expect((await req({ids:['a'],published:false})).status).toBe(200);
    expect(await env.DB.prepare("SELECT payload FROM models WHERE content_id='a'").first()).toEqual(baseline);
    await env.DB.prepare("UPDATE content_items SET title='Changed',status='ACTIVE' WHERE id='a'").run();
    const page=await (await req()).json() as any;
    expect(page.items.find((m:any)=>m.id==='a').published).toBe(false);
    expect(page.items.find((m:any)=>m.id==='b').published).toBe(true);
    expect((await env.DB.prepare("SELECT generation FROM sync_control").first() as any).generation).toBe(0);
    expect((await req({ids:['a'],published:true})).status).toBe(200);
    expect((await (await req()).json() as any).items.every((m:any)=>m.published)).toBe(true);
  });
  it('rejects unknown models without a partial mutation',async()=>{
    expect((await req({ids:['a','missing'],published:false})).status).toBe(404);
    expect((await (await req()).json() as any).items.find((m:any)=>m.id==='a').published).toBe(true);
  });
});
