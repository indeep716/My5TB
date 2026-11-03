import {decompressRawLzma1,decompressRawLzma2} from 'lzma1';

// Only archive metadata is read. File payloads remain private and untrusted.
const MiB=1024**2,GiB=1024**3,MAX_HEADER=2*MiB,MAX_ENTRIES=200;
export interface ArchiveMetadataReport {
  valid:boolean;summary:string;error?:string;entries?:number;expanded_bytes?:number;
  model_files?:string[];formats?:string[];unknown_bytes?:number;
  inspection?:'metadata';model_presence?:'declared';warnings?:string[];
  largest_files?:{name:string;compressed_bytes:number|null;expanded_bytes:number;packed_size_shared?:boolean}[];
}
interface Member {name:string;expanded:number;packed:number|null;directory:boolean}
class ArchiveError extends Error {}
function fail(message:string):never{throw new ArchiveError(message)}
function checked(n:number){if(!Number.isSafeInteger(n)||n<0)fail('Archive number out of range');return n}
function dv(b:Uint8Array){return new DataView(b.buffer,b.byteOffset,b.byteLength)}
function crc32(b:Uint8Array){let c=0xffffffff;for(const n of b){c^=n;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return (c^0xffffffff)>>>0}
class Reader {
  p=0;
  constructor(readonly b:Uint8Array){}
  byte(){if(this.p>=this.b.length)fail('Truncated archive header');return this.b[this.p++]}
  bytes(n:number){checked(n);if(this.p+n>this.b.length)fail('Truncated archive header');const b=this.b.subarray(this.p,this.p+n);this.p+=n;return b}
  u16(){return dv(this.bytes(2)).getUint16(0,true)}
  u32(){return dv(this.bytes(4)).getUint32(0,true)}
  u64(){const n=dv(this.bytes(8)).getBigUint64(0,true);if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('Archive number out of range');return Number(n)}
  vint(max=10){let n=0n;for(let i=0;i<max;i++){const b=this.byte();n|=BigInt(b&127)<<BigInt(i*7);if(!(b&128)){if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('Archive number out of range');return Number(n)}}return fail('Invalid RAR variable integer')}
  n7(){const first=this.byte();let n=0n,mask=128;for(let i=0;i<8;i++){if(!(first&mask)){n|=BigInt(first&(mask-1))<<BigInt(8*i);if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('Archive number out of range');return Number(n)}n|=BigInt(this.byte())<<BigInt(8*i);mask>>=1}if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('Archive number out of range');return Number(n)}
  end(){if(this.p!==this.b.length)fail('Unexpected archive header data')}
}
function decode(b:Uint8Array,encoding='utf-8'){try{return new TextDecoder(encoding,{fatal:true,ignoreBOM:true}).decode(b)}catch{return fail('Archive filename encoding is invalid')}}
const models=new Set(['blend','fbx','glb','gltf','obj','stl','ply','dae','pmx','pmd','3ds','usd','usda','usdc','vrm']);
const companions=new Set(['png','jpg','jpeg','gif','webp','tga','tif','tiff','dds','bmp','exr','hdr','mtl','txt','md','pdf','json','bin','vmd','vpd']);
function ext(name:string){return (name.split('.').at(-1)||'').toLowerCase()}
function memberName(name:string,directory:boolean){
  if(!name||new TextEncoder().encode(name).length>512||name.includes('\\')||name.startsWith('/')||/[:\x00-\x1f\x7f\ufffe\uffff]/.test(name)||name.normalize('NFC')!==name||name.replace(/\/$/,'').split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)))fail('Unsafe archive path');
  if(!directory&&name.endsWith('/'))fail('Inconsistent directory path');return directory?name.replace(/\/$/,'')+'/':name;
}
function ensureSize(expanded:number,packed:number,directory=false){
  if(expanded>10*GiB||expanded>Math.max(1,packed)*100||directory&&(expanded!==0||packed!==0))fail('Archive expansion ratio or expanded member size is unsafe');
}
function makeReport(entries:Member[],format:'RAR'|'7Z',serviceBytes=0):ArchiveMetadataReport {
  if(!entries.length||entries.length>MAX_ENTRIES)fail('Archive entry count exceeds limits');
  let expanded=0,unknown=serviceBytes,modelBytes=0;const names=new Map<string,boolean>();
  for(const e of entries){e.name=memberName(e.name,e.directory);const name=e.name.replace(/\/$/,'').toLowerCase();if(names.has(name))fail('Duplicate archive path');names.set(name,e.directory);expanded+=e.expanded;
    if(e.expanded>10*GiB||expanded>20*GiB)fail('Archive expanded total exceeds limits');
    if(!e.directory){const suffix=ext(e.name);if(/^(exe|dll|com|scr|bat|cmd|ps1|js|vbs|msi|lnk|jar|zip|rar|7z)$/.test(suffix))fail('Executable or nested archive content is unsupported');if(models.has(suffix))modelBytes+=e.expanded;else if(!companions.has(suffix))unknown+=e.expanded}
  }
  for(const name of names.keys()){const parts=name.split('/');parts.pop();while(parts.length){if(names.get(parts.join('/'))===false)fail('Archive file conflicts with directory path');parts.pop()}}
  if(unknown>256*MiB||unknown>Math.max(modelBytes,MiB))fail('Suspicious unrelated archive content');
  const candidates=entries.filter(e=>!e.directory&&models.has(ext(e.name))&&e.expanded>0);if(!candidates.length)fail('No supported model file declared in archive');
  return {valid:true,summary:`${format} metadata inspected; model filenames declared. Manual content review required before publication.`,inspection:'metadata',model_presence:'declared',warnings:['Model contents and file payload integrity are not verified. Files remain in private quarantine for manual content review.',...(entries.some(e=>e.packed===null)?['Solid 7z members share a compressed block; individual compressed sizes are unavailable.']:[])],entries:entries.length,expanded_bytes:expanded,model_files:candidates.map(e=>e.name),formats:[...new Set(candidates.map(e=>ext(e.name).toUpperCase()))],unknown_bytes:unknown,largest_files:entries.filter(e=>!e.directory).sort((a,b)=>b.expanded-a.expanded).slice(0,5).map(e=>({name:e.name,compressed_bytes:e.packed,expanded_bytes:e.expanded,...(e.packed===null?{packed_size_shared:true}:{})}))};
}
function readArchive(bucket:R2Bucket,key:string,size:number){let total=0;return async(offset:number,length:number)=>{
  checked(offset);checked(length);if(!length||length>MAX_HEADER||offset+length>size)fail('Truncated or oversized archive header');total+=length;if(total>MAX_HEADER*3)fail('Archive metadata read budget exceeded');
  const object=await bucket.get(key,{range:{offset,length}});if(!object)fail('Archive missing');const b=new Uint8Array(await object.arrayBuffer());if(b.length!==length)fail('Truncated archive range');return b;
}}
type ReadRange=ReturnType<typeof readArchive>;

