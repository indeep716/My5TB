import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {deflateRawSync} from 'node:zlib';
import {handleSubmissions,cleanupSubmissions,validateSubmissionZip} from '../src/submissions';

let mf:Miniflare,env:any,ip=0;
const admin='test-admin-token-with-32-characters';
function zip(name='model.blend',data=Buffer.from('BLENDER-v400\0model'),deflate=false){
  const payload=deflate?deflateRawSync(data):data,n=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(deflate?8:0,8);local.writeUInt32LE(payload.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(deflate?8:0,10);central.writeUInt32LE(payload.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(n.length,28);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+n.length,12);end.writeUInt32LE(local.length+n.length+payload.length,16);
  return Buffer.concat([local,n,payload,central,n,end]);
}
async function req(path:string,method='GET',body?:unknown,token?:string,adminAuth=false){
  const binary=body instanceof Uint8Array;
  return (await handleSubmissions(new Request('https://api.test'+path,{method,headers:{'CF-Connecting-IP':`203.0.113.${ip}`,...(binary?{'Content-Length':String(body.byteLength)}:{'Content-Type':'application/json'}),...(token?{'X-Upload-Token':token}:{}),...(adminAuth?{Authorization:`Bearer ${admin}`}:{})},body:body===undefined?undefined:binary?body:JSON.stringify(body)}),env))!;
}
async function create(data=zip(),extra={}){ip++;const response=await req('/api/submissions','POST',{source:'Original source',artist:'Artist',media_title:'Title',character_name:'ตัวละคร',archive_name:'model.zip',archive_size:data.length,image_count:0,...extra});expect(response.status,await response.clone().text()).toBe(201);return await response.json() as any;}
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['PREVIEWS'],compatibilityDate:'2026-08-06'}));
  env={DB:await mf.getD1Database('DB'),PREVIEWS:await mf.getR2Bucket('PREVIEWS'),ADMIN_TOKEN:admin};
  for(const file of ['0003_submissions.sql','0005_submission_details.sql'])for(const sql of readFileSync('cloud/migrations/'+file,'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))await env.DB.prepare(sql).run();
});
afterAll(async()=>{await mf?.dispose()});
describe('private public submissions',()=>{
  it('allows repeated retries after confirmed cancellation for the same IP',async()=>{
    ip++;const bytes=zip();for(let i=0;i<5;i++){
      const response=await req('/api/submissions','POST',{source:'s',artist:'a',media_title:'m',character_name:'c',archive_name:'x.zip',archive_size:bytes.length});expect(response.status).toBe(201);const s=await response.json() as any;
      expect((await req(`/api/submissions/${s.id}`,'DELETE',undefined,s.token)).status).toBe(200);
    }
  });
  it('retains optional contributor details privately and validates links',async()=>{
    const s=await create(zip(),{upload_by:'Contributor',link:'https://example.com',description:'Optional description'});
    const list=await (await req('/api/admin/submissions','GET',undefined,undefined,true)).json() as any;
    expect(list.items.find((item:any)=>item.id===s.id)).toMatchObject({upload_by:'Contributor',link:'https://example.com',description:'Optional description'});
    await req(`/api/submissions/${s.id}`,'DELETE',undefined,s.token);
    ip++;expect((await req('/api/submissions','POST',{source:'s',artist:'a',media_title:'m',character_name:'c',archive_name:'x.zip',archive_size:100,link:'javascript:alert(1)'})).status).toBe(400);
  });
  it('accepts RAR4/RAR5 and compressed-header 7z privately with manual-review reports',async()=>{
    for(const [file,name] of [['declared-model-compressed-rar4.rar','model.rar'],['declared-model-compressed-rar5.rar','model.rar'],['model-lzma1-solid.7z','model.7z'],['model-lzma2-solid.7z','model.7z']]){
      const bytes=readFileSync('cloud/tests/fixtures/archives/'+file),s=await create(bytes,{archive_name:name});
      expect((await req(`/api/submissions/${s.id}/parts/1`,'PUT',bytes,s.token)).status).toBe(200);
      const done=await req(`/api/submissions/${s.id}/complete`,'POST',{},s.token);expect(done.status).toBe(200);const result=await done.json() as any;
      expect(result.status,JSON.stringify(result.report)).toBe('READY');expect(result.report.inspection).toBe('metadata');expect(result.report.model_presence).toBe('declared');expect(result.report.warnings.length).toBeGreaterThan(0);
      const download=await req(`/api/admin/submissions/${s.id}/archive`,'GET',undefined,undefined,true);expect(download.headers.get('Content-Disposition')).toContain(name);expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
      await req(`/api/admin/submissions/${s.id}/delete`,'POST',{},undefined,true);
    }
    const mismatch=await create(zip(),{archive_name:'wrong.rar'});await req(`/api/submissions/${mismatch.id}/parts/1`,'PUT',zip(),mismatch.token);
    expect((await (await req(`/api/submissions/${mismatch.id}/complete`,'POST',{},mismatch.token)).json() as any).status).toBe('REJECTED');await req(`/api/submissions/${mismatch.id}`,'DELETE',undefined,mismatch.token);
  });
  it('accepts animated GIF images and rejects truncated or oversized GIF frames',async()=>{
    const gif=Buffer.from('R0lGODlhCAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBFAABACwAAAAACAAIAIEAAP8AAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7','base64');
    const s=await create(zip(),{image_count:1});
    expect((await req(`/api/submissions/${s.id}/images/1`,'PUT',gif.subarray(0,-1),s.token)).status).toBe(400);
    const huge=Buffer.from(gif);huge.writeUInt16LE(8192,6);huge.writeUInt16LE(8192,8);
    expect((await req(`/api/submissions/${s.id}/images/1`,'PUT',huge,s.token)).status).toBe(400);
    const start=gif.indexOf(0x2c),next=gif.indexOf(Buffer.from([0x21,0xf9]),start),frame=gif.subarray(start,next);
    const excessive=Buffer.concat([gif.subarray(0,start),...Array(121).fill(frame),Buffer.from([0x3b])]);
    expect((await req(`/api/submissions/${s.id}/images/1`,'PUT',excessive,s.token)).status).toBe(400);
    expect((await req(`/api/submissions/${s.id}/images/1`,'PUT',gif,s.token)).status).toBe(200);
    const row=await env.DB.prepare('SELECT content_type FROM submission_images WHERE submission_id=?').bind(s.id).first();expect(row.content_type).toBe('image/gif');
    const image=await req(`/api/admin/submissions/${s.id}/images/1`,'GET',undefined,undefined,true);expect(image.headers.get('Content-Type')).toBe('image/gif');expect(image.headers.get('Content-Disposition')).toContain('.gif');expect(Buffer.from(await image.arrayBuffer())).toEqual(gif);
    await req(`/api/admin/submissions/${s.id}/delete`,'POST',{},undefined,true);
  });
  it('keeps a real ZIP model quarantined and requires capability and admin Bearer',async()=>{
    const bytes=zip(),s=await create(bytes);
    expect((await req(`/api/submissions/${s.id}/parts/1`,'PUT',bytes,'wrong')).status).toBe(401);
    expect((await req(`/api/submissions/${s.id}/parts/1`,'PUT',bytes,s.token)).status).toBe(200);
    const ready=await req(`/api/submissions/${s.id}/complete`,'POST',{},s.token);expect(ready.status,await ready.clone().text()).toBe(200);expect((await ready.json() as any).status).toBe('READY');
    expect((await req('/api/admin/submissions')).status).toBe(401);
    const list=await req('/api/admin/submissions','GET',undefined,undefined,true);expect((await list.json() as any).items.some((x:any)=>x.id===s.id)).toBe(true);
    expect((await req(`/api/submissions/${s.id}/archive`)).status).toBe(404);
    const download=await req(`/api/admin/submissions/${s.id}/archive`,'GET',undefined,undefined,true);expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    expect((await req(`/api/admin/submissions/${s.id}/delete`,'POST',{},undefined,true)).status).toBe(200);
    expect((await env.PREVIEWS.list({prefix:`submissions/${s.id}/`})).objects).toHaveLength(0);
  });
  it('detects signatures in deflated entries and rejects fake model extensions',async()=>{
    for(const [bytes,valid] of [[zip('model.blend',Buffer.from('BLENDER-v400\0model'),true),true],[zip('fake.blend',Buffer.from('this is not a blend file')),false]] as const){
      const key=crypto.randomUUID();await env.PREVIEWS.put(key,bytes);const report=await validateSubmissionZip(env.PREVIEWS,key,bytes.length);expect(report.valid).toBe(valid);await env.PREVIEWS.delete(key);
    }
  });
  it('rejects malformed, traversal, encrypted, oversized and bomb ZIP metadata',async()=>{
    const encrypted=zip();encrypted.writeUInt16LE(1,6);encrypted.writeUInt16LE(1,encrypted.length-22-('model.blend'.length+46)+8);
    const bomb=zip();bomb.writeUInt32LE(0x7fffffff,bomb.length-22-('model.blend'.length+46)+24);
    for(const bytes of [Buffer.from('not a ZIP'),zip('../model.blend'),encrypted,bomb]){const key=crypto.randomUUID();await env.PREVIEWS.put(key,bytes);expect((await validateSubmissionZip(env.PREVIEWS,key,bytes.length)).valid).toBe(false);await env.PREVIEWS.delete(key);}
  });
  it('cleans expired multipart sessions and images without exposing tokens',async()=>{
    const s=await create();await env.PREVIEWS.put(`submissions/${s.id}/images/1`,Buffer.from('x'));await env.DB.prepare('UPDATE submissions SET expires_at=0 WHERE id=?').bind(s.id).run();
    await cleanupSubmissions(env);expect((await env.PREVIEWS.list({prefix:`submissions/${s.id}/`})).objects).toHaveLength(0);expect((await req(`/api/submissions/${s.id}/complete`,'POST',{},s.token)).status).toBe(404);
  });
  it('rejects unsupported archives and bounds sessions per IP',async()=>{
    ip++;const body={source:'s',artist:'a',media_title:'m',character_name:'c',archive_name:'x.tar',archive_size:100};expect((await req('/api/submissions','POST',body)).status).toBe(400);
    body.archive_name='x.zip';for(let n=0;n<3;n++)expect((await req('/api/submissions','POST',body)).status).toBe(201);expect((await req('/api/submissions','POST',body)).status).toBe(429);
  });
  it('validates ZIP64 end records and dynamic DEFLATE without expanding whole files',async()=>{
    const ordinary=zip(),end=ordinary.subarray(ordinary.length-22),offset=end.readUInt32LE(16),directorySize=end.readUInt32LE(12),z64=Buffer.alloc(56),locator=Buffer.alloc(20),e=Buffer.from(end);
    z64.writeUInt32LE(0x06064b50);z64.writeBigUInt64LE(44n,4);z64.writeBigUInt64LE(1n,24);z64.writeBigUInt64LE(1n,32);z64.writeBigUInt64LE(BigInt(directorySize),40);z64.writeBigUInt64LE(BigInt(offset),48);
    locator.writeUInt32LE(0x07064b50);locator.writeBigUInt64LE(BigInt(ordinary.length-22),8);locator.writeUInt32LE(1,16);e.writeUInt16LE(65535,8);e.writeUInt16LE(65535,10);e.writeUInt32LE(0xffffffff,12);e.writeUInt32LE(0xffffffff,16);
    const data=Buffer.concat([Buffer.from('BLENDER-v400'),Buffer.from(crypto.getRandomValues(new Uint8Array(20000))).map((b:number)=>b%32+32)]);
    for(const bytes of [Buffer.concat([ordinary.subarray(0,-22),z64,locator,e]),zip('dynamic.blend',data,true)]){const k=crypto.randomUUID();await env.PREVIEWS.put(k,bytes);const report=await validateSubmissionZip(env.PREVIEWS,k,bytes.length);expect(report.valid,JSON.stringify(report)).toBe(true);await env.PREVIEWS.delete(k)}
  });
  it('checks image signatures/count and keeps cancellation capability private',async()=>{
    const s=await create(zip(),{image_count:1});expect((await req(`/api/submissions/${s.id}/images/1`,'PUT',Buffer.from('fake'),s.token)).status).toBe(400);
    expect((await req(`/api/submissions/${s.id}/images/2`,'PUT',Buffer.from('fake'),s.token)).status).toBe(400);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII=','base64');expect((await req(`/api/submissions/${s.id}/images/1`,'PUT',png,s.token)).status).toBe(200);
    expect((await req(`/api/submissions/${s.id}`,'DELETE',undefined,'wrong')).status).toBe(401);expect((await req(`/api/submissions/${s.id}`,'DELETE',undefined,s.token)).status).toBe(200);
    expect((await env.PREVIEWS.list({prefix:`submissions/${s.id}/`})).objects).toHaveLength(0);
  });
  it('requires Bearer admin auth and bounds explicit private download ranges',async()=>{
    const s=await create(),bytes=zip();await req(`/api/submissions/${s.id}/parts/1`,'PUT',bytes,s.token);await req(`/api/submissions/${s.id}/complete`,'POST',{},s.token);
    const base=`https://api.test/api/admin/submissions/${s.id}/archive`;
    const basic=await handleSubmissions(new Request(base,{headers:{Authorization:'Basic '+Buffer.from('admin:'+admin).toString('base64')}}),env);expect(basic!.status).toBe(401);
    for(const [r,status] of [['bytes=0-9',206],['bytes=0-999999999',416],['bytes=1-3,8-9',416]]){const res=await handleSubmissions(new Request(base,{headers:{Authorization:'Bearer '+admin,Range:r as string}}),env);expect(res!.status).toBe(status);if(status===206)expect(Buffer.from(await res!.arrayBuffer())).toEqual(bytes.subarray(0,10))}
    await req(`/api/admin/submissions/${s.id}/delete`,'POST',{},undefined,true);
  });
  it('releases cancelled reservations, retains attempt history and rejects exhausted storage budget',async()=>{
    const s=await create();await req(`/api/submissions/${s.id}`,'DELETE',undefined,s.token);expect((await env.DB.prepare('SELECT reserved_bytes FROM submission_usage WHERE id=?').bind(s.id).first() as any).reserved_bytes).toBe(0);
    const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO submission_usage VALUES(?,?,?,?)').bind(id,'budget-test',20*1024**3,Math.floor(Date.now()/1000)).run();ip++;
    const res=await req('/api/submissions','POST',{source:'s',artist:'a',media_title:'m',character_name:'c',archive_name:'x.zip',archive_size:100});expect(res.status).toBe(429);await env.DB.prepare('DELETE FROM submission_usage WHERE id=?').bind(id).run();
  });
  it('validates sparse 5 GiB ZIP64 offsets with bounded reads and identifies the largest file',async()=>{
    const size=5*1024**3,name=Buffer.from('model.blend'),extra=Buffer.alloc(20),local=Buffer.alloc(30),central=Buffer.alloc(46),z=Buffer.alloc(56),locator=Buffer.alloc(20),end=Buffer.alloc(22);
    const localSize=30+name.length+extra.length,directorySize=46+name.length+extra.length,expanded=size-localSize-directorySize-98,directoryOffset=localSize+expanded;
    extra.writeUInt16LE(1);extra.writeUInt16LE(16,2);extra.writeBigUInt64LE(BigInt(expanded),4);extra.writeBigUInt64LE(BigInt(expanded),12);
    local.writeUInt32LE(0x04034b50);local.writeUInt32LE(0xffffffff,18);local.writeUInt32LE(0xffffffff,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(extra.length,28);
    central.writeUInt32LE(0x02014b50);central.writeUInt32LE(0xffffffff,20);central.writeUInt32LE(0xffffffff,24);central.writeUInt16LE(name.length,28);central.writeUInt16LE(extra.length,30);
    z.writeUInt32LE(0x06064b50);z.writeBigUInt64LE(44n,4);z.writeBigUInt64LE(1n,24);z.writeBigUInt64LE(1n,32);z.writeBigUInt64LE(BigInt(directorySize),40);z.writeBigUInt64LE(BigInt(directoryOffset),48);
    locator.writeUInt32LE(0x07064b50);locator.writeBigUInt64LE(BigInt(directoryOffset+directorySize),8);locator.writeUInt32LE(1,16);
    end.writeUInt32LE(0x06054b50);end.writeUInt16LE(65535,8);end.writeUInt16LE(65535,10);end.writeUInt32LE(0xffffffff,12);end.writeUInt32LE(0xffffffff,16);
    const segments=[{at:0,data:Buffer.concat([local,name,extra,Buffer.from('BLENDER-v400')])},{at:directoryOffset,data:Buffer.concat([central,name,extra,z,locator,end])}],reads:number[]=[];
    const bucket={get:async(_key:string,{range}:{range:{offset:number;length:number}})=>{reads.push(range.length);const bytes=Buffer.alloc(range.length);for(const s of segments){const start=Math.max(range.offset,s.at),stop=Math.min(range.offset+range.length,s.at+s.data.length);if(stop>start)s.data.copy(bytes,start-range.offset,start-s.at,stop-s.at)}return {arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)}}} as unknown as R2Bucket;
    const report=await validateSubmissionZip(bucket,'sparse',size);expect(report.valid,JSON.stringify(report)).toBe(true);expect(report.largest_files?.[0].expanded_bytes).toBe(expanded);expect(report.expanded_bytes).toBeGreaterThan(4*1024**3);expect(Math.max(...reads)).toBeLessThanOrEqual(65557);expect(reads.length).toBeLessThan(10);
  });
  it('accepts real OBJ with thousands of vertices before the first face',async()=>{
    const bytes=zip('large.obj',Buffer.from(Array.from({length:2000},(_,i)=>`v ${i} ${i+1} ${i+2}\n`).join('')+'f 1 2 3\n')),k=crypto.randomUUID();await env.PREVIEWS.put(k,bytes);const report=await validateSubmissionZip(env.PREVIEWS,k,bytes.length);expect(report.valid,JSON.stringify(report)).toBe(true);await env.PREVIEWS.delete(k);
  });
  it('accepts forced local ZIP64 for small files and bounds the final part above 4 GiB',async()=>{
    const ordinary=zip(),nameLength=ordinary.readUInt16LE(26),head=Buffer.from(ordinary.subarray(0,30)),extra=Buffer.alloc(20),dataLength=ordinary.readUInt32LE(18),centralOffset=ordinary.length-22-46-nameLength;
    extra.writeUInt16LE(1);extra.writeUInt16LE(16,2);extra.writeBigUInt64LE(BigInt(dataLength),4);extra.writeBigUInt64LE(BigInt(dataLength),12);head.writeUInt32LE(0xffffffff,18);head.writeUInt32LE(0xffffffff,22);head.writeUInt16LE(20,28);
    const end=Buffer.from(ordinary.subarray(-22));end.writeUInt32LE(centralOffset+20,16);const bytes=Buffer.concat([head,ordinary.subarray(30,30+nameLength),extra,ordinary.subarray(30+nameLength,-22),end]);
    const k=crypto.randomUUID();await env.PREVIEWS.put(k,bytes);const report=await validateSubmissionZip(env.PREVIEWS,k,bytes.length);expect(report.valid,JSON.stringify(report)).toBe(true);await env.PREVIEWS.delete(k);
    const size=5*1024**3-32*1024**2+123,s=await create(zip(),{archive_size:size});expect(s.part_size).toBe(32*1024**2);
    expect((await req(`/api/submissions/${s.id}/parts/160`,'PUT',Buffer.alloc(122),s.token)).status).toBe(400);expect((await req(`/api/submissions/${s.id}/parts/160`,'PUT',Buffer.alloc(123),s.token)).status).toBe(200);
    expect((await req(`/api/submissions/${s.id}/complete`,'POST',{},s.token)).status).toBe(409);await req(`/api/submissions/${s.id}`,'DELETE',undefined,s.token);
  });
});




