import {reveal} from './motion';
import './community.css';
import {registerAnimatedImage,unregisterAnimatedImage} from './preview-media';

const GiB=1024**3,MiB=1024**2;
const MAX_ARCHIVE=5*GiB,MAX_IMAGES=8,MAX_IMAGE=8*MiB;
const fields=[['source','Source','artist_category'],['artist','Artist / studio','artist_name'],['media_title','Game / world / series','media_title'],['character_name','Character name','character_name']] as const;
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const size=(n:number)=>n>=GiB?(n/GiB).toFixed(2)+' GiB':(n/MiB).toFixed(1)+' MiB';
async function jsonRequest(path:string,init:RequestInit={}){
  const r=await fetch(path,{...init,signal:init.signal??AbortSignal.timeout(45000)});
  let data:any;try{data=await r.json()}catch{throw new Error('The server could not respond. Please try again.')}
  if(!r.ok)throw new Error(data.error||`Request failed (${r.status}).`);return data;
}
export function setupCommunity(){
  const active=['/contribute','/contribute/','/about','/about/'].includes(location.pathname);
  const page=location.pathname.startsWith('/contribute')?'contribute':'about';
  const links=`<a href="/contribute"${active&&page==='contribute'?' aria-current="page"':''}>Contribute</a><a href="/about"${active&&page==='about'?' aria-current="page"':''}>About & contact</a>`;
  document.querySelector('.type-nav')?.insertAdjacentHTML('beforeend',`<span class="nav-community-divider" aria-hidden="true"></span>${links.replaceAll('<a ', '<a class="community-nav-link" ')}`);
  document.querySelector('.mobile-type-nav')?.insertAdjacentHTML('afterend',`<nav class="mobile-utility-nav" aria-label="Community">${links}</nav>`);
  document.querySelector('footer')?.insertAdjacentHTML('beforeend',`<nav class="footer-utility-nav" aria-label="Footer community">${links}</nav>`);
  document.querySelector('.hero')?.insertAdjacentHTML('beforeend','<div class="hero-character"><img src="/images/hero-character.png" width="1024" height="1024" alt="" fetchpriority="high"></div>');
  if(!active)return {active};
  document.querySelectorAll<HTMLElement>('.hero,.collection').forEach(e=>e.hidden=true);
  document.querySelectorAll('[data-category]').forEach(link=>{link.removeAttribute('aria-current');link.classList.remove('nav-active');link.addEventListener('click',e=>{e.preventDefault();e.stopImmediatePropagation();location.assign('/Characters?asset_category=Characters#search')},{capture:true})});
  const section=document.createElement('section');section.className='community-page';section.setAttribute('aria-labelledby','community-title');
  document.querySelector('main')!.append(section);
  document.querySelector('.skip')?.setAttribute('href','#community-title');
  if(page==='about'){
    document.title='About & contact — My5TB';
    section.innerHTML=`<div class="community-intro"><span class="technical">MY5TB / CONTACT</span><h1 id="community-title" tabindex="-1">A personal archive.<br>A place to create.</h1><p>My5TB is a personal collection of 3D characters and creative resources, organized to make browsing and finding original files easier.</p></div><div class="contact-panel"><span class="technical">GET IN TOUCH</span><h2>Questions, feedback, or a bug?</h2><p>Tell us what happened, which page you were using, and how we can reproduce it.</p><a class="contact-email" href="mailto:indeep716@gmail.com">indeep716@gmail.com <span aria-hidden="true">↗</span></a></div>`;
  }else{
    document.title='Contribute - My5TB';
    section.innerHTML=`<div class="community-intro"><span class="technical">MY5TB / CONTRIBUTE</span><h1 id="community-title" tabindex="-1">Share a resource.</h1><p>Send a resource for a personal review. Submissions stay private and never appear in the collection automatically.</p></div><form id="contribution-form" class="contribution-form" novalidate><div class="form-heading"><h2>Resource submission</h2></div><label class="submission-category"><span class="technical">CATEGORY</span><select id="submission-category" aria-label="Submission category"><option value="Characters">Characters</option></select></label><p class="form-note">All four details are required. Choose a suggestion or enter a new name.</p><div class="contribution-fields">${fields.map(([name,label])=>`<label for="submission-${name}"><span class="technical">${label}<span class="required-dot" aria-hidden="true"> ●</span></span><input id="submission-${name}" name="${name}" list="submission-${name}-options" required maxlength="200" autocomplete="off" placeholder="Choose or type a name"><datalist id="submission-${name}-options"></datalist></label>`).join('')}</div><div class="contribution-fields optional-fields"><label for="submission-upload-by"><span class="technical">Upload by · optional</span><input id="submission-upload-by" maxlength="200" autocomplete="off"></label><label for="submission-link"><span class="technical">Link · optional</span><input id="submission-link" type="url" maxlength="2000" placeholder="https://"></label><label class="submission-description" for="submission-description"><span class="technical">Description · optional</span><textarea id="submission-description" maxlength="10000" rows="4"></textarea></label></div><p class="form-note">Submit one character per archive. If you have two characters, please send two separate archives. This is guidance only; submissions are reviewed manually.</p><div class="upload-group"><label class="technical" for="submission-archive">ARCHIVE <span class="required-dot" aria-hidden="true">●</span></label><label id="archive-drop" class="upload-drop" for="submission-archive"><span class="material-symbols-outlined" aria-hidden="true">upload_file</span><strong>Drop an archive here</strong><span>or choose one file · ZIP, RAR, 7z · up to 5 GiB</span><input id="submission-archive" type="file" accept=".zip,.rar,.7z,application/zip,application/vnd.rar,application/x-rar-compressed,application/x-7z-compressed" aria-describedby="archive-help"></label><p id="archive-help" class="form-note">Include actual 3D model files. Encrypted archives, unsafe paths, excessive expansion and unrelated bulk files are rejected. RAR/7z model names are inspected; the owner must review actual contents before publication.</p><div id="archive-selection" class="upload-selection"></div></div><div class="upload-group"><label class="technical" for="submission-images">REFERENCE IMAGES · OPTIONAL</label><label id="images-drop" class="upload-drop image-drop" for="submission-images"><span class="material-symbols-outlined" aria-hidden="true">add_photo_alternate</span><strong>Drop images here or choose files</strong><span>Up to 8 images · PNG, JPEG, WebP, GIF · 8 MiB each</span><input id="submission-images" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple></label><div id="image-selection" class="submission-images"></div></div><div class="submission-actions"><button id="submit-contribution" class="button primary" type="submit">Send for review <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span></button><button id="cancel-contribution" class="button" type="button" hidden>Cancel upload</button></div><div class="submission-feedback"><p id="submission-status" role="status" aria-live="polite">Your files will be reviewed before any publication.</p><progress id="submission-progress" max="100" value="0" aria-label="Submission progress" hidden></progress><pre id="submission-report" hidden></pre></div><p class="form-note">Only submit files you have permission to share. Files are kept privately for up to 30 days for review. The owner downloads and checks each submission separately.</p></form>`;
    setupSubmission(section);
  }
  reveal(section);return {active};
}

