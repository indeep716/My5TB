import {type Env,type Model,type ModelFile,formatArtistName,sha256} from './contracts';

const FORMAT_LABELS:Record<string,string>={blend:'BLEND',blen:'BLEND',fbx:'FBX',ma:'MAYA',mb:'MAYA',maya:'MAYA',max:'MAX',c4d:'C4D',obj:'OBJ',glb:'GLB',gltf:'GLTF',dae:'DAE','3ds':'3DS',abc:'ABC',usd:'USD',usda:'USD',usdc:'USD',usdz:'USDZ',stl:'STL',ply:'PLY',ztl:'ZBRUSH',zpr:'ZBRUSH',vrm:'VRM',pmx:'MMD',pmd:'MMD',mmd:'MMD',vmd:'MMD',vpd:'MMD',pmm:'MMD',x:'MMD',unitypackage:'UNITY',uasset:'UNREAL',skp:'SKP',hip:'HOUDINI',spp:'PAINTER'};
function modelFormats(payload:string):string[]{
  try{
    const m=JSON.parse(payload) as Partial<Model>;
    if(Array.isArray(m.formats)&&m.formats.length)return [...new Set(m.formats.filter(v=>typeof v==='string'))].sort();
    const files=Array.isArray(m.files)?m.files.filter((f):f is ModelFile=>!!f&&f.kind==='model'):[];
    return [...new Set(files.flatMap(f=>Array.isArray(f.formats)&&f.formats.length?f.formats.filter(v=>typeof v==='string'):[FORMAT_LABELS[(String(f.path||'').split('.').at(-1)||'').toLowerCase()]||(String(f.path||'').split('.').at(-1)||'').toUpperCase()||'3D']))].sort();
  }catch{return []}
}

// Append to every public catalog, detail, facet and preview query using alias c.
export const publicPublicationPredicate="NOT EXISTS (SELECT 1 FROM publication_overrides po WHERE po.content_id=c.id AND po.published=0)";
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers})}

export async function publicationRoute(request:Request,env:Env):Promise<Response|null>{
  const url=new URL(request.url);
  if(!['/api/admin/publication','/api/admin/publication/details'].includes(url.pathname))return null;
  if(!env.ADMIN_TOKEN||env.ADMIN_TOKEN.length<24||await sha256(request.headers.get('Authorization')||'')!==await sha256('Bearer '+env.ADMIN_TOKEN))return json({error:'Admin authentication required'},401);
  if(request.method==='GET'){
    const limit=Number(url.searchParams.get('limit')??200),offset=Number(url.searchParams.get('offset')??0);
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0||offset>10000000)return json({error:'Invalid pagination'},400);
    const from=' FROM models m JOIN content_items c ON c.id=m.content_id JOIN site_sections s ON s.id=c.section_id';
    const total=await env.DB.prepare('SELECT COUNT(*) n'+from).first<{n:number}>();
    const rows=await env.DB.prepare("SELECT COALESCE(md.upload_by,'') upload_by,COALESCE(md.link,'') link,COALESCE(md.description,'') description,c.id,c.title,COALESCE(json_extract(m.payload,'$.asset_category'),'Characters') asset_category,m.style,m.artist_category source,m.artist_name,m.media_title,m.character_name,COALESCE(json_extract(m.payload,'$.version'),'') version,m.local_relative_path path,m.payload,c.status,c.visibility,s.enabled,COALESCE(po.published,1) published"+from+' LEFT JOIN model_details md ON md.content_id=c.id LEFT JOIN publication_overrides po ON po.content_id=c.id ORDER BY c.id LIMIT ? OFFSET ?').bind(limit,offset).all<{id:string;title:string;asset_category:string;style:string;source:string;artist_name:string;media_title:string;character_name:string;version:string;path:string;payload:string;upload_by:string;link:string;description:string;status:string;visibility:string;enabled:number;published:number}>();
    return json({items:rows.results.map(({visibility,enabled,payload,artist_name,character_name,version,...row})=>{const formats=modelFormats(payload);return {...row,title:character_name+(version?' / '+version:'')||row.title,artist:formatArtistName(artist_name),artist_name:formatArtistName(artist_name),formats,type:formats.join('/'),published:row.published===1,eligible:row.status==='ACTIVE'&&visibility==='PUBLIC'&&enabled===1}}),total:total?.n||0,limit,offset});
  }
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if((request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'JSON Content-Type required'},415);
  const bodyLimit=url.pathname.endsWith('/details')?100000:20000;
  if(Number(request.headers.get('Content-Length')||0)>bodyLimit)return json({error:'Request too large'},413);
  const reader=request.body?.getReader(),chunks:Uint8Array[]=[];
  let length=0;
  if(reader){
    try{
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        length+=value.byteLength;
        if(length>bodyLimit){await reader.cancel();return json({error:'Request too large'},413)}
        chunks.push(value);
      }
    }finally{reader.releaseLock()}
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  const raw=new TextDecoder().decode(bytes);
  let body:unknown;
  try{body=JSON.parse(raw)}catch{return json({error:'Invalid JSON'},400)}
  if(url.pathname.endsWith('/details')){
    const b=body as Record<string,unknown>|null;
    if(!b||typeof b.id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(b.id))return json({error:'Invalid model id'},400);
    for(const [name,max] of [['upload_by',200],['link',2000],['description',10000]] as const)if(typeof b[name]!=='string'||(b[name] as string).length>max)return json({error:'Invalid '+name},400);
    const link=(b.link as string).trim();
    if(link){try{const u=new URL(link);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error()}catch{return json({error:'Link must be an HTTP or HTTPS URL without credentials'},400)}}
    if(!await env.DB.prepare('SELECT content_id FROM models WHERE content_id=?').bind(b.id).first())return json({error:'Model not found'},404);
    await env.DB.prepare('INSERT INTO model_details VALUES(?,?,?,?) ON CONFLICT(content_id) DO UPDATE SET upload_by=excluded.upload_by,link=excluded.link,description=excluded.description').bind(b.id,(b.upload_by as string).trim(),link,(b.description as string).trim()).run();return json({ok:true});
  }
  const value=body as {ids?:unknown;published?:unknown}|null;
  if(!value||typeof value.published!=='boolean'||!Array.isArray(value.ids)||value.ids.length<1||value.ids.length>200||value.ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(id)))return json({error:'Expected 1–200 model ids and a boolean published flag'},400);
  const ids=[...new Set(value.ids as string[])];
  let known=0;
  for(let start=0;start<ids.length;start+=80){
    const group=ids.slice(start,start+80),placeholders=group.map(()=>'?').join(',');
    const matches=await env.DB.prepare(`SELECT content_id FROM models WHERE content_id IN (${placeholders})`).bind(...group).all();
    known+=matches.results.length;
  }
  if(known!==ids.length)return json({error:'Unknown model id; no publication changes applied'},404);
  // This batch changes only overrides. Normal ingestion never writes this table.
  await env.DB.batch(ids.map(id=>env.DB.prepare('INSERT INTO publication_overrides(content_id,published,updated_at) VALUES(?,?,unixepoch()) ON CONFLICT(content_id) DO UPDATE SET published=excluded.published,updated_at=excluded.updated_at').bind(id,value.published?1:0)));
  return json({updated:ids.length,published:value.published});
}
