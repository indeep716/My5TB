import {type Env,sha256} from './contracts';
import {validateSubmissionArchive} from './archive-formats';

const MiB=1024*1024,GiB=1024*MiB;
export const SUBMISSION_PART_SIZE=32*MiB;
const MAX_ARCHIVE=5*GiB,MAX_IMAGES=8,MAX_IMAGE=8*MiB,MAX_ENTRIES=200,MAX_DIRECTORY=2*MiB;
type SubmissionEnv=Pick<Env,'DB'|'PREVIEWS'|'ADMIN_TOKEN'>;
interface Session {extra_details:string;id:string;token_hash:string;source:string;artist:string;media_title:string;character_name:string;archive_name:string;archive_size:number;image_count:number;upload_id:string;status:'OPEN'|'READY'|'REJECTED';report:string|null;created_at:number;expires_at:number;lock_until:number}
interface ZipReport {valid:boolean;summary:string;entries?:number;expanded_bytes?:number;model_files?:string[];formats?:string[];unknown_bytes?:number;largest_files?:{name:string;compressed_bytes:number|null;expanded_bytes:number}[];error?:string}
class UploadError extends Error {constructor(message:string,readonly status=400){super(message)}}
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'}})}
function now(){return Math.floor(Date.now()/1000)}
function key(id:string){return `submissions/${id}/archive.zip`}
function fail(message:string,status=400):never{throw new UploadError(message,status)}
async function boundedBody(request:Request,limit:number){
  const advertised=request.headers.get('Content-Length');if(advertised!==null&&(!/^\d+$/.test(advertised)||Number(advertised)>limit))fail('Request too large',413);
  if(!request.body)return new Uint8Array();const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();fail('Request too large',413)}chunks.push(value)}}finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}return bytes;
}
async function bodyJson(request:Request){if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')fail('JSON required',415);try{return JSON.parse(new TextDecoder().decode(await boundedBody(request,100000))) as Record<string,unknown>}catch(e){if(e instanceof UploadError)throw e;return fail('Invalid JSON')}}
async function uploadPartBounded(request:Request,upload:R2MultipartUpload,n:number,expected:number){
  const length=request.headers.get('Content-Length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==expected))fail('Part length differs from declared archive size');
  // Native Workers preserve the exact known length and backpressure without buffering 32 MiB.
  if(typeof FixedLengthStream==='function'&&request.body){const stream=new FixedLengthStream(expected);const [part]=await Promise.all([upload.uploadPart(n,stream.readable),request.body.pipeTo(stream.writable)]);return part}
  // Node-hosted contract tests lack the Workers-only FixedLengthStream global.
  const bytes=await boundedBody(request,expected);if(bytes.length!==expected)fail('Part length differs from declared archive size');return upload.uploadPart(n,bytes);
}
async function range(bucket:R2Bucket,objectKey:string,offset:number,length:number){
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(length)||length<1||length>MAX_DIRECTORY)fail('Invalid ZIP range');
  const object=await bucket.get(objectKey,{range:{offset,length}});if(!object)fail('Archive missing');const data=new Uint8Array(await object.arrayBuffer());if(data.length!==length)fail('Truncated ZIP');return data;
}
function view(data:Uint8Array){return new DataView(data.buffer,data.byteOffset,data.byteLength)}
function u64(v:DataView,n:number){const value=v.getBigUint64(n,true);if(value>BigInt(Number.MAX_SAFE_INTEGER))fail('ZIP64 number out of range');return Number(value)}

// Decode only the first 4 KiB; input is capped at 64 KiB. No whole-file inflation.
// Canonical Huffman decoding handles stored, fixed and dynamic raw DEFLATE blocks.
function inflatePrefix(input:Uint8Array,limit=4096){
  let bit=0;const out:number[]=[];
  function read(n:number){if(bit+n>input.length*8)fail('Model signature exceeds bounded ZIP sample');let value=0;for(let i=0;i<n;i++)value|=((input[bit>>3]>>(bit++&7))&1)<<i;return value}
  function tree(lengths:number[]){const count=new Array(16).fill(0),next=new Array(16).fill(0),map=new Map<number,number>();for(const n of lengths){if(n<0||n>15)fail('Invalid DEFLATE tree');if(n)count[n]++}let code=0;for(let n=1;n<=15;n++){code=(code+count[n-1])*2;next[n]=code;if(code+count[n]>2**n)fail('Invalid DEFLATE tree')}
    lengths.forEach((n,symbol)=>{if(n){const c=next[n]++;let reversed=0;for(let i=0;i<n;i++)reversed=(reversed<<1)|((c>>i)&1);map.set((1<<n)|reversed,symbol)}});return map}
  function decode(t:Map<number,number>){let c=0;for(let n=1;n<=15;n++){c|=read(1)<<(n-1);const symbol=t.get((1<<n)|c);if(symbol!==undefined)return symbol}return fail('Invalid DEFLATE symbol')}
  const lb=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258],le=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const db=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577],de=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  for(let blocks=0;blocks<1024;blocks++){
    const last=read(1),type=read(2);if(type===0){bit=(bit+7)&~7;const n=read(16);if((n^read(16))!==65535)fail('Invalid stored DEFLATE block');for(let i=0;i<n;i++){out.push(read(8));if(out.length>=limit)return new Uint8Array(out)}}else{
      let lit:Map<number,number>,dist:Map<number,number>;
      if(type===1){lit=tree(Array.from({length:288},(_,i)=>i<144?8:i<256?9:i<280?7:8));dist=tree(new Array(32).fill(5))}
      else if(type===2){const nl=read(5)+257,nd=read(5)+1,nc=read(4)+4;if(nl>286)fail('Invalid DEFLATE literal count');
        // RFC 1951 code-length order.
        const actualOrder=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15],cl=new Array(19).fill(0);
        for(let i=0;i<nc;i++)cl[actualOrder[i]]=read(3);const ct=tree(cl),lengths:number[]=[];
        while(lengths.length<nl+nd){const s=decode(ct);if(s<16)lengths.push(s);else{if(s===16&&!lengths.length)fail('Invalid DEFLATE repeat');const repeat=s===16?read(2)+3:s===17?read(3)+3:read(7)+11;for(let i=0;i<repeat;i++)lengths.push(s===16?lengths[lengths.length-1]:0)}if(lengths.length>nl+nd)fail('Invalid DEFLATE lengths')}
        lit=tree(lengths.slice(0,nl));dist=tree(lengths.slice(nl));
      }else return fail('Invalid DEFLATE block');
      for(let symbols=0;symbols<131072;symbols++){const s=decode(lit);if(s===256)break;if(s<256)out.push(s);else{if(s<257||s>285)fail('Invalid DEFLATE length');const len=lb[s-257]+read(le[s-257]),d=decode(dist);if(d>29)fail('Invalid DEFLATE distance');const distance=db[d]+read(de[d]);if(distance>out.length)fail('Invalid DEFLATE back reference');for(let i=0;i<len;i++){out.push(out[out.length-distance]);if(out.length>=limit)return new Uint8Array(out)}}if(out.length>=limit)return new Uint8Array(out)}
    }if(last)return new Uint8Array(out);
  }return fail('Excessive DEFLATE blocks');
}
const modelExtensions=new Set(['blend','fbx','glb','gltf','obj','stl','ply','dae','pmx','pmd','3ds','usd','usda','usdc','vrm']);
const companionExtensions=new Set(['png','jpg','jpeg','webp','gif','tga','tif','tiff','dds','bmp','exr','hdr','mtl','txt','md','pdf','json','bin','vmd','vpd']);
function signature(ext:string,b:Uint8Array,expanded:number){const t=new TextDecoder().decode(b),v=view(b);
  if(ext==='blend')return /^BLENDER[_-][vV]\d{3}/.test(t);
  if(ext==='fbx')return t.startsWith('Kaydara FBX Binary  \0')||/^; FBX \d/.test(t);
  if(ext==='glb'||ext==='vrm')return b.length>=20&&t.startsWith('glTF')&&v.getUint32(4,true)===2&&v.getUint32(8,true)===expanded&&v.getUint32(16,true)===0x4e4f534a;
  if(ext==='pmx')return t.startsWith('PMX ')&&b.length>=9&&(v.getFloat32(4,true)>=2&&v.getFloat32(4,true)<2.2);
  if(ext==='pmd')return t.startsWith('Pmd')&&b.length>=7&&v.getFloat32(3,true)===1;
  if(ext==='ply')return /^ply\r?\nformat (ascii|binary_little_endian|binary_big_endian) 1\.0/.test(t);
  if(ext==='3ds')return b[0]===0x4d&&b[1]===0x4d&&b.length>=6;
  if(ext==='usd'||ext==='usdc'||ext==='usda')return t.startsWith('PXR-USDC')||t.startsWith('#usda 1.0');
  if(ext==='gltf')return /^\s*\{/.test(t)&&/"asset"\s*:/.test(t)&&/"version"\s*:\s*"2\./.test(t);
  if(ext==='obj')return (t.match(/(?:^|\n)v[ \t]+[-+\d.eE]+[ \t]+[-+\d.eE]+[ \t]+[-+\d.eE]+/g)||[]).length>=3;
  if(ext==='dae')return /<COLLADA[\s>]/.test(t);
  if(ext==='stl')return /^solid\s/.test(t)&&/facet normal\s/.test(t)||b.length>=84&&v.getUint32(80,true)>0&&84+v.getUint32(80,true)*50===expanded;
  return false;
}
function gifDimensions(bytes:Uint8Array){
  const v=view(bytes);if(bytes.length<14)fail('Truncated GIF');
  const width=v.getUint16(6,true),height=v.getUint16(8,true);
  if(!width||!height||width>8192||height>8192||width*height>32000000)fail('GIF dimensions exceed limits');
  let p=13+((bytes[10]&128)?3*(2**((bytes[10]&7)+1)):0),frames=0,blocks=0;
  const subBlocks=(limit:number)=>{let total=0;for(;;){if(p>=bytes.length)fail('Truncated GIF data');const length=bytes[p++];if(!length)return;if(p+length>bytes.length||(total+=length)>limit)fail('GIF block exceeds limits');p+=length}};
  while(p<bytes.length&&++blocks<=2048){
    const kind=bytes[p++];
    if(kind===0x3b){if(!frames||p!==bytes.length)fail('Invalid GIF trailer');return {width,height,frames}}
    if(kind===0x21){if(p>=bytes.length)fail('Truncated GIF extension');p++;subBlocks(65536);continue}
    if(kind!==0x2c||p+9>bytes.length)fail('Invalid GIF image block');
    const left=v.getUint16(p,true),top=v.getUint16(p+2,true),w=v.getUint16(p+4,true),h=v.getUint16(p+6,true),packed=bytes[p+8];p+=9;
    if(!w||!h||left+w>width||top+h>height||++frames>120||width*height*frames>32000000)fail('GIF frame count or decoded pixel budget exceeded');
    if(packed&128)p+=3*(2**((packed&7)+1));
    if(p>=bytes.length||bytes[p]<2||bytes[p]>8)fail('Invalid GIF LZW code size');p++;subBlocks(MAX_IMAGE);
  }
  return fail('GIF is truncated or contains too many blocks');
}
function imageType(bytes:Uint8Array){
  const v=view(bytes),text=(start:number,end:number)=>new TextDecoder().decode(bytes.slice(start,end));let type='',width=0,height=0;
  if(['GIF87a','GIF89a'].includes(text(0,6))){const dimensions=gifDimensions(bytes);type='image/gif';width=dimensions.width;height=dimensions.height}
  else if(bytes.length>=33&&bytes.slice(0,8).every((b,i)=>b===[137,80,78,71,13,10,26,10][i])&&text(12,16)==='IHDR'&&v.getUint32(8)===13){type='image/png';width=v.getUint32(16);height=v.getUint32(20)}
  else if(bytes.length>=12&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255){
    type='image/jpeg';let p=2;while(p+4<Math.min(bytes.length,65536)){if(bytes[p++]!==255)break;while(bytes[p]===255)p++;const marker=bytes[p++];if(marker===0xda||marker===0xd9)break;if(marker===1||marker>=0xd0&&marker<=0xd7)continue;if(p+2>bytes.length)break;const len=v.getUint16(p);if(len<2||p+len>bytes.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&len>=8){height=v.getUint16(p+3);width=v.getUint16(p+5);break}p+=len}
  }else if(bytes.length>=30&&text(0,4)==='RIFF'&&text(8,12)==='WEBP'&&v.getUint32(4,true)+8===bytes.length){
    type='image/webp';const chunk=text(12,16);if(chunk==='VP8X'){width=1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16);height=1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16)}
    else if(chunk==='VP8L'&&bytes[20]===0x2f){const bits=v.getUint32(21,true);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1}
    else if(chunk==='VP8 '&&bytes[23]===0x9d&&bytes[24]===1&&bytes[25]===0x2a){width=v.getUint16(26,true)&0x3fff;height=v.getUint16(28,true)&0x3fff}
  }
  if(!type||!width||!height||width>8192||height>8192||width*height>32_000_000)fail('PNG, JPEG, WebP or GIF with valid dimensions up to 8192 px and 32 megapixels required');return type;
}