// RAR4's optional Unicode suffix uses a small filename-only bytecode, not compression.
function rar4Name(bytes:Uint8Array,unicode:boolean){
  if(!unicode)return decode(bytes).replace(/\\/g,'/');const zero=bytes.indexOf(0);if(zero<0)return decode(bytes).replace(/\\/g,'/');
  const ansi=bytes.subarray(0,zero),r=new Reader(bytes.subarray(zero+1));const high=r.byte(),out:number[]=[];let flags=0,bits=0;
  while(r.p<r.b.length){if(!bits){flags=r.byte();bits=8}const mode=flags>>>6;flags=(flags<<2)&255;bits-=2;
    if(mode===0)out.push(r.byte());else if(mode===1)out.push((high<<8)|r.byte());else if(mode===2)out.push(r.u16());else{let len=r.byte();const correction=len&128?r.byte():0,corrected=!!(len&128);len=(len&127)+2;for(let i=0;i<len;i++){if(out.length>=ansi.length)fail('Invalid RAR Unicode filename');out.push(corrected?((ansi[out.length]+correction)&255)|(high<<8):ansi[out.length])}}
    if(out.length>512)fail('RAR filename exceeds limits');
  }
  const utf16=new Uint8Array(out.length*2);out.forEach((n,i)=>{utf16[i*2]=n&255;utf16[i*2+1]=n>>>8});return decode(utf16,'utf-16le').replace(/\\/g,'/');
}
async function rar4(read:ReadRange,size:number){
  const entries:Member[]=[];let p=7,main=false,end=false,headerBytes=0,serviceBytes=0;
  for(let blocks=0;blocks<405&&!end;blocks++){
    const base=await read(p,7),v=dv(base),type=base[2],flags=v.getUint16(3,true),length=v.getUint16(5,true);
    if(length<7||length>8192||(headerBytes+=length)>MAX_HEADER)fail('RAR header exceeds limits');const h=await read(p,length),r=new Reader(h);r.p=7;
    if((crc32(h.subarray(2))&65535)!==v.getUint16(0,true))fail('RAR header checksum mismatch');let packed=0;
    if(!main&&type!==0x73)fail('RAR main header missing');
    if(type===0x73){if(main||length!==13||flags&(1|2|0x80)||flags&0x8000)fail('Split, encrypted or unsupported RAR main header');r.bytes(6);main=true}
    else if(type===0x74||type===0x7a){
      if(!(flags&0x8000)||flags&(1|2|4|8|0x400|0x800))fail('Encrypted, split or versioned RAR members are unsupported');packed=r.u32();let expanded=r.u32();const host=r.byte();r.u32();r.u32();const version=r.byte(),method=r.byte(),nl=r.u16(),attr=r.u32();
      if(version<15||version>36||method<0x30||method>0x35||host>5||nl<1||nl>1024)fail('Unsupported RAR compression or file header');
      if(flags&0x100){packed=checked(packed+r.u32()*2**32);expanded=checked(expanded+r.u32()*2**32)}
      const name=rar4Name(r.bytes(nl),!!(flags&0x200)),directory=(flags&0xe0)===0xe0;
      if(host===3&&((attr&0xf000)!==0x8000&&(attr&0xf000)!==0x4000)||host!==3&&attr&0x400)fail('RAR links and special files are unsupported');
      if(method===0x30&&packed!==expanded)fail('Stored RAR member size mismatch');ensureSize(expanded,packed,directory);
      if(flags&0x1000){const timeFlags=r.u16();for(let i=0;i<4;i++){const mode=(timeFlags>>>((3-i)*4))&15;if(mode&8){if(i!==0)r.bytes(4);r.bytes(mode&3)}}}
      if(type===0x7a){if(!['CMT','RR','QO'].includes(name))fail('Unsupported RAR service stream');serviceBytes+=expanded;if(serviceBytes>256*MiB)fail('RAR service data exceeds limits')}
      else{entries.push({name,expanded,packed,directory});if(entries.length>MAX_ENTRIES)fail('Archive entry count exceeds limits')}
    }else if(type===0x7b){if(flags&(1|4)||flags&0x8000)fail('Split RAR archives are unsupported');if(flags&2)r.u32();if(flags&8)r.u16();end=true}
    else fail('Unsupported RAR block type');
    r.end();p=checked(p+length+packed);if(p>size)fail('Truncated RAR file data');
  }
  if(!main||!end||p!==size)fail('RAR end header missing or trailing data');return makeReport(entries,'RAR',serviceBytes);
}
function rarExtras(bytes:Uint8Array,file:boolean){const r=new Reader(bytes);while(r.p<bytes.length){const length=r.vint();if(length<1)fail('Invalid RAR extra record');const er=new Reader(r.bytes(length)),type=er.vint();if(file&&(type===1||type===4||type===5||type===7))fail('Encrypted, versioned or linked RAR members are unsupported');if(file&&![2,3,6].includes(type)||!file&&![1,2].includes(type))fail('Unsupported RAR extra record')}}
async function rar5(read:ReadRange,size:number){
  const entries:Member[]=[];let p=8,main=false,end=false,headerBytes=0,serviceBytes=0;
  for(let blocks=0;blocks<405&&!end;blocks++){
    const prefix=await read(p,7),pr=new Reader(prefix);const crc=pr.u32(),length=pr.vint(3),full=pr.p+length;
    if(length<2||full>8192||(headerBytes+=full)>MAX_HEADER)fail('RAR header exceeds limits');const h=await read(p,full);if(crc32(h.subarray(4))!==crc)fail('RAR header checksum mismatch');
    const r=new Reader(h);r.p=pr.p;const type=r.vint(),flags=r.vint(),extra=flags&1?r.vint():0,packed=flags&2?r.vint():0;
    if(flags&~0x67||extra>4096||extra>h.length-r.p)fail('Split or oversized RAR header');
    const extraStart=h.length-extra,body=new Reader(r.bytes(extraStart-r.p));if(!main&&type!==1)fail('RAR main header missing');
    if(type===1){const af=body.vint();if(main||af&~0x1c||packed)fail('Split or unsupported RAR archive');main=true;rarExtras(h.subarray(extraStart),false)}
    else if(type===2||type===3){
      const ff=body.vint(),expanded=body.vint(),attr=body.vint();if(ff&~7)fail('Unknown expanded RAR member size');if(ff&2)body.u32();if(ff&4)body.u32();const compression=body.vint(),host=body.vint(),nl=body.vint();
      if((compression&63)>1||((compression>>>7)&7)>5||compression>0x1fffff||host>1||nl<1||nl>512)fail('Unsupported RAR compression or file header');
      const name=decode(body.bytes(nl)),directory=!!(ff&1);if(host===1&&((attr&0xf000)!==0x8000&&(attr&0xf000)!==0x4000)||host===0&&attr&0x400)fail('RAR links and special files are unsupported');
      ensureSize(expanded,packed,directory);if(((compression>>>7)&7)===0&&packed!==expanded)fail('Stored RAR member size mismatch');rarExtras(h.subarray(extraStart),true);
      if(type===3){if(!['CMT','RR','QO'].includes(name))fail('Unsupported RAR service stream');serviceBytes+=expanded;if(serviceBytes>256*MiB)fail('RAR service data exceeds limits')}
      else{entries.push({name,expanded,packed,directory});if(entries.length>MAX_ENTRIES)fail('Archive entry count exceeds limits')}
    }else if(type===5){if(body.vint()!==0||packed||extra)fail('Split RAR archives are unsupported');end=true}
    else fail(type===4?'Encrypted RAR headers are unsupported':'Unsupported RAR block type');
    body.end();p=checked(p+full+packed);if(p>size)fail('Truncated RAR file data');
  }
  if(!main||!end||p!==size)fail('RAR end header missing or trailing data');return makeReport(entries,'RAR',serviceBytes);
}

