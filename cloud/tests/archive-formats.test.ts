import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {compress} from 'lzma1';
import {validateSubmissionArchive} from '../src/archive-formats';

const GiB=1024**3;
function crc(b:Uint8Array){let c=0xffffffff;for(const n of b){c^=n;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return (c^0xffffffff)>>>0}
function n7(n:number):Buffer{for(let i=0;i<8;i++)if(n<2**(7+7*i)){const b=Buffer.alloc(i+1);b[0]=((0xff<<(8-i))&255)|Math.floor(n/2**(8*i));for(let j=0;j<i;j++)b[j+1]=Math.floor(n/2**(8*j))&255;return b}const b=Buffer.alloc(9,255);b.writeBigUInt64LE(BigInt(n),1);return b}
function vint(n:number){const a=[];do{const b=n%128;n=Math.floor(n/128);a.push(b|(n?128:0))}while(n);return Buffer.from(a)}
function block5(type:number,flags:number,body:Buffer){const b=Buffer.concat([vint(type),vint(flags),body]),h=Buffer.concat([vint(b.length),b]),c=Buffer.alloc(4);c.writeUInt32LE(crc(h));return Buffer.concat([c,h])}
function rar5(name='model.obj',expanded=32,packed=expanded,extra=Buffer.alloc(0),flags=0){const bytes=Buffer.alloc(packed,65),nb=Buffer.from(name),f=Buffer.concat([...(extra.length?[vint(extra.length)]:[]),vint(packed),vint(flags),vint(expanded),vint(0x81a4),vint(packed===expanded?0:128),vint(1),vint(nb.length),nb,extra]);return Buffer.concat([Buffer.from('526172211a070100','hex'),block5(1,0,vint(0)),block5(2,2|(extra.length?1:0),f),bytes,block5(5,0,vint(0))])}
function block4(type:number,flags:number,body:Buffer){const h=Buffer.alloc(7);h[2]=type;h.writeUInt16LE(flags,3);h.writeUInt16LE(7+body.length,5);const all=Buffer.concat([h,body]);all.writeUInt16LE(crc(all.subarray(2))&65535);return all}
function rar4(name='model.obj',flags=0){const nb=Buffer.from(name),data=Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\n'),h=Buffer.alloc(25);h.writeUInt32LE(data.length);h.writeUInt32LE(data.length,4);h[8]=3;h.writeUInt32LE(crc(data),9);h[17]=29;h[18]=0x30;h.writeUInt16LE(nb.length,19);h.writeUInt32LE(0x81a4,21);return Buffer.concat([Buffer.from('526172211a0700','hex'),block4(0x73,0,Buffer.alloc(6)),block4(0x74,0x8000|flags,Buffer.concat([h,nb])),data,block4(0x7b,0,Buffer.alloc(0))])}
function seven(name='model.obj',encoding:'plain'|'lzma1'|'lzma2'='plain',expanded=32,packed=expanded,dict=1<<20){
  const nb=Buffer.from(name+'\0','utf16le');
  const header=Buffer.concat([Buffer.from([1,4,6,0,1,9]),n7(packed),Buffer.from([0,7,11,1,0,1,1,0,12]),n7(expanded),Buffer.from([0,0,5,1,17]),n7(nb.length+1),Buffer.from([0]),nb,Buffer.from([0,0])]);
  let next=header,encoded=Buffer.alloc(0);
  if(encoding!=='plain'){
    let coder:Buffer;if(encoding==='lzma1'){const l=Buffer.from(compress(header,{level:1,dictSize:dict,endMarker:false}));encoded=l.subarray(13);coder=Buffer.concat([Buffer.from([0x23,3,1,1,5]),l.subarray(0,5)])}
    else{encoded=Buffer.concat([Buffer.from([1,(header.length-1)>>8,(header.length-1)&255]),header,Buffer.from([0])]);coder=Buffer.from([0x21,0x21,1,16])}
    next=Buffer.concat([Buffer.from([23,6]),n7(packed),Buffer.from([1,9]),n7(encoded.length),Buffer.from([0,7,11,1,0,1]),coder,Buffer.from([12]),n7(header.length),Buffer.from([10,1]),u32(crc(header)),Buffer.from([0,0])]);
  }
  const start=Buffer.alloc(32);Buffer.from('377abcaf271c','hex').copy(start);start[7]=4;start.writeBigUInt64LE(BigInt(packed+encoded.length),12);start.writeBigUInt64LE(BigInt(next.length),20);start.writeUInt32LE(crc(next),28);start.writeUInt32LE(crc(start.subarray(12)),8);
  return Buffer.concat([start,Buffer.alloc(packed,65),encoded,next]);
}
function u32(n:number){const b=Buffer.alloc(4);b.writeUInt32LE(n);return b}
function bucket(bytes:Buffer){const reads:{offset:number;length:number}[]=[];return {reads,get:async(_key:string,o:any)=>{expect(o?.range).toBeDefined();const {offset,length}=o.range;expect(length).toBeLessThanOrEqual(2*1024**2);reads.push({offset,length});return {arrayBuffer:async()=>bytes.subarray(offset,offset+length)}}} as any}
async function inspect(b:Buffer,f:'rar'|'7z'){return validateSubmissionArchive(bucket(b),'private',b.length,f)}
function editNext(b:Buffer,edit:(next:Buffer)=>Buffer){const start=Buffer.from(b.subarray(0,32)),at=32+Number(start.readBigUInt64LE(12)),next=edit(Buffer.from(b.subarray(at)));start.writeBigUInt64LE(BigInt(next.length),20);start.writeUInt32LE(crc(next),28);start.writeUInt32LE(crc(start.subarray(12)),8);return Buffer.concat([start,b.subarray(32,at),next])}

describe('bounded RAR and 7z quarantine inspection',()=>{
  it('admits RAR4/RAR5 and plain or encoded 7z with declared model metadata and explicit manual review',async()=>{
    for(const [b,f] of [[rar4(),'rar'],[rar5(),'rar'],[seven(),'7z'],[seven('model.obj','lzma1'),'7z'],[seven('model.obj','lzma2'),'7z']] as const){const report=await inspect(b,f);expect(report.valid,JSON.stringify(report)).toBe(true);expect(report.inspection).toBe('metadata');expect(report.model_files).toEqual(['model.obj']);expect(report.summary).toMatch(/manual content review/i);expect(report.warnings?.join(' ')).toMatch(/not verified/i)}
  });
  it('rejects traversal, executable, nested archive and missing model declarations',async()=>{
    for(const name of ['../model.obj','/model.obj','C:/model.obj','folder/../model.obj','run.exe','nested.zip','readme.txt','file.obj.','file\u0000.obj'])for(const [b,f] of [[rar4(name),'rar'],[rar5(name),'rar'],[seven(name),'7z']] as const)expect((await inspect(b,f)).valid,name).toBe(false);
  });
  it('rejects encrypted, split, link and unknown expanded RAR metadata',async()=>{
    for(const b of [rar4('model.obj',1),rar4('model.obj',4),rar5('model.obj',32,32,Buffer.from([1,1])),rar5('model.obj',32,32,Buffer.from([1,5])),rar5('model.obj',32,32,Buffer.alloc(0),8)])expect((await inspect(b,'rar')).valid).toBe(false);
  });
  it('rejects expansion bombs, truncated archives, checksum failures and trailing data',async()=>{
    for(const [b,f] of [[seven('model.obj','plain',10000,1),'7z'],[rar5('model.obj',10000,1),'rar'],[seven().subarray(0,-1),'7z'],[rar4().subarray(0,-1),'rar'],[rar5().subarray(0,-1),'rar'],[Buffer.concat([seven(),Buffer.from([0])]),'7z'],[Buffer.concat([rar5(),Buffer.from([0])]),'rar']] as const)expect((await inspect(b,f)).valid).toBe(false);
    const bad=seven();bad[8]^=1;expect((await inspect(bad,'7z')).valid).toBe(false);
  });
  it('caps encoded header dictionaries and LZMA2 output before decoding',async()=>{
    const lzma1=editNext(seven('model.obj','lzma1'),next=>{const at=next.indexOf(Buffer.from([0x23,3,1,1,5]));next.writeUInt32LE(32*1024**2,at+6);return next});expect((await inspect(lzma1,'7z')).error).toMatch(/dictionary/);
    const lzma2=editNext(seven('model.obj','lzma2'),next=>{const at=next.indexOf(Buffer.from([0x21,0x21,1]));next[at+3]=40;return next});expect((await inspect(lzma2,'7z')).error).toMatch(/dictionary/);
    const output=seven('model.obj','lzma2');output[65]=255;output[66]=255;expect((await inspect(output,'7z')).error).toMatch(/output exceeds/);
  });
  it('rejects encrypted 7z coder metadata and bounds claimed entry counts',async()=>{
    const encrypted=editNext(seven(),h=>Buffer.concat([h.subarray(0,13),Buffer.from([4,6,0xf1,7,1]),h.subarray(15)]));expect((await inspect(encrypted,'7z')).error).toMatch(/Encrypted/);
    const count=editNext(seven(),h=>{const at=h.indexOf(Buffer.from([5,1,17]));return Buffer.concat([h.subarray(0,at+1),n7(201),h.subarray(at+2)])});expect((await inspect(count,'7z')).error).toMatch(/count exceeds/);
  });
  it('propagates storage failures so completion can retry instead of rejecting a valid archive',async()=>{
    const broken={get:async()=>{throw new Error('R2 temporarily unavailable')}} as any;await expect(validateSubmissionArchive(broken,'private',100,'7z')).rejects.toThrow(/temporarily unavailable/);
  });
  it('parses real upstream compressed RAR4/RAR5 and LZMA1/LZMA2 7z fixtures without mistaking non-model content for a model',async()=>{
    for(const [file,format] of [['test_read_format_rar5_compressed.rar','rar'],['test_read_format_7zip_lzma1.7z','7z'],['test_read_format_7zip_lzma2.7z','7z']] as const){const r=await inspect(readFileSync(`cloud/tests/fixtures/archives/${file}`),format);expect(r.valid,file).toBe(false);expect(r.error,file).toMatch(/No supported model/)}
    expect((await inspect(readFileSync('cloud/tests/fixtures/archives/test_read_format_rar_compress_normal.rar'),'rar')).error).toMatch(/links/);
  });
  it('admits real compressed RAR members as declarations and py7zr solid archives with compressed headers',async()=>{
    for(const [file,format] of [['declared-model-compressed-rar4.rar','rar'],['declared-model-compressed-rar5.rar','rar'],['model-lzma1-solid.7z','7z'],['model-lzma2-solid.7z','7z']] as const){const b=readFileSync(`cloud/tests/fixtures/archives/${file}`),r=await inspect(b,format);expect(r.valid,`${file}: ${JSON.stringify(r)}`).toBe(true);expect(r.inspection).toBe('metadata');if(format==='7z')expect(r.largest_files?.[0]).toMatchObject({name:'model.obj',compressed_bytes:null,packed_size_shared:true})}
  });
  it('handles sparse 5 GiB 7z data using only header ranges',async()=>{
    const small=seven(),h=small.subarray(64),packed=5*GiB-32-h.length,start=Buffer.from(small.subarray(0,32));
    // Build the actual header with wide packed+expanded sizes without allocating its payload.
    const nb=Buffer.from('model.obj\0','utf16le'),next=Buffer.concat([Buffer.from([1,4,6,0,1,9]),n7(packed),Buffer.from([0,7,11,1,0,1,1,0,12]),n7(packed),Buffer.from([0,0,5,1,17]),n7(nb.length+1),Buffer.from([0]),nb,Buffer.from([0,0])]);
    const size=5*GiB,pack=size-32-next.length;const final=Buffer.from(next);n7(pack).copy(final,6);const expandedAt=6+n7(pack).length+9;n7(pack).copy(final,expandedAt);start.writeBigUInt64LE(BigInt(pack),12);start.writeBigUInt64LE(BigInt(final.length),20);start.writeUInt32LE(crc(final),28);start.writeUInt32LE(crc(start.subarray(12)),8);
    const reads:any[]=[];const sparse={get:async(_k:string,o:any)=>{reads.push(o.range);const {offset,length}=o.range;const segment=offset===0?start:offset===size-final.length?final:undefined;if(!segment||length!==segment.length)throw new Error('Unexpected payload read');return {arrayBuffer:async()=>segment}}} as any;
    const result=await validateSubmissionArchive(sparse,'private',size,'7z');expect(result.valid,JSON.stringify(result)).toBe(true);expect(reads).toHaveLength(2);expect(result.expanded_bytes).toBe(pack);
  });
  it('handles sparse 5 GiB RAR4 large-file and RAR5 variable-size data without reading the payload',async()=>{
    const size=5*GiB,name=Buffer.from('model.obj');
    const magic4=Buffer.from('526172211a0700','hex'),main4=block4(0x73,0,Buffer.alloc(6)),end4=block4(0x7b,0,Buffer.alloc(0)),body4=Buffer.alloc(33),packed4=size-7-main4.length-7-body4.length-name.length-end4.length;
    body4.writeUInt32LE(packed4%2**32);body4.writeUInt32LE(packed4%2**32,4);body4[8]=3;body4[17]=29;body4[18]=0x30;body4.writeUInt16LE(name.length,19);body4.writeUInt32LE(0x81a4,21);body4.writeUInt32LE(Math.floor(packed4/2**32),25);body4.writeUInt32LE(Math.floor(packed4/2**32),29);
    const file4=block4(0x74,0x8100,Buffer.concat([body4,name]));
    const magic5=Buffer.from('526172211a070100','hex'),main5=block5(1,0,vint(0)),end5=block5(5,0,vint(0));let packed5=size,file5=Buffer.alloc(0);
    for(let i=0;i<3;i++){file5=block5(2,2,Buffer.concat([vint(packed5),vint(0),vint(packed5),vint(0x81a4),vint(0),vint(1),vint(name.length),name]));packed5=size-magic5.length-main5.length-file5.length-end5.length}
    for(const [magic,main,file,end,packed] of [[magic4,main4,file4,end4,packed4],[magic5,main5,file5,end5,packed5]] as const){const prefix=Buffer.concat([magic,main,file]),reads:any[]=[];const sparse={get:async(_k:string,o:any)=>{const {offset,length}=o.range;reads.push(o.range);const from=offset+length<=prefix.length?prefix.subarray(offset,offset+length):offset>=size-end.length?end.subarray(offset-size+end.length,offset-size+end.length+length):undefined;if(!from||from.length!==length)throw new Error('Unexpected RAR payload read');return {arrayBuffer:async()=>from}}} as any;const r=await validateSubmissionArchive(sparse,'private',size,'rar');expect(r.valid,JSON.stringify(r)).toBe(true);expect(r.expanded_bytes).toBe(packed);expect(reads.reduce((a,r)=>a+r.length,0)).toBeLessThan(200)}
  });
  it('supports UTF-8 RAR5 and the RAR4 Unicode filename encoding with safe normalized names',async()=>{
    const name='ตัวละคร.obj',plain=rar4(),p=20,oldLength=plain.readUInt16LE(p+5),oldNameLength=plain.readUInt16LE(p+26),utf16=Buffer.from(name,'utf16le'),encoded:number[]=[0];for(let i=0;i<utf16.length;i+=8){encoded.push(0xaa);encoded.push(...utf16.subarray(i,i+8))}const nb=Buffer.concat([Buffer.from('model.obj\0'),Buffer.from(encoded)]),body=Buffer.concat([plain.subarray(p+7,p+32),nb]);body.writeUInt16LE(nb.length,19);const h=block4(0x74,0x8200,body),unicode=Buffer.concat([plain.subarray(0,p),h,plain.subarray(p+oldLength)]);void oldNameLength;
    for(const b of [unicode,rar5(name)])expect((await inspect(b,'rar')).model_files).toEqual([name]);
  });
});