export async function validateSubmissionZip(bucket:R2Bucket,objectKey:string,size:number):Promise<ZipReport>{
  try{
    if(size<22||size>MAX_ARCHIVE)fail('Archive size is outside limits');
    const tail=await range(bucket,objectKey,Math.max(0,size-65557),Math.min(size,65557)),tv=view(tail);let end=-1;
    for(let p=tail.length-22;p>=0;p--)if(tv.getUint32(p,true)===0x06054b50&&p+22+tv.getUint16(p+20,true)===tail.length){end=p;break}
    if(end<0)fail('ZIP end directory missing or trailing data');
    if(tv.getUint16(end+4,true)||tv.getUint16(end+6,true)||tv.getUint16(end+8,true)!==tv.getUint16(end+10,true))fail('Split ZIP archives are unsupported');
    let count=tv.getUint16(end+10,true),directorySize=tv.getUint32(end+12,true),directoryOffset=tv.getUint32(end+16,true),endOffset=size-tail.length+end;
    if(count===65535||directorySize===0xffffffff||directoryOffset===0xffffffff){
      if(endOffset<20)fail('Missing ZIP64 locator');const locator=view(await range(bucket,objectKey,endOffset-20,20));if(locator.getUint32(0,true)!==0x07064b50||locator.getUint32(4,true)!==0||locator.getUint32(16,true)!==1)fail('Invalid ZIP64 locator');
      const zp=u64(locator,8),z=view(await range(bucket,objectKey,zp,56));if(z.getUint32(0,true)!==0x06064b50||u64(z,4)!==44||z.getUint32(16,true)||z.getUint32(20,true)||u64(z,24)!==u64(z,32)||zp+56!==endOffset-20)fail('Unsupported ZIP64 directory');count=u64(z,32);directorySize=u64(z,40);directoryOffset=u64(z,48);endOffset=zp;
    }
    if(!count||count>MAX_ENTRIES||directorySize>MAX_DIRECTORY||directoryOffset+directorySize!==endOffset)fail('ZIP directory exceeds limits or is inconsistent');
    const directory=await range(bucket,objectKey,directoryOffset,directorySize),v=view(directory),names=new Set<string>(),entries:{name:string;ext:string;flags:number;method:number;compressed:number;expanded:number;offset:number;nameBytes:Uint8Array;crc:number}[]=[];
    let pos=0,expanded=0,unrelated=0,modelBytes=0;
    for(let i=0;i<count;i++){
      if(pos+46>directory.length||v.getUint32(pos,true)!==0x02014b50)fail('Malformed ZIP central directory');
      const flags=v.getUint16(pos+8,true),method=v.getUint16(pos+10,true),nl=v.getUint16(pos+28,true),xl=v.getUint16(pos+30,true),cl=v.getUint16(pos+32,true);let compressed=v.getUint32(pos+20,true),length=v.getUint32(pos+24,true),offset=v.getUint32(pos+42,true);
      if(flags&~0x080e||flags&1||flags&0x40||![0,8].includes(method)||v.getUint16(pos+34,true)||nl<1||nl>512||xl>4096||cl>1024||pos+46+nl+xl+cl>directory.length)fail('Unsupported encryption, compression or oversized ZIP header');
      const nb=directory.slice(pos+46,pos+46+nl);let name:string;try{name=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(nb)}catch{fail('ZIP filenames must be UTF-8')}
      if(name!.includes('\\')||name!.startsWith('/')||/[:\x00-\x1f\x7f]/.test(name!)||name!.normalize('NFC')!==name||name!.replace(/\/$/,'').split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)))fail('Unsafe ZIP path');
      if(names.has(name!.toLowerCase()))fail('Duplicate ZIP path');names.add(name!.toLowerCase());
      const mode=v.getUint32(pos+38,true)>>>16;if((mode&0xf000)===0xa000)fail('ZIP symbolic links are unsupported');
      let extra=pos+46+nl,extraEnd=extra+xl,found=false;
      while(extra<extraEnd){if(extra+4>extraEnd)fail('Malformed ZIP extra field');const id=v.getUint16(extra,true),n=v.getUint16(extra+2,true);extra+=4;if(extra+n>extraEnd)fail('Malformed ZIP extra field');if(id===1){found=true;let at=extra;for(const field of ['expanded','compressed','offset']){const current=field==='expanded'?length:field==='compressed'?compressed:offset;if(current===0xffffffff){if(at+8>extra+n)fail('Truncated ZIP64 extra');const value=u64(v,at);at+=8;if(field==='expanded')length=value;else if(field==='compressed')compressed=value;else offset=value}}}extra+=n}
      if((compressed===0xffffffff||length===0xffffffff||offset===0xffffffff)&&!found)fail('ZIP64 extra missing');
      if(length>10*GiB||length>Math.max(1,compressed)*100||method===0&&compressed!==length||offset+30+nl+compressed>directoryOffset)fail('ZIP expansion ratio, size or offset is unsafe');
      expanded+=length;if(expanded>20*GiB)fail('ZIP expanded total exceeds 20 GiB');const ext=(name!.split('.').at(-1)||'').toLowerCase();
      if(!name!.endsWith('/')){if(modelExtensions.has(ext))modelBytes+=length;else if(!companionExtensions.has(ext))unrelated+=length;if(/^(exe|dll|com|scr|bat|cmd|ps1|js|vbs|msi|lnk|jar|zip|rar|7z)$/.test(ext))fail('Executable or nested archive content is unsupported')}
      entries.push({name:name!,ext,flags,method,compressed,expanded:length,offset,nameBytes:nb,crc:v.getUint32(pos+16,true)});pos+=46+nl+xl+cl;
    }
    if(pos!==directory.length||unrelated>256*MiB||unrelated>Math.max(modelBytes,MiB))fail('Unexpected directory data or suspicious unrelated content');
    const sorted=[...entries].sort((a,b)=>a.offset-b.offset);let previousEnd=0;
    for(const entry of sorted){
      if(entry.offset!==previousEnd)fail('Overlapping ZIP entries, prepended data or hidden content');const local=await range(bucket,objectKey,entry.offset,30),lv=view(local),nl=lv.getUint16(26,true),xl=lv.getUint16(28,true);
      if(lv.getUint32(0,true)!==0x04034b50||lv.getUint16(6,true)!==entry.flags||lv.getUint16(8,true)!==entry.method||nl!==entry.nameBytes.length||xl>4096)fail('ZIP local header mismatch');
      const localFields=await range(bucket,objectKey,entry.offset+30,nl+xl),localName=localFields.subarray(0,nl);if(localName.some((b,i)=>b!==entry.nameBytes[i]))fail('ZIP local filename mismatch');
      const zip64Local=lv.getUint32(18,true)===0xffffffff||lv.getUint32(22,true)===0xffffffff;
      if(!(entry.flags&8)){
        let compressed=lv.getUint32(18,true),expanded=lv.getUint32(22,true),found=!zip64Local;
        const ev=view(localFields);for(let p=nl;p<nl+xl;){if(p+4>nl+xl)fail('Malformed local ZIP extra');const tag=ev.getUint16(p,true),len=ev.getUint16(p+2,true);p+=4;if(p+len>nl+xl)fail('Malformed local ZIP extra');if(tag===1){found=true;let q=p;if(expanded===0xffffffff){if(q+8>p+len)fail('Truncated local ZIP64 size');expanded=u64(ev,q);q+=8}if(compressed===0xffffffff){if(q+8>p+len)fail('Truncated local ZIP64 size');compressed=u64(ev,q)}}p+=len}
        if(!found||lv.getUint32(14,true)!==entry.crc||compressed!==entry.compressed||expanded!==entry.expanded)fail('ZIP local size/checksum metadata mismatch');
      }
      const dataOffset=entry.offset+30+nl+xl;previousEnd=dataOffset+entry.compressed;if(previousEnd>directoryOffset)fail('ZIP entry exceeds data boundary');entry.offset=dataOffset;
      if(entry.flags&8){
        const wide=zip64Local||entry.compressed>=0xffffffff||entry.expanded>=0xffffffff,base=wide?20:12;
        const descriptor=await range(bucket,objectKey,previousEnd,base+4),dv=view(descriptor),start=dv.getUint32(0,true)===0x08074b50?4:0;
        if(dv.getUint32(start,true)!==entry.crc||(wide?u64(dv,start+4):dv.getUint32(start+4,true))!==entry.compressed||(wide?u64(dv,start+12):dv.getUint32(start+8,true))!==entry.expanded)fail('ZIP data descriptor mismatch');previousEnd+=base+start;
      }
    }
    if(previousEnd!==directoryOffset)fail('Hidden content before ZIP directory');
    const candidates=entries.filter(e=>modelExtensions.has(e.ext)&&e.expanded>0&&e.compressed>0);if(!candidates.length)fail('No supported model file found in ZIP');
    const verified:string[]=[];for(const entry of candidates.slice(0,12)){const sample=await range(bucket,objectKey,entry.offset,Math.min(entry.compressed,entry.method===0?4096:65536));const bytes=entry.method===0?sample:inflatePrefix(sample);if(signature(entry.ext,bytes,entry.expanded))verified.push(entry.name)}
    if(!verified.length)fail('No actual supported model signature verified in bounded sample');
    return {valid:true,summary:'ZIP structure and model signature verified; quarantined for administrator review.',entries:count,expanded_bytes:expanded,model_files:verified,formats:[...new Set(candidates.map(e=>e.ext.toUpperCase()))],unknown_bytes:unrelated,largest_files:[...entries].filter(e=>!e.name.endsWith('/')).sort((a,b)=>b.expanded-a.expanded).slice(0,5).map(e=>({name:e.name,compressed_bytes:e.compressed,expanded_bytes:e.expanded}))};
  }catch(e){return {valid:false,summary:'Archive rejected.',error:e instanceof Error?e.message:'ZIP validation failed'}}
}

