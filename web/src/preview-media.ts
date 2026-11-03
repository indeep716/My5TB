// Animated originals and encrypted previews share one motion preference.
// Posters are decoded before any animated URL reaches a visible image, so
// reduced-motion users never see an initial burst of animation.
interface Preview { url:string; poster:string; animated:boolean; owned:boolean }
const previews=new Map<string,Promise<Preview>>();
const bindings=new Map<HTMLImageElement,{key:string;background?:HTMLElement}>();
const controls=new Set<HTMLButtonElement>();
const preference=matchMedia('(prefers-reduced-motion: reduce)');
let paused=localStorage.getItem('my5tb-preview-paused')==='yes';
let disposed=false;
const stopped=()=>preference.matches;

function revoke(preview:Preview){
  if(preview.owned)URL.revokeObjectURL(preview.url);
  if(preview.poster!==preview.url)URL.revokeObjectURL(preview.poster);
}
async function poster(blob:Blob){
  const bitmap=await createImageBitmap(blob);
  try{
    const canvas=document.createElement('canvas');
    canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d');
    if(!context)throw new Error('Preview unavailable');
    context.drawImage(bitmap,0,0);
    const still=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Preview unavailable')),'image/webp',.85));
    return URL.createObjectURL(still);
  }finally{bitmap.close()}
}
function animated(bytes:Uint8Array){
  const tag=(offset:number,length:number)=>String.fromCharCode(...bytes.subarray(offset,offset+length));
  return tag(0,3)==='GIF'||(tag(0,4)==='RIFF'&&tag(8,4)==='WEBP'&&tag(12,4)==='VP8X'&&!!(bytes[20]&2));
}
function validateOriginalGIF(bytes:Uint8Array){
  const fail=()=>{throw new Error('GIF must be at most 8 MiB, 120 frames and 32 million decoded pixels')};
  if(bytes.length<13||bytes.length>8*1024*1024||String.fromCharCode(...bytes.subarray(0,3))!=='GIF')fail();
  const word=(p:number)=>bytes[p]|bytes[p+1]<<8;
  const width=word(6),height=word(8);
  if(!width||!height||width>8192||height>8192||width*height>32_000_000)fail();
  let offset=13+(bytes[10]&128?3*(2**((bytes[10]&7)+1)):0),count=0;
  const blocks=()=>{while(offset<bytes.length){const size=bytes[offset++];if(!size)return;offset+=size;if(offset>bytes.length)fail()}fail()};
  while(offset<bytes.length){
    const marker=bytes[offset++];
    if(marker===0x3b){if(!count)fail();return}
    if(marker===0x21){offset++;blocks();continue}
    if(marker!==0x2c||offset+9>bytes.length)fail();
    const left=word(offset),top=word(offset+2),w=word(offset+4),h=word(offset+6),flags=bytes[offset+8];
    if(!w||!h||left+w>width||top+h>height||++count>120||count*width*height>32_000_000)fail();
    offset+=9+(flags&128?3*(2**((flags&7)+1)):0);
    offset++;blocks();
  }
  fail();
}
function loopForever(input:Uint8Array){
  const bytes=input.slice(),tag=(p:number,n:number)=>String.fromCharCode(...bytes.subarray(p,p+n));
  if(tag(0,4)==='RIFF'){
    const v=new DataView(bytes.buffer);for(let p=12;p+8<=bytes.length;){const n=v.getUint32(p+4,true);if(p+8+n>bytes.length)break;if(tag(p,4)==='ANIM'&&n>=6)v.setUint16(p+12,0,true);p+=8+n+(n&1)}return bytes;
  }
  if(tag(0,3)!=='GIF')return bytes;
  const start=13+((bytes[10]&128)?3*2**((bytes[10]&7)+1):0);let p=start,found=false;
  const skip=()=>{while(p<bytes.length){const n=bytes[p++];if(!n)return;p+=n}};
  while(p<bytes.length){const type=bytes[p++];if(type===0x3b)break;if(type===0x21){const ext=bytes[p++];if(ext===255&&bytes[p]===11&&['NETSCAPE2.0','ANIMEXTS1.0'].includes(tag(p+1,11))&&bytes[p+12]===3&&bytes[p+13]===1){bytes[p+14]=bytes[p+15]=0;found=true}skip()}else if(type===0x2c){if(p+9>bytes.length)break;const flags=bytes[p+8];p+=9+((flags&128)?3*2**((flags&7)+1):0);p++;skip()}else break}
  if(found)return bytes;
  const extension=new Uint8Array([33,255,11,...new TextEncoder().encode('NETSCAPE2.0'),3,1,0,0,0]),out=new Uint8Array(bytes.length+extension.length);out.set(bytes.subarray(0,start));out.set(extension,start);out.set(bytes.subarray(start),start+extension.length);return out;
}
async function createPreview(blob:Blob,url:string,owned:boolean,isAnimated:boolean):Promise<Preview>{
  let still=url;
  try{
    if(isAnimated)still=await poster(blob);
    const preview={url,poster:still,animated:isAnimated,owned};
    if(disposed){revoke(preview);throw new Error('Preview unavailable')}
    return preview;
  }catch(error){if(owned)URL.revokeObjectURL(url);throw error}
}
function updateControls(){
  const hasAnimation=bindings.size>0;
  for(const button of controls){
    if(!button.isConnected){controls.delete(button);continue}
    button.textContent=preference.matches?'Animation paused':paused?'Play animation':'Pause animation';
    button.setAttribute('aria-label',preference.matches?'Animated images paused by reduced motion preference':paused?'Play animated images':'Pause animated images');
    button.disabled=preference.matches||!hasAnimation;
  }
}
function apply(image:HTMLImageElement,preview:Preview,background?:HTMLElement){
  image.src=preview.animated&&stopped()?preview.poster:preview.url;
  // The blurred fill is always a poster; only the legible foreground animates.
  background?.style.setProperty('--card-bg',`url("${preview.poster}")`);
}
async function refresh(){
  for(const [image,binding] of bindings){
    if(!image.isConnected){unregisterAnimatedImage(image);continue}
    const preview=await previews.get(binding.key)?.catch(()=>null);
    if(preview&&bindings.get(image)===binding)apply(image,preview,binding.background);
  }
  updateControls();
}
export function setupMotionToggle(button:HTMLButtonElement){
  controls.add(button);
  button.classList.add('preview-motion-toggle');
  button.onclick=()=>{paused=!paused;localStorage.setItem('my5tb-preview-paused',paused?'yes':'no');void refresh()};
  updateControls();
}
export async function preparePreview(key:string,plain:ArrayBuffer){
  disposed=false;
  if(!previews.has(key)){
    const bytes=loopForever(new Uint8Array(plain));
    const type=String.fromCharCode(...bytes.subarray(0,3))==='GIF'?'image/gif':'image/webp';
    const blob=new Blob([bytes],{type});
    previews.set(key,createPreview(blob,URL.createObjectURL(blob),true,animated(bytes)));
  }
  try{const preview=await previews.get(key)!;return stopped()?preview.poster:preview.url}
  catch(error){previews.delete(key);throw error}
}
export function cachedPreviewURL(key:string):Promise<string>|undefined{
  return previews.get(key)?.then(preview=>stopped()?preview.poster:preview.url);
}
export async function displayPreview(image:HTMLImageElement,key:string,background?:HTMLElement){
  unregisterAnimatedImage(image);
  const preview=await previews.get(key);
  if(!preview)throw new Error('Preview unavailable');
  if(!image.isConnected)return;
  if(preview.animated){bindings.set(image,{key,background});image.dataset.previewKey=key}
  apply(image,preview,background);updateControls();
}
export function releasePreviewImages(container:ParentNode){
  container.querySelectorAll<HTMLImageElement>('img[data-preview-key]').forEach(unregisterAnimatedImage);
}
/** Use the selected File directly; production CSP intentionally forbids Blob URL fetches. */
export async function registerAnimatedImage(image:HTMLImageElement,url:string,source:Blob){
  disposed=false;
  unregisterAnimatedImage(image);
  const key='original:'+url;
  const binding={key};bindings.set(image,binding);image.dataset.previewKey=key;
  if(!previews.has(key))previews.set(key,Promise.resolve().then(async()=>{
    if(source.size>8*1024**2)throw new Error('GIF exceeds 8 MiB');
    const bytes=new Uint8Array(await source.arrayBuffer());validateOriginalGIF(bytes);
    const blob=new Blob([loopForever(bytes)],{type:'image/gif'});return createPreview(blob,URL.createObjectURL(blob),true,true);
  }));
  try{
    const preview=await previews.get(key)!;
    if(bindings.get(image)===binding)apply(image,preview);
    else if(![...bindings.values()].some(b=>b.key===key)){revoke(preview);previews.delete(key)}
  }catch(error){previews.delete(key);if(bindings.get(image)===binding)unregisterAnimatedImage(image);throw error}
  updateControls();
}
export function unregisterAnimatedImage(image:HTMLImageElement){
  const binding=bindings.get(image);
  bindings.delete(image);delete image.dataset.previewKey;
  if(binding?.key.startsWith('original:')&&![...bindings.values()].some(b=>b.key===binding.key)){
    const pending=previews.get(binding.key);previews.delete(binding.key);
    void pending?.then(revoke,()=>{});
  }
  updateControls();
}
export function clearPreviewURLs(){
  disposed=true;
  for(const pending of previews.values())void pending.then(revoke,()=>{});
  previews.clear();bindings.clear();
}
preference.addEventListener('change',()=>void refresh());