function setupSubmission(section:HTMLElement){
  const $=<T extends HTMLElement>(selector:string)=>section.querySelector<T>(selector)!;
  const form=$<HTMLFormElement>('#contribution-form'),archiveInput=$<HTMLInputElement>('#submission-archive'),imagesInput=$<HTMLInputElement>('#submission-images');
  const status=$<HTMLParagraphElement>('#submission-status'),progress=$<HTMLProgressElement>('#submission-progress'),report=$<HTMLElement>('#submission-report');
  const submit=$<HTMLButtonElement>('#submit-contribution'),cancel=$<HTMLButtonElement>('#cancel-contribution');
  let archive:File|null=null,images:File[]=[],urls:string[]=[],busy=false,abort:AbortController|null=null,session:{id:string;token:string}|null=null,currentXHR:XMLHttpRequest|null=null;
  const announce=(message:string,error=false)=>{status.textContent=message;status.classList.toggle('submission-error',error);status.classList.toggle('submission-success',!error&&(message.startsWith('Submission received')||message==='Temporary upload removed.'))};
  const revoke=()=>{$<HTMLElement>('#image-selection').querySelectorAll('img').forEach(unregisterAnimatedImage);urls.forEach(url=>URL.revokeObjectURL(url));urls=[]};
  function render(){
    const selected=$<HTMLElement>('#archive-selection');selected.replaceChildren();
    if(archive){const row=document.createElement('div');row.className='selected-archive';const label=document.createElement('span');label.textContent=`${archive.name} · ${size(archive.size)}`;label.title=archive.name;const remove=document.createElement('button');remove.type='button';remove.className='button';remove.textContent='Remove';remove.disabled=busy;remove.onclick=()=>{archive=null;archiveInput.value='';render()};row.append(label,remove);selected.append(row)}
    revoke();const gallery=$<HTMLElement>('#image-selection');gallery.replaceChildren();
    images.forEach((file,i)=>{const card=document.createElement('div');card.className='submission-image';const img=document.createElement('img');const url=URL.createObjectURL(file);urls.push(url);if(file.type==='image/gif')void registerAnimatedImage(img,url,file).catch(()=>{img.alt='GIF preview unavailable'});else img.src=url;img.alt=file.name;const label=document.createElement('span');label.textContent=file.name;label.title=file.name;const remove=document.createElement('button');remove.type='button';remove.className='button';remove.textContent='Remove';remove.setAttribute('aria-label','Remove '+file.name);remove.disabled=busy;remove.onclick=()=>{images.splice(i,1);render()};card.append(img,label,remove);gallery.append(card)});
  }
  function setArchive(files:File[]){if(busy)return;if(files.length!==1){announce('Choose exactly one ZIP, RAR or 7z archive.',true);return}const file=files[0];if(!/\.(zip|rar|7z)$/i.test(file.name)||file.size<=0||file.size>MAX_ARCHIVE){announce('Choose one non-empty ZIP, RAR or 7z archive up to 5 GiB.',true);return}archive=file;archiveInput.removeAttribute('aria-invalid');$<HTMLElement>('#archive-drop').removeAttribute('aria-invalid');announce('Archive selected. Add details and optional reference images.');render()}
  function addImages(files:File[]){if(busy)return;const next=[...images];for(const file of files){if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)||!file.size||file.size>MAX_IMAGE){announce('Images must be PNG, JPEG, WebP or GIF and no larger than 8 MiB each.',true);return}if(!next.some(f=>f.name===file.name&&f.size===file.size&&f.lastModified===file.lastModified))next.push(file)}if(next.length>MAX_IMAGES){announce('You can attach up to 8 images.',true);return}images=next;announce('Reference images updated.');render()}
  archiveInput.onchange=()=>setArchive([...archiveInput.files||[]]);imagesInput.onchange=()=>{addImages([...imagesInput.files||[]]);imagesInput.value=''};
  for(const [selector,select] of [['#archive-drop',setArchive],['#images-drop',addImages]] as const){const area=$<HTMLElement>(selector);area.addEventListener('dragover',e=>{e.preventDefault();if(!busy)area.classList.add('drag-over')});area.addEventListener('dragleave',()=>area.classList.remove('drag-over'));area.addEventListener('drop',e=>{e.preventDefault();area.classList.remove('drag-over');if(e.dataTransfer)select([...e.dataTransfer.files])})}
  jsonRequest('/api/facets').then(facets=>{for(const [name,,facet] of fields){const values=Array.isArray(facets[facet])?facets[facet]:[];$<HTMLDataListElement>(`#submission-${name}-options`).innerHTML=values.filter((v:unknown)=>typeof v==='string').slice(0,500).map((v:string)=>`<option value="${escape(v)}"></option>`).join('')}}).catch(()=>{/* Free text stays available when suggestions cannot load. */});
  function lock(value:boolean){busy=value;form.setAttribute('aria-busy',String(value));form.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input,textarea,select').forEach(e=>e.disabled=value);submit.disabled=value;cancel.hidden=!value&&!session;cancel.textContent=value?'Cancel upload':'Retry cleanup';submit.textContent=value?'Sending…':'Send for review';render()}
  async function discard(){
    if(!session)return;const old=session;let failure:unknown;
    for(let attempt=0;attempt<3;attempt++){
      try{await jsonRequest(`/api/submissions/${old.id}`,{method:'DELETE',headers:{'X-Upload-Token':old.token},signal:AbortSignal.timeout(10000)});if(session===old)session=null;return}
      catch(error){failure=error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)))}
    }
    throw failure;
  }
  cancel.onclick=()=>{
    cancel.disabled=true;
    if(busy){announce('Cancelling upload…');abort?.abort();currentXHR?.abort();return}
    lock(true);announce('Removing temporary upload…');void discard().then(()=>announce('Temporary upload removed.')).catch(()=>announce('Cleanup is still pending. Retry cleanup or wait for temporary files to expire within 24 hours.',true)).finally(()=>{lock(false);cancel.disabled=false});
  };
  function transfer(path:string,file:Blob,headers:Record<string,string>,onProgress:(bytes:number)=>void,signal:AbortSignal){return new Promise<any>((resolve,reject)=>{
    const xhr=new XMLHttpRequest();currentXHR=xhr;xhr.open('PUT',path);xhr.timeout=15*60*1000;
    Object.entries(headers).forEach(([key,value])=>xhr.setRequestHeader(key,value));
    const stop=()=>xhr.abort();signal.addEventListener('abort',stop,{once:true});
    const clean=()=>{signal.removeEventListener('abort',stop);if(currentXHR===xhr)currentXHR=null};
    xhr.upload.onprogress=e=>onProgress(e.loaded);
    xhr.onload=()=>{clean();let data:any;try{data=JSON.parse(xhr.responseText)}catch{reject(new Error('The server could not confirm this upload.'));return}if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(new Error(data.error||`Upload failed (${xhr.status}).`))};
    xhr.onerror=()=>{clean();reject(new Error('Connection lost. Please retry the submission.'))};xhr.ontimeout=()=>{clean();reject(new Error('Upload timed out. Please retry on a stable connection.'))};xhr.onabort=()=>{clean();reject(new DOMException('Upload cancelled','AbortError'))};
    if(signal.aborted){clean();reject(new DOMException('Upload cancelled','AbortError'));return}xhr.send(file);
  })}
  form.querySelectorAll<HTMLInputElement>('input').forEach(input=>input.addEventListener('input',()=>{if(input.value.trim())input.removeAttribute('aria-invalid')}));
  form.onsubmit=async event=>{
    event.preventDefault();if(busy)return;archiveInput.setAttribute('aria-invalid',String(!archive));$<HTMLElement>('#archive-drop').setAttribute('aria-invalid',String(!archive));
    let first:HTMLElement|null=null;
    for(const [name] of fields){const input=$<HTMLInputElement>(`#submission-${name}`);const missing=!input.value.trim();input.setAttribute('aria-invalid',String(missing));if(missing&&!first)first=input}
    const linkInput=$<HTMLInputElement>('#submission-link');let linkValid=true;if(linkInput.value.trim()){try{const url=new URL(linkInput.value.trim());linkValid=['http:','https:'].includes(url.protocol)&&!url.username&&!url.password}catch{linkValid=false}}linkInput.setAttribute('aria-invalid',String(!linkValid));if(!linkValid&&!first)first=linkInput;
    if(first){announce(linkValid?'Please complete the required fields marked in red.':'Use an HTTP or HTTPS link without credentials.',true);first.closest('label')?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});first.focus({preventScroll:true});return}
    if(!archive){announce('Choose a ZIP, RAR or 7z character archive first.',true);$<HTMLElement>('#archive-drop').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});archiveInput.focus({preventScroll:true});return}
    const optional={upload_by:$<HTMLInputElement>('#submission-upload-by').value.trim(),link:linkInput.value.trim(),description:$<HTMLTextAreaElement>('#submission-description').value.trim(),asset_category:'Characters'};
    const metadata=Object.fromEntries(fields.map(([name])=>[name,$<HTMLInputElement>(`#submission-${name}`).value.trim()]));
    if(Object.values(metadata).some(v=>!v)){announce('Please enter all four character details.',true);return}
    const file=archive,attachments=[...images];lock(true);abort=new AbortController();cancel.disabled=false;report.hidden=true;progress.hidden=false;progress.value=0;
    try{
      if(session){announce('Removing previous temporary upload…');await discard()}
      announce('Checking archive…');const magic=new Uint8Array(await file.slice(0,8).arrayBuffer()),extension=file.name.split('.').at(-1)!.toLowerCase();const starts=(prefix:number[])=>prefix.every((byte,i)=>magic[i]===byte);const valid=extension==='zip'?starts([0x50,0x4b,3,4]):extension==='rar'?starts([0x52,0x61,0x72,0x21,0x1a,7,0])||starts([0x52,0x61,0x72,0x21,0x1a,7,1,0]):extension==='7z'&&starts([0x37,0x7a,0xbc,0xaf,0x27,0x1c]);if(!valid)throw new Error('Archive contents do not match the ZIP, RAR or 7z extension.');
      const created=await jsonRequest('/api/submissions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...metadata,...optional,archive_name:file.name,archive_size:file.size,image_count:attachments.length}),signal:abort.signal});
      session={id:created.id,token:created.token};const headers={'X-Upload-Token':session.token,'Content-Type':'application/octet-stream'},base=`/api/submissions/${session.id}`;
      const partSize=Number(created.part_size);if(!Number.isInteger(partSize)||partSize<5*MiB||partSize>32*MiB)throw new Error('The server returned an invalid upload size.');
      let sent=0;const total=file.size+attachments.reduce((n,image)=>n+image.size,0);
      const update=(n:number,stage:string)=>{const percent=Math.min(99,Math.floor((sent+n)/total*100));progress.value=percent;announce(`${stage} · ${percent}% · ${size(sent+n)} / ${size(total)}`)};
      for(let offset=0,part=1;offset<file.size;offset+=partSize,part++){const blob=file.slice(offset,Math.min(offset+partSize,file.size));await transfer(`${base}/parts/${part}`,blob,headers,n=>update(n,'Uploading archive'),abort.signal);sent+=blob.size}
      for(let i=0;i<attachments.length;i++){await transfer(`${base}/images/${i+1}`,attachments[i],{'X-Upload-Token':session.token,'Content-Type':attachments[i].type},n=>update(n,`Uploading image ${i+1} of ${attachments.length}`),abort.signal);sent+=attachments[i].size}
      update(0,'Checking archive contents');
      const result=await jsonRequest(`${base}/complete`,{method:'POST',headers:{'Content-Type':'application/json','X-Upload-Token':session.token},body:'{}',signal:abort.signal});
      report.textContent=JSON.stringify(result.report,null,2);report.hidden=false;
      if(result.status!=='READY'){announce('The archive did not pass inspection. See the report below and submit a corrected file.',true);await discard();return}
      session=null;progress.value=100;announce(`Submission received for private review. Reference: ${result.id}. It has not been published.${result.report?.inspection==='metadata'?' Archive metadata only was checked; model contents require manual review.':''}`);archive=null;images=[];archiveInput.value='';
    }catch(error){const cancelled=abort.signal.aborted;let cleanupFailed=false;try{await discard()}catch{cleanupFailed=true}announce((cancelled?'Upload cancelled. Your selected files are kept here.':(error as Error).message)+(cleanupFailed?' Cleanup is pending. Use Retry cleanup; temporary files expire within 24 hours.':''),true)}
    finally{abort=null;lock(false);cancel.disabled=false}
  };
  window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue=''}});
  window.addEventListener('pagehide',event=>{if(!event.persisted)revoke()});
}