async function erase(env:SubmissionEnv,s:Session){
  // An interrupted multipart upload and completed archive cannot share a live upload ID.
  if(s.upload_id)try{await env.PREVIEWS.resumeMultipartUpload(key(s.id),s.upload_id).abort()}catch(e){if(!await env.PREVIEWS.head(key(s.id))&&!/10024|NoSuchUpload|does not exist/i.test(String(e)))throw new Error('Multipart cleanup failed')}
  const objects=await env.PREVIEWS.list({prefix:`submissions/${s.id}/`,limit:32});if(objects.truncated)throw new Error('Unexpected submission objects');if(objects.objects.length)await env.PREVIEWS.delete(objects.objects.map(o=>o.key));
  await env.DB.batch([env.DB.prepare('UPDATE submission_usage SET reserved_bytes=0 WHERE id=?').bind(s.id),env.DB.prepare('DELETE FROM submission_parts WHERE submission_id=?').bind(s.id),env.DB.prepare('DELETE FROM submission_images WHERE submission_id=?').bind(s.id),env.DB.prepare('DELETE FROM submissions WHERE id=?').bind(s.id)]);
}
export async function cleanupSubmissions(env:SubmissionEnv){
  const time=now(),rows=await env.DB.prepare('SELECT * FROM submissions WHERE expires_at<? AND lock_until<? LIMIT 10').bind(time,time).all<Session>();
  for(const s of rows.results){const claimed=await env.DB.prepare('UPDATE submissions SET lock_until=? WHERE id=? AND lock_until<?').bind(time+300,s.id,time).run();if(claimed.meta.changes)try{await erase(env,s)}catch{await env.DB.prepare('UPDATE submissions SET lock_until=0 WHERE id=?').bind(s.id).run()}}
  await env.DB.prepare('DELETE FROM submission_usage WHERE created_at<?').bind(time-14*86400).run();return rows.results.length;
}
function imageExtension(type:string){return ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'} as Record<string,string>)[type]||'bin'}
async function download(request:Request,env:SubmissionEnv,objectKey:string,name:string,contentType='application/octet-stream'){
  const object=await env.PREVIEWS.head(objectKey);if(!object)return json({error:'File not found'},404);let offset=0,length=object.size,status=200;
  const r=request.headers.get('Range');if(r){const match=/^bytes=(\d+)-(\d*)$/.exec(r);if(!match)return json({error:'A single explicit byte range is required'},416);offset=Number(match[1]);const end=match[2]?Number(match[2]):Math.min(offset+SUBMISSION_PART_SIZE,object.size)-1;length=end-offset+1;if(offset<0||offset>=object.size||end>=object.size||length<1||length>SUBMISSION_PART_SIZE)return json({error:'Range exceeds 32 MiB or file bounds'},416);status=206}
  if(length>SUBMISSION_PART_SIZE)return json({error:'Use byte ranges of at most 32 MiB',size:object.size,part_size:SUBMISSION_PART_SIZE},416);
  const result=await env.PREVIEWS.get(objectKey,{range:{offset,length}});if(!result)return json({error:'File not found'},404);
  return new Response(result.body,{status,headers:{'Content-Type':contentType,'Content-Length':String(length),'Content-Disposition':`attachment; filename="${name.replace(/[^a-zA-Z0-9._-]/g,'_')}"`,'Cache-Control':'no-store','Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow',...(status===206?{'Content-Range':`bytes ${offset}-${offset+length-1}/${object.size}`}:{})}});
}
export async function handleSubmissions(request:Request,env:SubmissionEnv):Promise<Response|null>{
  const url=new URL(request.url),path=url.pathname,adminPath=path==='/api/admin/submissions'||path.startsWith('/api/admin/submissions/');
  if(!adminPath&&path!=='/api/submissions'&&!path.startsWith('/api/submissions/'))return null;
  try{
    if(adminPath){if(!env.ADMIN_TOKEN||env.ADMIN_TOKEN.length<24||await sha256(request.headers.get('Authorization')||'')!==await sha256('Bearer '+env.ADMIN_TOKEN))return json({error:'Admin Bearer authentication required'},401);
      if(path==='/api/admin/submissions'&&request.method==='GET'){
        const before=Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER,beforeId=(url.searchParams.get('before_id')||'').slice(0,80);
        const rows=await env.DB.prepare('SELECT id,source,artist,media_title,character_name,archive_name,archive_size,image_count,status,created_at,expires_at,report,extra_details FROM submissions WHERE created_at<? OR (created_at=? AND id<?) ORDER BY created_at DESC,id DESC LIMIT 50').bind(before,before,beforeId).all<Omit<Session,'token_hash'|'upload_id'|'lock_until'>>();
        const images=rows.results.length?(await env.DB.prepare('SELECT submission_id,image_number,content_type,size FROM submission_images WHERE submission_id IN (SELECT value FROM json_each(?)) ORDER BY image_number').bind(JSON.stringify(rows.results.map(s=>s.id))).all<{submission_id:string;image_number:number;content_type:string;size:number}>()).results:[];
        const last=rows.results.at(-1);return json({items:rows.results.map(s=>({...s,...JSON.parse(s.extra_details||'{}'),images:images.filter(i=>i.submission_id===s.id).map(i=>({number:i.image_number,content_type:i.content_type,size:i.size,filename:`image-${i.image_number}.${imageExtension(i.content_type)}`})),report:s.report?JSON.parse(s.report):null})),next_before:rows.results.length===50&&last?{before:last.created_at,before_id:last.id}:null});
      }
    }
    if(path==='/api/submissions'&&request.method==='POST'){
      if(!env.ADMIN_TOKEN||env.ADMIN_TOKEN.length<24)fail('Submissions are not configured',503);
      const b=await bodyJson(request),metadata:Record<string,string>={};for(const field of ['source','artist','media_title','character_name']){if(typeof b[field]!=='string'||!(b[field] as string).trim()||(b[field] as string).length>500||/[\x00-\x1f\x7f]/.test(b[field] as string))fail('All four metadata fields are required (maximum 500 characters)');metadata[field]=(b[field] as string).trim()}
      const optional:Record<string,string>={};
      if(b.asset_category!==undefined&&b.asset_category!=='Characters')fail('Only Characters is currently available');
      for(const [field,max] of [['upload_by',200],['link',2000],['description',10000]] as const){const value=b[field]??'';if(typeof value!=='string'||value.length>max)fail('Invalid '+field);optional[field]=value.trim()}
      if(optional.link){try{const link=new URL(optional.link);if(!['http:','https:'].includes(link.protocol)||link.username||link.password)throw Error()}catch{fail('Link must use HTTP or HTTPS without credentials')}}
      if(typeof b.archive_name!=='string'||b.archive_name.length>200||!/^.+\.(zip|rar|7z)$/i.test(b.archive_name)||/[\/\\\x00-\x1f\x7f]/.test(b.archive_name))fail('Choose exactly one ZIP, RAR or 7z archive');
      if(!Number.isSafeInteger(b.archive_size)||Number(b.archive_size)<22||Number(b.archive_size)>MAX_ARCHIVE)fail('Archive must be between 22 bytes and 5 GiB');
      const images=b.image_count??0;if(!Number.isInteger(images)||Number(images)<0||Number(images)>MAX_IMAGES)fail('At most 8 images are allowed');
      const rawIp=request.headers.get('CF-Connecting-IP');if(!rawIp)fail('Client address unavailable',503);
      const id=crypto.randomUUID(),token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),time=now(),reserved=Number(b.archive_size)+Number(images)*MAX_IMAGE;
      const ip=await sha256(env.ADMIN_TOKEN+':submission-ip:'+rawIp);
      try{
        const results=await env.DB.batch([
          env.DB.prepare(`INSERT INTO submissions(id,token_hash,source,artist,media_title,character_name,archive_name,archive_size,image_count,reserved_bytes,upload_id,created_at,expires_at,extra_details) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM submission_usage WHERE ip_hash=? AND created_at>?)<30 AND (SELECT COUNT(*) FROM submission_usage WHERE ip_hash=? AND created_at>?)<100 AND (SELECT COUNT(*) FROM submission_usage WHERE created_at>=?)<200 AND (SELECT COUNT(*) FROM submission_usage WHERE ip_hash=? AND created_at>? AND reserved_bytes>0)<3 AND (SELECT COUNT(*) FROM submission_usage WHERE ip_hash=? AND created_at>? AND reserved_bytes>0)<10 AND (SELECT COUNT(*) FROM submission_usage WHERE created_at>=? AND reserved_bytes>0)<50 AND (SELECT COALESCE(SUM(reserved_bytes),0) FROM submission_usage WHERE created_at>=?)+?<=? AND (SELECT COALESCE(SUM(reserved_bytes),0) FROM submissions)+?<=?`).bind(id,await sha256(token),metadata.source,metadata.artist,metadata.media_title,metadata.character_name,b.archive_name,b.archive_size,images,reserved,'',time,time+86400,JSON.stringify(optional),ip,time-3600,ip,time-86400,Math.floor(time/86400)*86400,ip,time-3600,ip,time-86400,Math.floor(time/86400)*86400,Math.floor(time/86400)*86400,reserved,20*GiB,reserved,100*GiB),
          env.DB.prepare('INSERT INTO submission_usage(id,ip_hash,reserved_bytes,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM submissions WHERE id=?)').bind(id,ip,reserved,time,id)
        ]);if(!results[0].meta.changes)return json({error:'Upload limit reached. Cancel unfinished uploads to release storage, or retry later if the short-term attempt limit was reached.'},429);
      }catch(e){throw e}
      await cleanupSubmissions(env);
      const upload=await env.PREVIEWS.createMultipartUpload(key(id));
      try{await env.DB.prepare('UPDATE submissions SET upload_id=? WHERE id=?').bind(upload.uploadId,id).run()}catch(e){await upload.abort();await env.DB.prepare('DELETE FROM submissions WHERE id=?').bind(id).run();throw e}
      return json({id,token,part_size:SUBMISSION_PART_SIZE,expires_at:time+86400},201);
    }
    const match=/^\/api\/(admin\/)?submissions\/([a-f0-9-]{36})(?:\/(parts\/\d+|images\/\d+|complete|archive|delete))?$/.exec(path);if(!match)return json({error:'Not found'},404);
    const id=match[2],action=match[3]||'',s=await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(id).first<Session>();if(!s||(!adminPath&&s.expires_at<now()))return json({error:'Submission not found'},404);
    if(adminPath&&request.method==='GET'&&(action==='archive'||/^images\/\d+$/.test(action))){if(action==='archive')return download(request,env,key(id),s.archive_name);const n=Number(action.split('/')[1]),image=await env.DB.prepare('SELECT image_number,content_type FROM submission_images WHERE submission_id=? AND image_number=?').bind(id,n).first<{image_number:number;content_type:string}>();return image?download(request,env,`submissions/${id}/images/${n}`,`image-${n}.${imageExtension(image.content_type)}`,image.content_type):json({error:'Image not found'},404)}
    if(adminPath&&!(action==='delete'&&request.method==='POST'))return json({error:'Method not allowed'},405);
    if(!adminPath&&request.method==='GET')return json({error:'Not found'},404);
    if(!adminPath&&await sha256(request.headers.get('X-Upload-Token')||'')!==s.token_hash)return json({error:'Upload capability required'},401);
    const isDelete=adminPath||request.method==='DELETE'&&!action;
    if(!isDelete&&!((request.method==='PUT'&&/^(parts|images)\/\d+$/.test(action))||(request.method==='POST'&&action==='complete')))return json({error:'Not found'},404);
    if(!isDelete&&s.status!=='OPEN'){if(action==='complete')return json({id,status:s.status,report:s.report?JSON.parse(s.report):null});return json({error:'Upload already finalized'},409)}
    const time=now(),locked=await env.DB.prepare('UPDATE submissions SET lock_until=? WHERE id=? AND lock_until<?').bind(time+1800,id,time).run();if(!locked.meta.changes)return json({error:'Another operation is in progress; retry shortly'},409);
    try{
      if(isDelete){await erase(env,s);return json({deleted:true})}
      if(action.startsWith('parts/')){
        const n=Number(action.split('/')[1]),count=Math.ceil(s.archive_size/SUBMISSION_PART_SIZE);if(!Number.isInteger(n)||n<1||n>count)fail('Invalid part number');const expected=n===count?s.archive_size-(n-1)*SUBMISSION_PART_SIZE:SUBMISSION_PART_SIZE;
        const prior=await env.DB.prepare('SELECT etag FROM submission_parts WHERE submission_id=? AND part_number=?').bind(id,n).first<{etag:string}>();if(prior)return json({etag:prior.etag});
        if(await env.PREVIEWS.head(key(id)))fail('Archive already assembled',409);
        const part=await uploadPartBounded(request,env.PREVIEWS.resumeMultipartUpload(key(id),s.upload_id),n,expected);await env.DB.prepare('INSERT INTO submission_parts VALUES(?,?,?) ON CONFLICT(submission_id,part_number) DO UPDATE SET etag=excluded.etag').bind(id,n,part.etag).run();return json({etag:part.etag});
      }
      if(action.startsWith('images/')){
        const n=Number(action.split('/')[1]);if(!Number.isInteger(n)||n<1||n>s.image_count)fail('Invalid image number');if(await env.DB.prepare('SELECT image_number FROM submission_images WHERE submission_id=? AND image_number=?').bind(id,n).first())return json({uploaded:true});const bytes=await boundedBody(request,MAX_IMAGE),type=imageType(bytes);
        await env.PREVIEWS.put(`submissions/${id}/images/${n}`,bytes,{httpMetadata:{contentType:type}});await env.DB.prepare('INSERT INTO submission_images VALUES(?,?,?,?) ON CONFLICT(submission_id,image_number) DO UPDATE SET content_type=excluded.content_type,size=excluded.size').bind(id,n,type,bytes.length).run();return json({uploaded:true});
      }
      const parts=await env.DB.prepare('SELECT part_number,etag FROM submission_parts WHERE submission_id=? ORDER BY part_number').bind(id).all<{part_number:number;etag:string}>(),images=await env.DB.prepare('SELECT COUNT(*) n FROM submission_images WHERE submission_id=?').bind(id).first<{n:number}>();
      if(parts.results.length!==Math.ceil(s.archive_size/SUBMISSION_PART_SIZE)||parts.results.some((p,i)=>p.part_number!==i+1)||(images?.n||0)!==s.image_count)fail('All declared archive parts and images must upload before completion',409);
      if(!await env.PREVIEWS.head(key(id)))await env.PREVIEWS.resumeMultipartUpload(key(id),s.upload_id).complete(parts.results.map(p=>({partNumber:p.part_number,etag:p.etag})));
      const object=await env.PREVIEWS.head(key(id)),format=s.archive_name.split('.').at(-1)!.toLowerCase();const report=object?.size===s.archive_size?(format==='zip'?await validateSubmissionZip(env.PREVIEWS,key(id),s.archive_size):await validateSubmissionArchive(env.PREVIEWS,key(id),s.archive_size,format as 'rar'|'7z')):{valid:false,summary:'Archive rejected.',error:'Assembled archive size mismatch'};
      const status=report.valid?'READY':'REJECTED';await env.DB.prepare('UPDATE submissions SET status=?,report=?,expires_at=? WHERE id=?').bind(status,JSON.stringify(report),time+(report.valid?30:7)*86400,id).run();return json({id,status,report});
    }finally{await env.DB.prepare('UPDATE submissions SET lock_until=0 WHERE id=?').bind(id).run()}
  }catch(e){if(e instanceof UploadError)return json({error:e.message},e.status);console.error('Submission operation failed',e);return json({error:'Upload operation failed. Retry or cancel the upload.'},503)}
}