interface Coder {method:number;props:Uint8Array}
interface Folder {coders:Coder[];unpack:number;crc?:number;streams:number[];packed:number}
interface Streams {position:number;packSizes:number[];packCrc:(number|undefined)[];folders:Folder[]}
function count7(r:Reader,max=MAX_ENTRIES){const n=r.n7();if(n>max)fail('7z metadata count exceeds limits');return n}
function bits(r:Reader,n:number){const bytes=r.bytes(Math.ceil(n/8));return Array.from({length:n},(_,i)=>!!(bytes[i>>3]&(128>>(i&7))))}
function definitions(r:Reader,n:number){const all=r.byte();if(all>1)fail('Invalid 7z defined flags');return all?new Array<boolean>(n).fill(true):bits(r,n)}
function digests(r:Reader,n:number){return definitions(r,n).map(present=>present?r.u32():undefined)}
function folder(r:Reader):Folder {
  const count=count7(r,4);if(!count)fail('Empty 7z coder graph');const coders:Coder[]=[];
  for(let i=0;i<count;i++){const flag=r.byte(),len=flag&15;if(!len||len>6||flag&0xc0)fail('Unsupported 7z coder');let method=0;for(const b of r.bytes(len))method=method*256+b;
    if(method===0x6f10701)fail('Encrypted 7z members are unsupported');if(flag&16&&(r.n7()!==1||r.n7()!==1))fail('Complex 7z coders are unsupported');
    const props=flag&32?r.bytes(count7(r,64)):new Uint8Array();if(![0,0x30101,0x21,0x40108,0x40202,0x30401,3,0x3030103,0x3030205,0x3030401,0x3030501,0x3030701,0x3030805,0xa,0xb].includes(method))fail('Unsupported 7z compression method');
    if(method===0&&props.length||method===0x30101&&(props.length!==5||props[0]>=225)||method===0x21&&(props.length!==1||props[0]>40))fail('Invalid 7z coder properties');coders.push({method,props});
  }
  const inputs=new Set<number>(),outputs=new Set<number>(),edges=new Map<number,number>();for(let i=0;i<count-1;i++){const input=r.n7(),output=r.n7();if(input>=count||output>=count||inputs.has(input)||outputs.has(output)||input===output)fail('Invalid 7z coder graph');inputs.add(input);outputs.add(output);edges.set(output,input)}
  const final=Array.from({length:count},(_,i)=>i).filter(i=>!outputs.has(i));if(final.length!==1)fail('Invalid 7z coder graph');for(let i=0;i<count;i++){let n=i;const seen=new Set<number>();while(edges.has(n)){if(seen.has(n))fail('Cyclic 7z coder graph');seen.add(n);n=edges.get(n)!}if(n!==final[0])fail('Disconnected 7z coder graph')}
  // Preserve final output index until unpack sizes have been read.
  return {coders,unpack:final[0],streams:[],packed:0};
}
function streams(r:Reader):Streams {
  const result:Streams={position:0,packSizes:[],packCrc:[],folders:[]};let tag=r.byte();
  if(tag===6){result.position=r.n7();const n=count7(r);if(!n||r.byte()!==9)fail('Missing 7z packed sizes');for(let i=0;i<n;i++)result.packSizes.push(r.n7());tag=r.byte();if(tag===10){result.packCrc=digests(r,n);tag=r.byte()}if(tag!==0)fail('Invalid 7z pack header');tag=r.byte()}
  if(tag===7){if(r.byte()!==11)fail('Missing 7z folder header');const n=count7(r);if(!n||r.byte()!==0)fail('External 7z folder metadata is unsupported');for(let i=0;i<n;i++)result.folders.push(folder(r));if(r.byte()!==12)fail('Missing 7z expanded sizes');
    for(const f of result.folders){const final=f.unpack,sizes=f.coders.map(()=>r.n7());if(sizes.some(n=>n>20*GiB))fail('7z expanded stream exceeds limits');f.unpack=sizes[final]}
    tag=r.byte();if(tag===10){const crc=digests(r,n);result.folders.forEach((f,i)=>f.crc=crc[i]);tag=r.byte()}if(tag!==0)fail('Invalid 7z unpack header');tag=r.byte();
  }
  if(result.folders.length!==result.packSizes.length)fail('Inconsistent 7z packed stream count');result.folders.forEach((f,i)=>{f.packed=result.packSizes[i];if(f.unpack>20*GiB||f.unpack>Math.max(1,f.packed)*100)fail('7z expansion ratio or stream size is unsafe')});
  const nums=new Array<number>(result.folders.length).fill(1);
  if(tag===8){tag=r.byte();if(tag===13){let total=0;for(let i=0;i<nums.length;i++){nums[i]=count7(r);total+=nums[i];if(total>MAX_ENTRIES)fail('7z stream count exceeds limits')}tag=r.byte()}
    if(tag===9){for(let i=0;i<nums.length;i++){const f=result.folders[i];let total=0;for(let j=0;j<nums[i]-1;j++){const n=r.n7();f.streams.push(n);total=checked(total+n)}if(nums[i]){if(total>f.unpack)fail('Invalid 7z substream sizes');f.streams.push(f.unpack-total)}}tag=r.byte()}
    else for(let i=0;i<nums.length;i++)if(nums[i]===1)result.folders[i].streams=[result.folders[i].unpack];else if(nums[i]>1)fail('Missing 7z substream sizes');
    if(tag===10){let n=0;nums.forEach((num,i)=>{if(!(num===1&&result.folders[i].crc!==undefined))n+=num});digests(r,n);tag=r.byte()}if(tag!==0)fail('Invalid 7z substream header');tag=r.byte();
  }else for(const f of result.folders)f.streams=[f.unpack];
  if(tag!==0)fail('Unsupported 7z stream metadata');for(const f of result.folders)if(!f.streams.length&&(f.unpack||f.packed))fail('7z contains hidden file streams');return result;
}
function files(r:Reader,s:Streams){
  const n=count7(r);if(!n)fail('Empty 7z archive');let names:string[]|undefined,empty=new Array<boolean>(n).fill(false),emptyFile:boolean[]=[],anti:boolean[]=[],attrs:(number|undefined)[]=new Array(n),hadEmpty=false;const seen=new Set<number>();
  for(;;){const tag=r.byte();if(tag===0)break;if(seen.has(tag))fail('Duplicate 7z file property');seen.add(tag);const prop=new Reader(r.bytes(count7(r,MAX_HEADER)));
    if(tag===17){if(prop.byte()!==0)fail('External 7z filenames are unsupported');const text=decode(prop.bytes(prop.b.length-prop.p),'utf-16le');if(!text.endsWith('\0'))fail('Unterminated 7z filename');names=text.slice(0,-1).split('\0');if(names.length!==n)fail('Inconsistent 7z filename count')}
    else if(tag===14){empty=bits(prop,n);hadEmpty=true}
    else if(tag===15||tag===16){if(!hadEmpty)fail('7z empty file flags lack stream flags');const value=bits(prop,empty.filter(Boolean).length);if(tag===15)emptyFile=value;else anti=value}
    else if(tag===21||tag>=18&&tag<=20){const defined=definitions(prop,n);if(prop.byte()!==0)fail('External 7z attributes are unsupported');defined.forEach((present,i)=>{if(present){if(tag===21)attrs[i]=prop.u32();else prop.bytes(8)}})}
    else if(tag===25){if(prop.bytes(prop.b.length).some(n=>n!==0))fail('Invalid 7z padding')}
    else fail('Unsupported 7z file property');prop.end();
  }
  if(!names)fail('7z filenames missing');const members:Member[]=[],data=s.folders.flatMap(f=>f.streams.map(expanded=>({expanded,packed:f.streams.length===1?f.packed:null})));let at=0,emptyAt=0;
  for(let i=0;i<n;i++){const directory=empty[i]&&!emptyFile[emptyAt];if(empty[i]&&anti[emptyAt++])fail('7z anti-files are unsupported');const a=attrs[i];if(a!==undefined){const mode=a>>>16;if(a&0x400||(mode&0xf000)!==0&&(mode&0xf000)!==0x8000&&(mode&0xf000)!==0x4000)fail('7z links and special files are unsupported');if(mode&&(mode&0xf000)===0x4000&&!directory)fail('Inconsistent 7z directory attributes')}
    if(empty[i])members.push({name:names[i],directory,expanded:0,packed:0});else{const stream=data[at++];if(!stream)fail('7z file stream missing');members.push({name:names[i],directory:false,...stream})}
  }
  if(at!==data.length)fail('7z contains hidden file streams');return members;
}
// Raw LZMA2 has no decoder output cap. Preflight every chunk's sizes before invoking it.
function lzma2Bounded(input:Uint8Array,expected:number){const r=new Reader(input);let total=0,chunks=0;
  for(;;){if(++chunks>32768)fail('Excessive encoded 7z header chunks');const c=r.byte();if(c===0){r.end();if(total!==expected)fail('Encoded 7z header size mismatch');return}let output:number,packed:number;
    if(c===1||c===2){output=(r.byte()<<8|r.byte())+1;packed=output}
    else if(c>=128){output=((c&31)<<16|(r.byte()<<8)|r.byte())+1;packed=(r.byte()<<8|r.byte())+1;if(c>=192)r.byte()}
    else fail('Invalid encoded 7z LZMA2 control');total+=output;if(total>expected||total>MAX_HEADER)fail('Encoded 7z header output exceeds limits');r.bytes(packed);
  }
}
function decodeHeader(run:()=>Uint8Array){try{return run()}catch(e){return fail(`Invalid encoded 7z header: ${e instanceof Error?e.message:'decode failed'}`)}}
async function seven(read:ReadRange,size:number){
  const start=await read(0,32),r=new Reader(start);if(r.bytes(6).some((b,i)=>b!==[0x37,0x7a,0xbc,0xaf,0x27,0x1c][i])||r.byte()!==0||r.byte()>4)fail('Invalid or unsupported 7z signature');const startCrc=r.u32(),offset=r.u64(),length=r.u64(),nextCrc=r.u32();
  if(crc32(start.subarray(12))!==startCrc||length<1||length>MAX_HEADER||32+offset+length!==size)fail('Invalid 7z start header checksum or bounds');const next=await read(32+offset,length);if(crc32(next)!==nextCrc)fail('7z next header checksum mismatch');let header:Uint8Array=next,encodedStart=32+offset;
  if(next[0]===23){const er=new Reader(next);er.byte();const s=streams(er);er.end();if(s.folders.length!==1||s.folders[0].coders.length!==1||s.folders[0].streams.length!==1)fail('Unsupported encoded 7z header graph');const f=s.folders[0],coder=f.coders[0],packed=s.packSizes[0];encodedStart=checked(32+s.position);
    if(f.unpack<1||f.unpack>MAX_HEADER||packed<1||packed>MAX_HEADER||encodedStart+packed!==32+offset)fail('Encoded 7z header exceeds limits or overlaps data');const bytes=await read(encodedStart,packed);if(s.packCrc[0]!==undefined&&crc32(bytes)!==s.packCrc[0])fail('Encoded 7z packed header checksum mismatch');
    if(coder.method===0){if(packed!==f.unpack)fail('Stored 7z header size mismatch');header=bytes}
    else if(coder.method===0x30101){const properties=coder.props[0],dict=dv(coder.props).getUint32(1,true);if(dict>16*MiB)fail('Encoded 7z header dictionary exceeds 16 MiB');const lc=properties%9,rest=Math.floor(properties/9),lp=rest%5,pb=Math.floor(rest/5);if(lc+lp>4)fail('Encoded 7z header literal context exceeds limits');header=decodeHeader(()=>decompressRawLzma1(bytes,{dictSize:Math.max(4096,dict),lc,lp,pb,uncompressedSize:f.unpack,maxOutputLength:MAX_HEADER,memoryLimitKb:17408}))}
    else if(coder.method===0x21){const prop=coder.props[0],dict=prop===40?0xffffffff:(2|(prop&1))*2**((prop>>>1)+11);if(dict>16*MiB)fail('Encoded 7z header dictionary exceeds 16 MiB');lzma2Bounded(bytes,f.unpack);header=decodeHeader(()=>decompressRawLzma2(bytes,{dictSize:dict,memoryLimitKb:17408}))}
    else fail('Encoded 7z headers require Copy, LZMA1 or LZMA2');
    if(header.length!==f.unpack||f.crc!==undefined&&crc32(header)!==f.crc)fail('Decoded 7z header checksum or size mismatch');
  }
  const hr=new Reader(header);if(hr.byte()!==1)fail('7z header missing');let tag=hr.byte();if(tag===2){for(;;){const t=hr.byte();if(!t)break;hr.bytes(count7(hr,4096))}tag=hr.byte()}
  if(tag!==4)fail('7z main file streams missing');const s=streams(hr);tag=hr.byte();if(tag!==5)fail('7z file metadata missing');const entries=files(hr,s);if(hr.byte()!==0)fail('Unsupported 7z header section');hr.end();
  const packTotal=s.packSizes.reduce((a,b)=>checked(a+b),0);if(s.position!==0||32+packTotal!==encodedStart)fail('7z packed data overlaps metadata or contains hidden gaps');return makeReport(entries,'7Z');
}

export async function validateSubmissionArchive(bucket:R2Bucket,key:string,size:number,format:'rar'|'7z'):Promise<ArchiveMetadataReport>{
  try{if(!Number.isSafeInteger(size)||size<22||size>5*GiB)fail('Archive size is outside limits');const read=readArchive(bucket,key,size);if(format==='7z')return await seven(read,size);
    const magic=await read(0,7);if(magic.subarray(0,6).some((b,i)=>b!==[0x52,0x61,0x72,0x21,0x1a,0x07][i]))fail('Invalid RAR signature');if(magic[6]===0)return await rar4(read,size);if(magic[6]===1){if((await read(7,1))[0]!==0)fail('Invalid RAR5 signature');return await rar5(read,size)}return fail('Unsupported RAR signature');
  }catch(e){if(!(e instanceof ArchiveError))throw e;return {valid:false,summary:'Archive rejected.',error:e.message}}
}
