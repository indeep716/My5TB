import {beforeAll,afterAll,it,expect} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/index';

let mf:Miniflare,env:any;
async function get(query='',route='/api/models'){
  const response=await worker.fetch(new Request('https://api.test'+route+query),env);
  return {status:response.status,body:await response.json() as any};
}
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['PREVIEWS'],compatibilityDate:'2026-08-06'}));
  env={DB:await mf.getD1Database('DB'),PREVIEWS:await mf.getR2Bucket('PREVIEWS')};
  for(const migration of readdirSync('cloud/migrations').filter(name=>name.endsWith('.sql')).sort())for(const sql of readFileSync('cloud/migrations/'+migration,'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))await env.DB.prepare(sql).run();
  await env.DB.prepare("INSERT INTO site_sections VALUES('disabled','Disabled','/disabled',0,99)").run();
  for(let i=0;i<22;i++){
    const id='exclude-fixture-'+i;
    const m={id,style:'Realism',artist_category:i===0?'Official':'Artists',artist_name:i===1?'Dual (Alias)':'Artist '+i,media_title:i===2?'Excluded world':'World',character_name:i===3?'Excluded character':'Character '+i,status:'ACTIVE',local_relative_path:'Realism/'+id,
      files:[{path:i===4?'file/100%_special.blend':'file/model-'+i+'.zip',kind:'model',size:10,remote_id:'file',formats:['BLEND'],contents:i===5?['inside/hidden-name.blend']:[]}]};
    await env.DB.prepare("INSERT INTO content_items(id,section_id,slug,title,status,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,0,0)").bind(id,i===20?'disabled':'models',id,m.character_name,i===18?'DRAFT':'ACTIVE',i===19?'PRIVATE':'PUBLIC').run();
    await env.DB.prepare('INSERT INTO models VALUES(?,?,?,?,?,?,?,?)').bind(id,m.style,m.artist_category,m.artist_name,m.media_title,m.character_name,m.local_relative_path,JSON.stringify(m)).run();
  }
  await env.DB.prepare("INSERT INTO publication_overrides(content_id,published) VALUES('exclude-fixture-21',0)").run();
});
afterAll(async()=>{await mf?.dispose()});

it('combines multiple exclusion types before total count and page clamping',async()=>{
  const params=new URLSearchParams({page:'99',exclude_source:'official',exclude_artist:'Dual | Alias',exclude_world:'Excluded world',exclude_character:'Excluded character',exclude_filename:'hidden-name'});
  params.append('exclude_artist','Artist 6');
  const {status,body}=await get('?'+params);
  expect(status).toBe(200);expect(body.total).toBe(12);expect(body.page).toBe(1);expect(body.items).toHaveLength(12);
  for(const i of [0,1,2,3,5,6])expect(body.items.map((m:any)=>m.id)).not.toContain('exclude-fixture-'+i);
});
it('treats filename wildcard characters and SQL-looking values literally',async()=>{
  expect((await get('?exclude_filename='+encodeURIComponent('100%_'))).body.total).toBe(17);
  expect((await get('?exclude_artist='+encodeURIComponent("' OR 1=1 --"))).body.total).toBe(18);
  expect((await get('?exclude_character=Unknown')).body.total).toBe(18);
});
it('limits exclusion counts and lengths without silently ignoring rules',async()=>{
  const params=new URLSearchParams();for(let i=0;i<21;i++)params.append('exclude_world','World '+i);
  expect((await get('?'+params)).status).toBe(400);
  expect((await get('?exclude_filename='+'a'.repeat(201))).status).toBe(400);
  const maximum=new URLSearchParams();for(const field of ['source','artist','world','character','filename'])for(let i=0;i<20;i++)maximum.append('exclude_'+field,'Unknown '+i);
  expect((await get('?'+maximum)).body.total).toBe(18);
});
it('offers characters and outer/inner filenames only from public active enabled records',async()=>{
  const {body}=await get('','/api/facets');
  expect(body.character_name).toContain('Excluded character');expect(body.character_name).not.toContain('Character 18');expect(body.character_name).not.toContain('Character 19');expect(body.character_name).not.toContain('Character 20');
  expect(body.character_name).not.toContain('Character 21');
  expect(body.filename).toContain('100%_special.blend');expect(body.filename).toContain('inside/hidden-name.blend');expect(body.filename).not.toContain('model-19.zip');expect(body.filename).not.toContain('model-21.zip');
});
