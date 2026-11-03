import {type Env,type Model,type ModelFile,type Manifest,validateModel,formatArtistName,safePath,canonical,sha256} from './contracts';
import {control,guarded,baseline} from './database';
import {dashboard} from './admin';
import {publicationRoute,publicPublicationPredicate} from './publication';
import {handleSubmissions,cleanupSubmissions} from './submissions';

const robots='noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai';
const robotsTxt='User-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: ChatGPT-User\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: Claude-Web\nDisallow: /\n\nUser-agent: Claude-SearchBot\nDisallow: /\n\nUser-agent: anthropic-ai\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: Perplexity-User\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n\nUser-agent: GoogleOther\nDisallow: /\n\nUser-agent: Applebot-Extended\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: Bytespider\nDisallow: /\n\nUser-agent: Amazonbot\nDisallow: /\n\nUser-agent: FacebookBot\nDisallow: /\n\nUser-agent: Meta-ExternalAgent\nDisallow: /\n\nUser-agent: Meta-ExternalFetcher\nDisallow: /\n\nUser-agent: cohere-ai\nDisallow: /\n\nUser-agent: Diffbot\nDisallow: /\n\nUser-agent: *\nDisallow: /api/\nDisallow: /admin\nAllow: /\n';
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8'}})}
const FORMAT_LABELS:Record<string,string>={blend:'BLEND',blen:'BLEND',fbx:'FBX',ma:'MAYA',mb:'MAYA',maya:'MAYA',max:'MAX',c4d:'C4D',obj:'OBJ',glb:'GLB',gltf:'GLTF',dae:'DAE','3ds':'3DS',abc:'ABC',usd:'USD',usda:'USD',usdc:'USD',usdz:'USDZ',stl:'STL',ply:'PLY',ztl:'ZBRUSH',zpr:'ZBRUSH',vrm:'VRM',pmx:'MMD',pmd:'MMD',mmd:'MMD',vmd:'MMD',vpd:'MMD',pmm:'MMD',x:'MMD',unitypackage:'UNITY',uasset:'UNREAL',skp:'SKP',hip:'HOUDINI',spp:'PAINTER'};
function fileFormats(f:ModelFile):string[]{
  if(Array.isArray(f.formats)&&f.formats.length) return f.formats.filter(v=>typeof v==='string').slice(0,20);
  const ext=(f.path.split('.').at(-1)||'').toLowerCase();return [FORMAT_LABELS[ext]||ext.toUpperCase()||'3D'];
}
function publicModel(m:Model,created_at?:number,details:Record<string,unknown>={}){
  const files=m.files.filter(f=>f.kind==='model').map(f=>({filename:f.path.slice(5),size:f.size,sha256:f.sha256,formats:fileFormats(f),contents:Array.isArray(f.contents)?f.contents.filter(v=>typeof v==='string').slice(0,200):[],url:`https://drive.google.com/file/d/${encodeURIComponent(f.remote_id)}/view`}));
  return {...details,id:m.id,slug:m.id,title:m.character_name+(m.version?' / '+m.version:''),asset_category:m.asset_category||'Characters',style:m.style,artist_category:m.artist_category,artist_name:formatArtistName(m.artist_name),media_title:m.media_title,character_name:m.character_name,version:m.version,created_at:created_at??null,
    formats:[...new Set(files.flatMap(f=>f.formats))].sort(),files,
    images:m.files.filter(f=>f.kind==='image'&&f.role!=='ignore').sort((a,b)=>(a.role==='main'?-1:b.role==='main'?1:(a.sort_order||0)-(b.sort_order||0))).map(f=>({key:f.preview_r2_key,sha256:f.preview_sha256,role:f.role,width:f.width,height:f.height}))};
}
async function authenticated(request:Request,env:Env,allowBasic=false){
  if(!env.ADMIN_TOKEN||env.ADMIN_TOKEN.length<24) return false;
  const provided=request.headers.get('Authorization')||'';
  if(allowBasic&&provided.startsWith('Basic ')){
    try{return await sha256(atob(provided.slice(6)))===await sha256('admin:'+env.ADMIN_TOKEN)}catch{return false}
  }
  return await sha256(provided)===await sha256('Bearer '+env.ADMIN_TOKEN);
}
async function route(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url),path=url.pathname;
  if(request.method==='OPTIONS') return new Response(null,{status:204});
  const submissionResponse=await handleSubmissions(request,env);if(submissionResponse)return submissionResponse;
  const publicationResponse=await publicationRoute(request,env);if(publicationResponse)return publicationResponse;
  if(path==='/admin'){
    if(request.method!=='GET'&&request.method!=='HEAD')return json({error:'Method not allowed'},405);
    if(!await authenticated(request,env,true))return new Response('Admin authentication required',{status:401,headers:{'WWW-Authenticate':'Basic realm="My5TB Admin", charset="UTF-8"'}});
    return dashboard(env);
  }
  if(path==='/robots.txt') return new Response(robotsTxt,{headers:{'Content-Type':'text/plain; charset=utf-8'}});
  if(path==='/api/sections'&&request.method==='GET') return json((await env.DB.prepare('SELECT * FROM site_sections WHERE enabled=1 ORDER BY sort_order').all()).results);
  if(path==='/api/models'&&request.method==='GET'){
    const conditions=["c.status='ACTIVE'","c.visibility='PUBLIC'","s.enabled=1","NOT EXISTS (SELECT 1 FROM publication_overrides po WHERE po.content_id=c.id AND po.published=0)"],values:unknown[]=[];
    const q=(url.searchParams.get('q')||'').slice(0,200);
    if(q){conditions.push('(m.character_name LIKE ? ESCAPE \'!\' OR m.artist_name LIKE ? ESCAPE \'!\' OR m.media_title LIKE ? ESCAPE \'!\' OR m.local_relative_path LIKE ? ESCAPE \'!\')');const like='%'+q.replace(/[!%_]/g,'!$&')+'%';values.push(like,like,like,like)}
    for(const key of ['asset_category','style','artist_category','artist_name','media_title']) if(url.searchParams.get(key)){
      if(key==='artist_name'){
        const val=formatArtistName(url.searchParams.get(key)!),alt=val.replace(/^(.+?)\s*\|\s*(.+)$/,'$1 ($2)');
        conditions.push('(m.artist_name=? OR m.artist_name=? OR m.artist_name=?)');values.push(val,url.searchParams.get(key),alt);
      }else{
        const field=key==='asset_category'?"COALESCE(json_extract(m.payload,'$.asset_category'),'Characters')":`m.${key}`;conditions.push(`${field}=?`);values.push(url.searchParams.get(key));
      }
    }
    const format=(url.searchParams.get('format')||'').trim().toUpperCase().slice(0,40);
    if(format){
      const exts=[format,...Object.entries(FORMAT_LABELS).filter(([,label])=>label===format).map(([ext])=>ext.toUpperCase())];
      const extChecks=exts.map(()=>"upper(json_extract(f.value,'$.path')) LIKE ? ESCAPE '!'").join(' OR ');
      conditions.push(`(EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(m.payload,'$.formats')='array' THEN json_extract(m.payload,'$.formats') ELSE '[]' END) x WHERE upper(x.value)=?) OR (json_type(m.payload,'$.formats') IS NULL AND EXISTS (SELECT 1 FROM json_each(m.payload,'$.files') f WHERE json_extract(f.value,'$.kind')='model' AND (EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(f.value,'$.formats')='array' THEN json_extract(f.value,'$.formats') ELSE '[]' END) y WHERE upper(y.value)=?) OR ${extChecks}))))`);
      values.push(format,format,...exts.map(e=>'%.'+e.replace(/[!%_]/g,'!$&')));
    }
    // Bind each bounded exclusion set as JSON: user text never becomes SQL,
    // and five full sets stay comfortably below D1's bound-parameter limit.
    for(const [parameter,field] of [['exclude_source','artist_category'],['exclude_artist','artist_name'],['exclude_world','media_title'],['exclude_character','character_name'],['exclude_filename','filename']] as const){
      const raw=url.searchParams.getAll(parameter);
      if(raw.length>20||raw.some(value=>value.length>200))return json({error:'Exclusions allow at most 20 values per field and 200 characters per value.'},400);
      let excluded=[...new Set(raw.map(value=>value.trim()).filter(Boolean))];
      if(!excluded.length)continue;
      if(field==='artist_name')excluded=[...new Set(excluded.flatMap(value=>{
        const normalized=formatArtistName(value);
        return [value,normalized,normalized.replace(/^(.+?)\s*\|\s*(.+)$/,'$1 ($2)'),normalized.replace(/^(.+?)\s*\|\s*(.+)$/,'$1（$2）')];
      }))];
      if(field==='filename'){
        conditions.push(`NOT EXISTS (SELECT 1 FROM json_each(?) e,json_each(m.payload,'$.files') f WHERE json_extract(f.value,'$.kind')='model' AND (instr(lower(substr(json_extract(f.value,'$.path'),6)),lower(e.value))>0 OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(f.value,'$.contents')='array' THEN json_extract(f.value,'$.contents') ELSE '[]' END) inner_file WHERE instr(lower(inner_file.value),lower(e.value))>0)))`);
      }else conditions.push(`NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE lower(trim(COALESCE(m.${field},'')))=lower(e.value))`);
      values.push(JSON.stringify(excluded));
    }
    const page=Math.max(1,Math.min(100000,Number(url.searchParams.get('page'))||1)),limit=15;
    const from=' FROM models m JOIN content_items c ON c.id=m.content_id JOIN site_sections s ON s.id=c.section_id WHERE '+conditions.join(' AND ');
    const total=await env.DB.prepare('SELECT COUNT(*) n'+from).bind(...values).first<{n:number}>();
    const maxPage=Math.max(1,Math.ceil((total?.n||0)/limit)),safePage=Math.min(page,maxPage);
    const rows=await env.DB.prepare('SELECT m.payload,c.created_at'+from+' ORDER BY c.updated_at DESC,c.id LIMIT ? OFFSET ?').bind(...values,limit,(safePage-1)*limit).all<{payload:string;created_at:number}>();
    const details=await env.DB.prepare("SELECT * FROM model_details WHERE content_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))").bind(JSON.stringify(rows.results.map(r=>JSON.parse(r.payload)))).all<Record<string,unknown>>();
    return json({items:rows.results.map(r=>{const m=JSON.parse(r.payload);return publicModel(m,r.created_at,details.results.find(d=>d.content_id===m.id))}),total:total?.n||0,page:safePage,limit});
  }
  if(path==='/api/facets'&&request.method==='GET'){
    const result:Record<string,string[]>={};
    for(const field of ['asset_category','style','artist_category','artist_name','media_title','character_name']){
      const expression=field==='asset_category'?"COALESCE(json_extract(m.payload,'$.asset_category'),'Characters')":`m.${field}`;
      const rows=await env.DB.prepare(`SELECT DISTINCT ${expression} v FROM models m JOIN content_items c ON c.id=m.content_id JOIN site_sections s ON s.id=c.section_id WHERE c.status='ACTIVE' AND c.visibility='PUBLIC' AND s.enabled=1 AND NOT EXISTS (SELECT 1 FROM publication_overrides po WHERE po.content_id=c.id AND po.published=0) ORDER BY v LIMIT 500`).all<{v:string}>();
      result[field]=field==='artist_name'?[...new Set(rows.results.map(r=>formatArtistName(r.v)))].sort():rows.results.map(r=>r.v);
    }
    const formatRows=await env.DB.prepare("SELECT m.payload FROM models m JOIN content_items c ON c.id=m.content_id JOIN site_sections s ON s.id=c.section_id WHERE c.status='ACTIVE' AND c.visibility='PUBLIC' AND s.enabled=1 AND NOT EXISTS (SELECT 1 FROM publication_overrides po WHERE po.content_id=c.id AND po.published=0) LIMIT 500").all<{payload:string}>();
    result.format=[...new Set(formatRows.results.flatMap(r=>publicModel(JSON.parse(r.payload)).formats))].sort();
    const filenameRows=await env.DB.prepare(`WITH public_files AS (SELECT f.value file FROM models m JOIN content_items c ON c.id=m.content_id JOIN site_sections s ON s.id=c.section_id,json_each(m.payload,'$.files') f WHERE c.status='ACTIVE' AND c.visibility='PUBLIC' AND s.enabled=1 AND NOT EXISTS (SELECT 1 FROM publication_overrides po WHERE po.content_id=c.id AND po.published=0) AND json_extract(f.value,'$.kind')='model') SELECT substr(json_extract(file,'$.path'),6) v FROM public_files UNION SELECT inner_file.value v FROM public_files,json_each(CASE WHEN json_type(file,'$.contents')='array' THEN json_extract(file,'$.contents') ELSE '[]' END) inner_file WHERE inner_file.type='text' ORDER BY v LIMIT 500`).all<{v:string}>();
    result.filename=filenameRows.results.map(row=>row.v).filter(Boolean);
    return json(result);
  }
  if(path.startsWith('/api/models/')&&request.method==='GET'){
    const row=await env.DB.prepare("SELECT m.payload,c.created_at FROM models m JOIN content_items c ON c.id=m.content_id JOIN site_sections s ON s.id=c.section_id WHERE c.slug=? AND c.status='ACTIVE' AND c.visibility='PUBLIC' AND s.enabled=1 AND "+publicPublicationPredicate).bind(path.slice('/api/models/'.length)).first<{payload:string;created_at:number}>();
    return row?json(publicModel(JSON.parse(row.payload),row.created_at,(await env.DB.prepare('SELECT upload_by,link,description FROM model_details WHERE content_id=?').bind(JSON.parse(row.payload).id).first<Record<string,unknown>>())||{})):json({error:'Model not found'},404);
  }
  if(path==='/api/preview-key'&&request.method==='GET'){
    if(!env.PREVIEW_KEY_B64) return json({error:'Preview key is not configured'},503);
    return json({key:env.PREVIEW_KEY_B64}); // Public display obfuscation; NEVER an authorization boundary.
  }
  if(path.startsWith('/api/assets/')&&request.method==='GET'){
    const key=decodeURIComponent(path.slice('/api/assets/'.length));safePath(key);
    const row=await env.DB.prepare("SELECT i.id FROM model_images i JOIN content_items c ON c.id=i.content_id JOIN site_sections s ON s.id=c.section_id WHERE s.enabled=1 AND i.preview_r2_key=? AND i.role!='ignore' AND c.status='ACTIVE' AND c.visibility='PUBLIC' AND "+publicPublicationPredicate+" LIMIT 1").bind(key).first();
    if(!row) return json({error:'Asset not found'},404);
    const object=await env.PREVIEWS.get(key);
    return object?new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'private, max-age=300'}}):json({error:'Asset not found'},404);
  }
  if(!path.startsWith('/api/admin/')) return json({error:'Not found'},404);
  if(!await authenticated(request,env)) return json({error:'Admin authentication required'},401);
  if(request.method==='GET'){
    if(path==='/api/admin/blobs'){
      const key=safePath(url.searchParams.get('key'));
      if(!/^(previews|originals|manifests|references)\//.test(key))return json({error:'Invalid object namespace'},400);
      const object=await env.PREVIEWS.get(key);
      return object?new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(object.size)}}):json({error:'Object not found'},404);
    }
    if(path==='/api/admin/control') return json(await control(env));
    if(path==='/api/admin/baseline') return json(await baseline(env));
    if(path==='/api/admin/completed'){
      const row=await env.DB.prepare("SELECT base_generation+1 generation FROM sync_runs WHERE id=? AND status='COMPLETED'").bind(url.searchParams.get('run_id')).first();
      return json(row||{generation:null});
    }
    if(path==='/api/admin/snapshots') return json((await env.DB.prepare('SELECT * FROM recovery_snapshots WHERE dataset_id=? AND completed=1 ORDER BY generation DESC').bind(env.DATASET_ID||'models').all()).results);
    if(path==='/api/admin/usage'){
      const data=await env.DB.prepare('SELECT (SELECT COUNT(*) FROM models) models,(SELECT COALESCE(SUM(size_bytes),0) FROM model_files) model_bytes,(SELECT COALESCE(SUM(original_size_bytes),0) FROM model_images) image_bytes,(SELECT COUNT(*) FROM recovery_snapshots) snapshots').first();
      return json({inventory:data,quotas:'Provider usage quotas require the Cloudflare and Google consoles; these figures are catalog totals.'});
    }
  }
  if(path==='/api/admin/blobs'&&request.method==='PUT'){
    const key=safePath(url.searchParams.get('key'));
    if(!/^(previews|originals|manifests|references)\//.test(key)) return json({error:'Invalid object namespace'},400);
    const generation=Number(request.headers.get('X-Generation')),epoch=Number(request.headers.get('X-Lock-Epoch'));
    const c=await control(env);
    if(c.mode!=='NORMAL'||c.generation!==generation||c.lock_epoch!==epoch) return json({error:'Cloud locked or fenced'},409);
    if(Number(request.headers.get('Content-Length'))>25*1024*1024) return json({error:'Object too large'},413);
    const data=await request.arrayBuffer();
    if(data.byteLength>25*1024*1024) return json({error:'Object too large'},413);
    const checksum=await sha256(data),existing=await env.PREVIEWS.head(key);
    if(existing&&existing.customMetadata?.sha256!==checksum)return json({error:'Immutable object checksum mismatch'},409);
    if(!existing) await env.PREVIEWS.put(key,data,{customMetadata:{sha256:checksum}});
    return json({key}); // A lock racing this upload can leave a private orphan; publication remains atomically fenced.
  }
  if(request.method!=='POST') return json({error:'Method not allowed'},405);
  if(Number(request.headers.get('Content-Length'))>8*1024*1024) return json({error:'Request too large'},413);
  if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'JSON content type required'},415);
  const b=await request.json() as any;
  const dataset=env.DATASET_ID||'models';
  if(path==='/api/admin/test-reset/start'){
    if(typeof b.owner!=='string'||!b.owner.startsWith('test-reset:'))throw new Error('Invalid reset owner');
    const c=await control(env);
    if(c.mode==='MAINTENANCE'&&c.lock_owner===b.owner)return json(c);
    await guarded(env,b.generation,b.epoch,null,[
      env.DB.prepare("INSERT INTO write_guards SELECT 2,0 WHERE EXISTS(SELECT 1 FROM sync_control WHERE active_run IS NOT NULL)"),
      env.DB.prepare("UPDATE sync_control SET mode='MAINTENANCE',lock_owner=?,lock_epoch=lock_epoch+1 WHERE dataset_id=?").bind(b.owner,dataset)]);
    return json(await control(env));
  }
  if(path==='/api/admin/test-reset/step'){
    const c=await control(env);
    if(c.mode!=='MAINTENANCE'||c.lock_owner!==b.owner||c.lock_epoch!==b.epoch)return json({error:'Reset fenced'},409);
    // Delete a bounded page per request; repeat safely after response loss.
    for(const prefix of ['previews/','originals/','manifests/','references/']){
      const objects=await env.PREVIEWS.list({prefix,limit:100});
      if(objects.objects.length){await env.PREVIEWS.delete(objects.objects.map(o=>o.key));return json({done:false});}
    }
    const guard=env.DB.prepare("INSERT INTO write_guards VALUES(1,CASE WHEN EXISTS(SELECT 1 FROM sync_control WHERE dataset_id=? AND mode='MAINTENANCE' AND lock_owner=? AND lock_epoch=?) THEN 1 ELSE 0 END)").bind(dataset,b.owner,b.epoch);
    const tables=['model_details','publication_overrides','model_images','model_files','models','staged_models','staged_deletes','sync_operations','recovery_snapshots','sync_runs'];
    await env.DB.batch([guard,...tables.map(t=>env.DB.prepare('DELETE FROM '+t)),env.DB.prepare("DELETE FROM content_items WHERE section_id='models'"),env.DB.prepare("UPDATE sync_control SET generation=0,mode='NORMAL',lock_owner=NULL,active_run=NULL,lock_epoch=lock_epoch+1,updated_at=unixepoch() WHERE dataset_id=?").bind(dataset),env.DB.prepare('DELETE FROM write_guards')]);
    return json({done:true});
  }
  if(path==='/api/admin/recovery/lock'){
    if(typeof b.owner!=='string'||!b.owner) throw new Error('Invalid recovery owner');
    const c=await control(env);
    if(c.mode==='RECOVERY_LOCKED'&&c.lock_owner===b.owner) return json(c);
    await guarded(env,c.generation,c.lock_epoch,null,[env.DB.prepare("UPDATE sync_control SET mode='RECOVERY_LOCKED',lock_owner=?,lock_epoch=lock_epoch+1,active_run=NULL,updated_at=unixepoch() WHERE dataset_id=?").bind(b.owner,dataset)]);
    return json(await control(env));
  }
  if(path==='/api/admin/recovery/unlock'){
    if(b.verified!==true) throw new Error('Verified zero-diff baseline required');
    // Restore metadata from the latest completed generation, undoing interrupted tombstones.
    const guard=env.DB.prepare("INSERT INTO write_guards VALUES(1,CASE WHEN EXISTS(SELECT 1 FROM sync_control WHERE dataset_id=? AND mode='RECOVERY_LOCKED' AND lock_owner=? AND lock_epoch=? AND generation=?) THEN 1 ELSE 0 END)").bind(dataset,b.owner,b.epoch,b.generation);
    try{await env.DB.batch([guard,env.DB.prepare("UPDATE content_items SET status=json_extract((SELECT payload FROM models WHERE content_id=content_items.id),'$.status') WHERE section_id='models' AND id IN (SELECT content_id FROM models)"),env.DB.prepare("UPDATE sync_control SET mode='NORMAL',lock_owner=NULL,lock_epoch=lock_epoch+1,updated_at=unixepoch() WHERE dataset_id=?").bind(dataset),env.DB.prepare('DELETE FROM write_guards')]);}
    catch{throw new Error('CONFLICT: Recovery lock mismatch')}
    return json(await control(env));
  }
  if(path==='/api/admin/normalize-artists'){
    const rows=await env.DB.prepare('SELECT content_id,artist_name,payload FROM models').all<{content_id:string;artist_name:string;payload:string}>();
    const updates:D1PreparedStatement[]=[];
    for(const r of rows.results){
      const parsed=JSON.parse(r.payload) as Model;
      const next=formatArtistName(parsed.artist_name||r.artist_name);
      if(next!==r.artist_name||next!==parsed.artist_name){
        parsed.artist_name=next;
        updates.push(env.DB.prepare('UPDATE models SET artist_name=?,payload=? WHERE content_id=?').bind(next,JSON.stringify(parsed),r.content_id));
      }
    }
    if(updates.length) await env.DB.batch(updates);
    return json({updated:updates.length,total:rows.results.length});
  }
  if(typeof b.run_id!=='string'||!b.run_id||!Number.isSafeInteger(b.generation)||!Number.isSafeInteger(b.epoch)) throw new Error('Invalid write fence');
  if(path==='/api/admin/begin'){
    await guarded(env,b.generation,b.epoch,null,[
      env.DB.prepare('INSERT INTO write_guards SELECT 2,0 WHERE EXISTS(SELECT 1 FROM sync_control WHERE dataset_id=? AND active_run IS NOT NULL AND active_run!=?)').bind(dataset,b.run_id),
      env.DB.prepare("INSERT INTO write_guards SELECT 2,0 WHERE EXISTS(SELECT 1 FROM sync_runs WHERE id=? AND status='ABANDONED')").bind(b.run_id),
      env.DB.prepare("INSERT OR IGNORE INTO sync_runs(id,dataset_id,base_generation,status,created_at) VALUES(?,?,?,'RUNNING',unixepoch())").bind(b.run_id,dataset,b.generation),
      env.DB.prepare('UPDATE sync_control SET active_run=? WHERE dataset_id=?').bind(b.run_id,dataset)]);
    return json({ok:true});
  }
  if(path==='/api/admin/stage'){
    const m=validateModel(b.model);
    for(const f of m.files.filter(f=>f.kind==='image'&&f.role!=='ignore')){
      const head=await env.PREVIEWS.head(f.preview_r2_key!);
      if(!head||head.customMetadata?.sha256!==f.preview_sha256) throw new Error('Preview upload is not verified');
    }
    await guarded(env,b.generation,b.epoch,b.run_id,[env.DB.prepare('INSERT OR REPLACE INTO staged_models VALUES(?,?,?)').bind(b.run_id,m.local_relative_path,JSON.stringify(m)),env.DB.prepare("INSERT OR REPLACE INTO sync_operations(id,run_id,op_kind,item_id,relative_path,status) VALUES(?,?,'UPSERT',?,?,'STAGED')").bind(b.run_id+':'+m.id,b.run_id,m.id,m.local_relative_path)]);
    return json({ok:true});
  }
  if(path==='/api/admin/abandon'){
    await guarded(env,b.generation,b.epoch,b.run_id,[
      env.DB.prepare("UPDATE content_items SET status=json_extract((SELECT payload FROM models WHERE content_id=content_items.id),'$.status') WHERE id IN (SELECT content_id FROM models WHERE local_relative_path IN (SELECT path FROM staged_deletes WHERE run_id=?))").bind(b.run_id),
      env.DB.prepare('DELETE FROM staged_models WHERE run_id=?').bind(b.run_id),env.DB.prepare('DELETE FROM staged_deletes WHERE run_id=?').bind(b.run_id),
      env.DB.prepare("UPDATE sync_runs SET status='ABANDONED',finished_at=unixepoch() WHERE id=?").bind(b.run_id),
      env.DB.prepare('UPDATE sync_control SET active_run=NULL WHERE dataset_id=?').bind(dataset)]);
    return json({ok:true});
  }
  if(path==='/api/admin/tombstone'){
    safePath(b.path);
    await guarded(env,b.generation,b.epoch,b.run_id,[env.DB.prepare('INSERT OR IGNORE INTO staged_deletes VALUES(?,?)').bind(b.run_id,b.path),env.DB.prepare("UPDATE content_items SET status='DELETED' WHERE id IN (SELECT content_id FROM models WHERE local_relative_path=?)").bind(b.path),env.DB.prepare("INSERT OR REPLACE INTO sync_operations(id,run_id,op_kind,relative_path,status) VALUES(?,?,'DELETE_MODEL',?,'TOMBSTONED')").bind(b.run_id+':delete:'+b.path,b.run_id,b.path)]);
    return json({ok:true});
  }
  if(path==='/api/admin/publish'){
    const done=await env.DB.prepare("SELECT base_generation+1 generation FROM sync_runs WHERE id=? AND status='COMPLETED'").bind(b.run_id).first();
    if(done) return json(done);
    const m=b.manifest as Manifest;
    if(!m||m.schema!==1||m.dataset_id!==dataset||m.generation!==b.generation+1||!Array.isArray(m.models)||!b.manifest_remote_id) throw new Error('Invalid manifest');
    const paths=new Set<string>(), ids=new Set<string>();
    for(const item of m.models){validateModel(item);if(paths.has(item.local_relative_path.toLowerCase())||ids.has(item.id))throw new Error('Duplicate model');paths.add(item.local_relative_path.toLowerCase());ids.add(item.id)}
    const serialized=canonical(m);
    if(await sha256(serialized)!==b.manifest_sha256) throw new Error('Manifest checksum mismatch');
    // Compare the client snapshot with committed data + this run's staged changes.
    const existing=await env.DB.prepare('SELECT local_relative_path path,payload FROM models').all<{path:string,payload:string}>();
    const staged=await env.DB.prepare('SELECT path,payload FROM staged_models WHERE run_id=?').bind(b.run_id).all<{path:string,payload:string}>();
    const deleted=await env.DB.prepare('SELECT path FROM staged_deletes WHERE run_id=?').bind(b.run_id).all<{path:string}>();
    const expected=new Map(existing.results.map(r=>{const item=JSON.parse(r.payload);item.artist_name=formatArtistName(item.artist_name);return [r.path,item]}));
    staged.results.forEach(r=>expected.set(r.path,JSON.parse(r.payload)));deleted.results.forEach(r=>expected.delete(r.path));
    if(expected.size!==m.models.length||m.models.some(item=>canonical(expected.get(item.local_relative_path))!==canonical(item))) throw new Error('Manifest differs from staged catalog');
    const r2key=`manifests/${b.run_id}-${b.manifest_sha256}.json`;
    await env.PREVIEWS.put(r2key,serialized,{customMetadata:{sha256:b.manifest_sha256}});
    const affected="SELECT json_extract(payload,'$.id') FROM staged_models WHERE run_id=? UNION SELECT content_id FROM models WHERE local_relative_path IN (SELECT path FROM staged_deletes WHERE run_id=?)";
    const queries=[
      env.DB.prepare(`DELETE FROM model_images WHERE content_id IN (${affected})`).bind(b.run_id,b.run_id),
      env.DB.prepare(`DELETE FROM model_files WHERE content_id IN (${affected})`).bind(b.run_id,b.run_id),
      env.DB.prepare('DELETE FROM models WHERE local_relative_path IN (SELECT path FROM staged_deletes WHERE run_id=?)').bind(b.run_id),
      env.DB.prepare("INSERT INTO content_items(id,section_id,slug,title,status,created_at,updated_at) SELECT json_extract(payload,'$.id'),'models',json_extract(payload,'$.id'),json_extract(payload,'$.character_name'),json_extract(payload,'$.status'),unixepoch(),unixepoch() FROM staged_models WHERE run_id=? ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,updated_at=excluded.updated_at").bind(b.run_id),
      env.DB.prepare("INSERT INTO models SELECT json_extract(payload,'$.id'),json_extract(payload,'$.style'),json_extract(payload,'$.artist_category'),json_extract(payload,'$.artist_name'),json_extract(payload,'$.media_title'),json_extract(payload,'$.character_name'),path,payload FROM staged_models WHERE run_id=? ON CONFLICT(content_id) DO UPDATE SET style=excluded.style,artist_category=excluded.artist_category,artist_name=excluded.artist_name,media_title=excluded.media_title,character_name=excluded.character_name,local_relative_path=excluded.local_relative_path,payload=excluded.payload").bind(b.run_id),
      env.DB.prepare("INSERT INTO model_files SELECT json_extract(s.payload,'$.id')||':'||json_extract(f.value,'$.path'),json_extract(s.payload,'$.id'),substr(json_extract(f.value,'$.path'),6),'',json_extract(f.value,'$.size'),json_extract(f.value,'$.sha256'),json_extract(f.value,'$.remote_id'),'ACTIVE' FROM staged_models s,json_each(s.payload,'$.files') f WHERE s.run_id=? AND json_extract(f.value,'$.kind')='model'").bind(b.run_id),
      env.DB.prepare("INSERT INTO model_images SELECT json_extract(s.payload,'$.id')||':'||json_extract(f.value,'$.path'),json_extract(s.payload,'$.id'),substr(json_extract(f.value,'$.path'),9),json_extract(f.value,'$.remote_id'),json_extract(f.value,'$.sha256'),json_extract(f.value,'$.size'),json_extract(f.value,'$.preview_r2_key'),json_extract(f.value,'$.preview_sha256'),json_extract(f.value,'$.role'),COALESCE(json_extract(f.value,'$.sort_order'),0),json_extract(f.value,'$.width'),json_extract(f.value,'$.height') FROM staged_models s,json_each(s.payload,'$.files') f WHERE s.run_id=? AND json_extract(f.value,'$.kind')='image'").bind(b.run_id),
      env.DB.prepare('INSERT INTO recovery_snapshots VALUES(?,?,?,?,?,?,1,unixepoch())').bind(b.run_id,dataset,m.generation,b.manifest_remote_id,r2key,b.manifest_sha256),
      env.DB.prepare("UPDATE sync_runs SET status='COMPLETED',finished_at=unixepoch() WHERE id=?").bind(b.run_id),
      env.DB.prepare("UPDATE sync_operations SET status='COMPLETED' WHERE run_id=?").bind(b.run_id),
      env.DB.prepare('UPDATE sync_control SET generation=?,active_run=NULL,updated_at=unixepoch() WHERE dataset_id=?').bind(m.generation,dataset),
      env.DB.prepare('DELETE FROM staged_models WHERE run_id=?').bind(b.run_id),env.DB.prepare('DELETE FROM staged_deletes WHERE run_id=?').bind(b.run_id)
    ];
    await guarded(env,b.generation,b.epoch,b.run_id,queries);
    return json({generation:m.generation});
  }
  return json({error:'Not found'},404);
}
export default {
  async scheduled(_event:ScheduledController,env:Env,ctx:ExecutionContext){ctx.waitUntil(cleanupSubmissions(env))},
  async fetch(request:Request,env:Env):Promise<Response>{
    let response:Response;
    try{response=await route(request,env)}catch(error){const message=error instanceof Error?error.message:'Unexpected error';response=json({error:message.startsWith('CONFLICT:')?message.slice(10):message},message.startsWith('CONFLICT:')?409:400)}
    const headers=new Headers(response.headers);
    headers.set('X-Robots-Tag',robots);headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
    if(new URL(request.url).pathname.startsWith('/api/admin/')||new URL(request.url).pathname==='/api/preview-key') headers.set('Cache-Control','no-store');
    const origin=request.headers.get('Origin');
    if(origin===env.SITE_ORIGIN){headers.set('Access-Control-Allow-Origin',origin);headers.set('Vary','Origin')}
    headers.set('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');headers.set('Access-Control-Allow-Headers','Authorization,Content-Type,X-Generation,X-Lock-Epoch,X-Upload-Token,Range');
    return new Response(response.body,{status:response.status,headers});
  }
};
