export interface Env {DB:D1Database; PREVIEWS:R2Bucket; ADMIN_TOKEN:string; PREVIEW_KEY_B64:string; SITE_ORIGIN:string; DATASET_ID:string}
export interface ModelFile {path:string;kind:'model'|'image';size:number;mtime_ns:string;sha256:string;remote_id:string;role?:'main'|'sub'|'ignore';preview_r2_key?:string;preview_sha256?:string;width?:number;height?:number;sort_order?:number;formats?:string[];contents?:string[]}
export interface Model {id:string;local_relative_path:string;asset_category?:string;style:string;artist_category:string;artist_name:string;media_title:string;character_name:string;version?:string;status:'ACTIVE'|'DRAFT';roles:Record<string,string>;files:ModelFile[];formats?:string[]}
export interface Manifest {schema:1;dataset_id:string;generation:number;models:Model[]}
export function safePath(path:unknown):string {
  if(typeof path!=='string'||!path||path.normalize('NFC')!==path||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('_')||/[ .]$/.test(p)||/[\x00-\x1f<>:"|?*]/.test(p)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))) throw new Error('Invalid path');
  return path;
}
export function formatArtistName(value:string):string {
  const formatted=String(value||'').replace(/\s*[（(]\s*([^）)]+?)\s*[）)]/g,' | $1').replace(/^(?:\s*\|\s*)+|(?:\s*\|\s*)+$/g,'').replace(/\s*\|\s*/g,' | ').trim();
  return formatted||String(value||'').trim();
}
export function validateModel(m:Model):Model {
  if(!m||typeof m.id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(m.id)||!['Stylized','Realism'].includes(m.style)||!['Artists','Official','RIP'].includes(m.artist_category)||!['ACTIVE','DRAFT'].includes(m.status)) throw new Error('Invalid model');
  safePath(m.local_relative_path);
  if(m.asset_category!==undefined&&(safePath(m.asset_category).includes('/'))) throw new Error('Invalid asset category');
  if(m.local_relative_path.split('/').length<3||![m.artist_name,m.media_title,m.character_name].every(s=>typeof s==='string'&&s.length>0&&s.length<=500)||!Array.isArray(m.files)||m.files.length>2000) throw new Error('Invalid model metadata');
  m.artist_name=formatArtistName(m.artist_name);
  const names=new Set<string>(); let mains=0;
  for(const f of m.files){
    const p=safePath(f.path), parts=p.split('/');
    if(parts.length!==2||!['file','picture'].includes(parts[0])||names.has(p.toLowerCase())||!Number.isSafeInteger(f.size)||f.size<0||typeof f.mtime_ns!=='string'||!/^\d{1,22}$/.test(f.mtime_ns)||!/^[a-f0-9]{64}$/.test(f.sha256)||typeof f.remote_id!=='string'||!f.remote_id) throw new Error('Invalid model file');
    names.add(p.toLowerCase());
    if(f.kind==='image'){
      if(parts[0]!=='picture'||!['main','sub','ignore'].includes(f.role||'')) throw new Error('Invalid image');
      if(f.role==='main') mains++;
      if(f.role!=='ignore'&&(!f.preview_r2_key?.startsWith('previews/')||!/^[a-f0-9]{64}$/.test(f.preview_sha256||''))) throw new Error('Unverified preview');
    } else if(f.kind!=='model'||parts[0]!=='file') throw new Error('Invalid model file kind');
  }
  if(m.status==='ACTIVE'&&(mains!==1||!m.files.some(f=>f.kind==='model'))) throw new Error('Active model needs one main image and model files');
  if(mains>1) throw new Error('Multiple main images');
  return m;
}
export function canonical(value:unknown):string {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object') return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export async function sha256(value:string|ArrayBuffer):Promise<string>{
  const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
