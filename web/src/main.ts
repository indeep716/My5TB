import {reveal,openDialog,closeDialog,slideImage} from './motion';
import './style.css';
import {setupHeaderScroll} from './header-scroll';
import {exclusionsMarkup,setupExclusions} from './exclusions';
import {setupCommunity} from './community';
import {preparePreview,cachedPreviewURL,displayPreview,releasePreviewImages,clearPreviewURLs} from './preview-media';
import './preview-media.css';

interface ModelFile {filename:string;size:number;sha256:string;url:string;formats?:string[];contents?:string[]}
interface Model {upload_by?:string;link?:string;description?:string;id:string;slug:string;title:string;asset_category?:string;style:string;artist_category:string;artist_name:string;media_title:string;character_name:string;version?:string;created_at?:number|null;formats?:string[];files:ModelFile[];images:{key:string;sha256:string;role:string;width:number;height:number}[]}
const FORMAT_HUES:Record<string,number>={BLEND:28,FBX:212,MAYA:174,GLB:262,GLTF:286,OBJ:146,MAX:196,C4D:236,ZBRUSH:340,USD:52,USDZ:68,STL:0,VRM:312,MMD:320,UNITY:200,UNREAL:228,ZIP:216,RAR:216};
const EXT_LABEL:Record<string,string>={ma:'MAYA',mb:'MAYA',maya:'MAYA',blen:'BLEND',ztl:'ZBRUSH',zpr:'ZBRUSH',pmx:'MMD',pmd:'MMD',mmd:'MMD',vmd:'MMD',vpd:'MMD',pmm:'MMD',x:'MMD',unitypackage:'UNITY',uasset:'UNREAL',usda:'USD',usdc:'USD',hip:'HOUDINI',spp:'PAINTER'};
const formatArtist=(name:string)=>String(name||'').replace(/\s*[（(]\s*([^）)]+?)\s*[）)]/g,' | $1').replace(/^(?:\s*\|\s*)+|(?:\s*\|\s*)+$/g,'').replace(/\s*\|\s*/g,' | ').trim()||String(name||'').trim();
const extFormat=(name:string)=>{const ext=(name.split('.').at(-1)||'').toLowerCase();return EXT_LABEL[ext]||ext.toUpperCase()||'3D'};
const formatHue=(label:string)=>FORMAT_HUES[label]??[...label].reduce((h,c)=>(h*31+c.charCodeAt(0))%360,7);
const modelFormats=(m:Model)=>m.formats?.length?m.formats:[...new Set(m.files.flatMap(f=>f.formats||[extFormat(f.filename)]))].sort();
const formatChip=(label:string,tag='span',attrs='')=>`<${tag} class="format-chip" style="--format-hue:${formatHue(label)}" ${attrs}>${esc(label)}</${tag}>`;
const isNew=(m:Model)=>!!m.created_at&&Date.now()/1000-m.created_at<7*86400;
interface Page {items:Model[];total:number;page:number;limit:number;demo?:boolean}
type FilterField='artist_category'|'artist_name'|'media_title'|'format';
const FILTER_META:Record<FilterField,{label:string;placeholder:string;initial:string[]}>={
  artist_category:{label:'SOURCE',placeholder:'All sources',initial:['Artists','Official','RIP']},
  artist_name:{label:'ARTIST',placeholder:'All artists',initial:[]},
  media_title:{label:'WORLD / SERIES',placeholder:'All worlds',initial:[]},
  format:{label:'FILE TYPE',placeholder:'All file types',initial:[]},
};
const filterOptions:Record<FilterField,string[]>={
  artist_category:[...FILTER_META.artist_category.initial],
  artist_name:[],
  media_title:[],
  format:[],
};
const app=document.querySelector<HTMLDivElement>('#app')!;
const icon=(name:string)=>`<span class="material-symbols-outlined" aria-hidden="true">${name}</span>`;
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const bytes=(n:number)=>n>=1e9?(n/1e9).toFixed(1)+' GB':n>=1e6?(n/1e6).toFixed(1)+' MB':(n/1024).toFixed(1)+' KB';
const categories=['Characters','Scenes','Motions','Plugins','Shaders','Courses'];
const availableCategories=new Set(['Characters']);
if(/^\/models(?:\/|$)/.test(location.pathname))history.replaceState({},'',location.pathname.replace(/^\/models/,'/Characters')+location.search+location.hash);
const requestedCategory=new URLSearchParams(location.search).get('asset_category')||'Characters';
const initialCategory=availableCategories.has(requestedCategory)?requestedCategory:'Characters';
const categoryLinks=()=>categories.map(category=>availableCategories.has(category)?`<a data-category="${category}" href="/Characters?asset_category=${encodeURIComponent(category)}#search">${category}</a>`:`<button class="category-disabled" type="button" disabled aria-label="${category}, coming soon"><span>${category}</span><small>Coming soon</small></button>`).join('');
const comboMarkup=(field:FilterField)=>{const m=FILTER_META[field];return `<div class="filter-group" data-combo-group="${field}"><label class="technical" for="${field}">${m.label}</label><div class="filter-combo" data-combo="${field}"><input id="${field}" class="filter-combo-input" type="text" role="combobox" autocomplete="off" spellcheck="false" placeholder="${m.placeholder}" aria-label="${m.label}" aria-expanded="false" aria-controls="${field}-list" aria-autocomplete="list"><button type="button" class="filter-combo-clear" data-combo-clear="${field}" aria-label="Clear ${m.label.toLowerCase()} filter" hidden>${icon('close')}</button><button type="button" class="filter-combo-chevron" data-combo-toggle="${field}" tabindex="-1" aria-label="Toggle ${m.label.toLowerCase()} options">${icon('expand_more')}</button><ul id="${field}-list" class="filter-combo-list" role="listbox" aria-label="${m.label} options" hidden></ul></div></div>`};
const state={page:1,q:'',asset_category:initialCategory,style:'',artist_category:'',artist_name:'',media_title:'',format:'',view:'grid',total:0};
let models:Model[]=[],controller:AbortController|null=null,keyPromise:Promise<CryptoKey>|null=null;
let theme=localStorage.getItem('my5tb-theme')||'light';document.documentElement.dataset.theme=theme;
app.innerHTML=`
<header class="header"><button id="menu-toggle" class="icon-button menu-toggle" aria-label="Open navigation menu" aria-expanded="false" aria-controls="mobile-menu">${icon('menu')}</button><a class="brand" href="/" aria-label="My5TB home">my5tb</a><nav class="type-nav" aria-label="Asset types">${categoryLinks()}</nav><div class="header-actions"><button id="theme" class="icon-button desktop-theme" aria-label="Switch to dark theme">${icon('dark_mode')}</button></div></header>
<dialog id="mobile-menu" class="mobile-menu" aria-labelledby="mobile-menu-title"><div class="mobile-menu-heading"><h2 id="mobile-menu-title" class="brand">my5tb</h2><button id="menu-close" class="icon-button" aria-label="Close navigation menu">${icon('close')}</button></div><nav class="mobile-type-nav" aria-label="Mobile asset types">${categoryLinks()}</nav><div class="mobile-menu-footer"><span>Appearance</span><button id="mobile-theme" class="button" aria-label="Switch to dark theme">${icon('dark_mode')}</button></div></dialog>
<main><section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><div class="eyebrow"><span class="tiny-square"></span> THE PERSONAL 3D ARCHIVE </div><h1 id="hero-title">A space for<br>every <span>dimension.</span></h1><p class="hero-description">Characters, worlds, and everything in between.<br>A considered collection of 3D assets. Ready for your next idea.</p></div></section>
<section id="collection" class="collection" aria-labelledby="collection-title"><div class="section-heading"><div><h2 id="collection-title">Find your next starting point<span>.</span></h2></div></div><div class="search-panel"><label class="search-box">${icon('search')}<input id="search" type="search" placeholder="Search characters, artists, or worlds…" aria-label="Search collection"></label></div><div class="catalog-layout"><aside class="filters" aria-label="Collection filters"><div class="filter-heading"><span class="technical">Filters</span><button id="clear" class="filter-reset" type="button" aria-label="Reset filters">Reset ${icon('restart_alt')}</button></div><div class="filter-group"><span class="technical">STYLE</span><div class="style-options"><button class="style-chip selected" data-style="">All models</button><button class="style-chip" data-style="Stylized">Stylized</button><button class="style-chip" data-style="Realism">Realism</button></div></div>${comboMarkup('artist_category')}${comboMarkup('artist_name')}${comboMarkup('media_title')}${comboMarkup('format')}${exclusionsMarkup()}</aside><div class="results"><div class="results-bar"><span id="filter-summary" class="filter-summary" aria-label="Active filters">All models</span><span id="count" class="technical results-status" role="status" aria-live="polite"></span><div class="view-controls"><button id="grid-view" class="icon-button active" aria-label="Grid view" aria-pressed="true">${icon('grid_view')}</button><button id="list-view" class="icon-button" aria-label="List view" aria-pressed="false">${icon('view_list')}</button></div></div><div id="demo-note" class="demo-note" hidden>LOCAL DEMO / Original procedural studies. Your source collection has not been uploaded.</div><div id="cards" class="cards" aria-live="polite"></div><div id="pagination" class="pagination" aria-label="Pagination"></div></div></div></section>
</main>
<footer><a class="brand" href="/">my5tb</a><span class="technical">© ${new Date().getFullYear()} My5TB</span><a href="#" aria-label="Back to top">${icon('north')}</a></footer>
<dialog id="age-dialog" class="age-dialog" aria-labelledby="age-title"><span class="brand age-brand">my5tb</span><span class="eyebrow">BEFORE YOU ENTER</span><h2 id="age-title">A little context.</h2><p>This archive may include mature content. You must be 18 or older to browse.</p><button id="age-accept" class="button primary">I am 18 or older ${icon('arrow_forward')}</button><button id="age-decline" class="button">Leave this page</button><p class="fine-print">Age confirmation is saved for this browser session.</p></dialog>
<dialog id="detail-dialog" class="detail-dialog" aria-labelledby="detail-title"><button id="close-detail" class="icon-button close-detail" aria-label="Close model details">${icon('close')}</button><div id="detail-body"></div></dialog>`;

const community=setupCommunity();
if(!community.active)document.title=/^\/Characters(?:\/|$)/.test(location.pathname)?'Characters - My5TB':'My5TB';
setupHeaderScroll();
const $=<T extends HTMLElement=HTMLElement>(s:string)=>document.querySelector<T>(s)!;
function setTheme(){
  document.documentElement.dataset.theme=theme;localStorage.setItem('my5tb-theme',theme);
  const next=theme==='light'?'dark':'light';
  $('#theme').innerHTML=icon(next+'_mode');$('#theme').setAttribute('aria-label',`Switch to ${next} theme`);
  $('#mobile-theme').innerHTML=icon(next+'_mode');
  $('#mobile-theme').setAttribute('aria-label',`Switch to ${next} theme`);
}
const toggleTheme=()=>{theme=theme==='light'?'dark':'light';setTheme()};
setTheme();$('#theme').onclick=toggleTheme;$('#mobile-theme').onclick=toggleTheme;
const mobileMenu=$<HTMLDialogElement>('#mobile-menu');
function closeMenu(){void closeDialog(mobileMenu)}
$('#menu-toggle').onclick=()=>{openDialog(mobileMenu);$('#menu-toggle').setAttribute('aria-expanded','true')};
$('#menu-close').onclick=closeMenu;
mobileMenu.addEventListener('cancel',event=>{event.preventDefault();closeMenu()});
mobileMenu.addEventListener('close',()=>{$('#menu-toggle').setAttribute('aria-expanded','false');(matchMedia('(max-width: 1280px)').matches?$('#menu-toggle'):$('#theme')).focus()});
// Empty space is not a dismissal target; use the close control or Escape.
matchMedia('(max-width: 1280px)').addEventListener('change',event=>{if(!event.matches&&mobileMenu.open)closeMenu()});
function syncCategoryNavigation(){
  document.querySelectorAll<HTMLAnchorElement>('[data-category]').forEach(link=>{
    const active=!community.active&&link.dataset.category===state.asset_category;link.classList.toggle('nav-active',active);
    if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  });
}
function categoryURL(showSearch=false){const url=new URL(location.href);if(state.asset_category)url.searchParams.set('asset_category',state.asset_category);else url.searchParams.delete('asset_category');if(showSearch){url.pathname='/Characters';url.hash='search'};history.replaceState({},'',url)}
syncCategoryNavigation();
if(!community.active)categoryURL();
document.querySelectorAll<HTMLAnchorElement>('[data-category]').forEach(link=>link.onclick=event=>{
  event.preventDefault();state.asset_category=link.dataset.category!;state.page=1;syncCategoryNavigation();categoryURL(true);
  if(mobileMenu.open)closeMenu();load();$('#search').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});
});
const age=$<HTMLDialogElement>('#age-dialog');
$('#age-accept').onclick=()=>{sessionStorage.setItem('my5tb-age','yes');void closeDialog(age).then(start)};
$('#age-decline').onclick=()=>{age.close();$('main').innerHTML='<section class="declined"><h1>See you another time.</h1><p>This collection is for adults only.</p></section>'};
age.addEventListener('cancel',event=>event.preventDefault());

async function get<T>(path:string,signal?:AbortSignal):Promise<T>{const r=await fetch(path,{cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});if(!r.ok)throw new Error(r.status===404?'This item is no longer available.':'The archive is unavailable. Please try again.');try{return await r.json()}catch{throw new Error('The archive is unavailable. Please try again.')}}
async function getKey(){if(!keyPromise)keyPromise=get<{key:string}>('/api/preview-key').then(({key})=>crypto.subtle.importKey('raw',Uint8Array.from(atob(key),c=>c.charCodeAt(0)),{name:'AES-GCM'},false,['decrypt'])).catch(error=>{keyPromise=null;throw error});return keyPromise}
async function imageURL(image:Model['images'][number]){
  const cached=cachedPreviewURL(image.key);if(cached)return cached;
  const r=await fetch('/api/assets/'+encodeURIComponent(image.key));if(!r.ok)throw new Error('Preview unavailable');const data=await r.arrayBuffer();
  const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(sha!==image.sha256)throw new Error('Preview integrity check failed');
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:data.slice(0,12)},await getKey(),data.slice(12));
  return preparePreview(image.key,plain);
}
const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);const img=entry.target as HTMLImageElement;const model=models.find(m=>m.id===img.dataset.id);if(model?.images[0])imageURL(model.images[0]).then(()=>displayPreview(img,model.images[0].key,img.closest<HTMLElement>('.card-visual')||undefined)).catch(()=>{img.closest('.card-visual')?.classList.add('image-error');img.alt='Preview unavailable'})}},{rootMargin:'200px'});

const exclusions=setupExclusions(()=>{state.page=1;load()},()=>closeAllCombos());

// Searchable dropdown comboboxes: click to pick from all options or type to filter options in place.
function setFilterOptions(field:FilterField,values:string[]){
  const seen=new Set<string>();
  const normalized=field==='artist_name'?values.map(formatArtist):values;
  const merged=[...FILTER_META[field].initial,...normalized].filter(v=>{const s=String(v||'').trim();if(!s||seen.has(s))return false;seen.add(s);return true});
  filterOptions[field]=merged;
  renderComboList(field,'');
}
function syncFilterInputs(){
  for(const field of ['artist_category','artist_name','media_title','format'] as const){
    const input=$<HTMLInputElement>('#'+field);
    const clearBtn=$<HTMLButtonElement>(`[data-combo-clear="${field}"]`);
    input.value=state[field];
    clearBtn.hidden=!state[field];
    renderComboList(field,'');
  }
}
function closeAllCombos(except?:FilterField){
  for(const field of ['artist_category','artist_name','media_title','format'] as const){
    if(field===except)continue;
    const combo=$<HTMLDivElement>(`[data-combo="${field}"]`);
    const input=$<HTMLInputElement>('#'+field);
    const list=$<HTMLUListElement>(`#${field}-list`);
    if(!list.hidden){
      list.hidden=true;
      combo.classList.remove('open');
      input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');
      input.value=state[field];
    }
  }
}
function selectComboValue(field:FilterField,value:string){
  if(value&&!filterOptions[field].includes(value))filterOptions[field].push(value);
  state[field]=value;state.page=1;
  closeAllCombos();
  syncFilterInputs();
  load();
}
function renderComboList(field:FilterField,query:string){
  const list=$<HTMLUListElement>(`#${field}-list`);
  const q=query.trim().toLowerCase();
  const matches=filterOptions[field].filter(v=>!q||v.toLowerCase().includes(q));
  const placeholder=FILTER_META[field].placeholder;
  const rows:string[]=[];
  if(!q||placeholder.toLowerCase().includes(q)){
    const active=state[field]==='';
    rows.push(`<li role="option" class="filter-combo-option${active?' selected':''}" data-option="" aria-selected="${active}"><span>${esc(placeholder)}</span></li>`);
  }
  for(const value of matches){
    const active=state[field]===value;
    rows.push(`<li role="option" class="filter-combo-option${active?' selected':''}" data-option="${esc(value)}" aria-selected="${active}"><span>${esc(value)}</span></li>`);
  }
  if(!rows.length){
    rows.push(`<li class="filter-combo-empty" role="presentation">No matching options</li>`);
  }
  list.innerHTML=rows.join('');
  $('#'+field).removeAttribute('aria-activedescendant');
  list.querySelectorAll<HTMLLIElement>('.filter-combo-option').forEach((item,index)=>item.id=field+'-option-'+index);
  list.querySelectorAll<HTMLLIElement>('.filter-combo-option').forEach(item=>{
    item.onmousedown=event=>{event.preventDefault();selectComboValue(field,item.dataset.option||'')};
  });
}
function activateComboOption(field:FilterField,option?:HTMLLIElement){
  const input=$('#'+field),list=$(`#${field}-list`);
  list.querySelectorAll('.filter-combo-option').forEach(item=>item.classList.toggle('active',item===option));
  if(option){input.setAttribute('aria-activedescendant',option.id);option.scrollIntoView({block:'nearest'})}
  else input.removeAttribute('aria-activedescendant');
}
function openCombo(field:FilterField,query=''){
  exclusions.close();
  closeAllCombos(field);
  const combo=$<HTMLDivElement>(`[data-combo="${field}"]`);
  const input=$<HTMLInputElement>('#'+field);
  const list=$<HTMLUListElement>(`#${field}-list`);
  renderComboList(field,query);
  list.hidden=false;
  combo.classList.add('open');
  input.setAttribute('aria-expanded','true');
}
for(const field of ['artist_category','artist_name','media_title','format'] as const){
  const input=$<HTMLInputElement>('#'+field);
  const clearBtn=$<HTMLButtonElement>(`[data-combo-clear="${field}"]`);
  const toggleBtn=$<HTMLButtonElement>(`[data-combo-toggle="${field}"]`);
  const list=$<HTMLUListElement>(`#${field}-list`);
  renderComboList(field,'');
  input.addEventListener('focus',()=>openCombo(field,''));
  input.addEventListener('click',()=>{if(list.hidden)openCombo(field,'')});
  input.addEventListener('input',()=>openCombo(field,input.value));
  input.addEventListener('keydown',event=>{
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();const wasHidden=list.hidden;if(wasHidden)openCombo(field,'');
      const options=[...list.querySelectorAll<HTMLLIElement>('.filter-combo-option')];
      const index=options.findIndex(option=>option.classList.contains('active'));
      const next=wasHidden||index<0?(event.key==='ArrowUp'?options.length-1:0):(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;
      activateComboOption(field,options[next]);
    }else if(event.key==='Enter'&&!list.hidden){
      event.preventDefault();const active=list.querySelector<HTMLLIElement>('.filter-combo-option.active')||list.querySelector<HTMLLIElement>('.filter-combo-option');
      if(active)selectComboValue(field,active.dataset.option||'');
    }else if(event.key==='Escape'&&!list.hidden){event.preventDefault();event.stopPropagation();closeAllCombos()}
  });
  const combo=$<HTMLDivElement>(`[data-combo="${field}"]`);
  combo.addEventListener('focusout',event=>{if(!combo.contains(event.relatedTarget as Node|null))closeAllCombos()});
  clearBtn.onclick=event=>{event.stopPropagation();selectComboValue(field,'')};
  toggleBtn.onmousedown=event=>event.preventDefault();
  toggleBtn.onclick=()=>{
    if(list.hidden){input.focus();openCombo(field,'')}
    else closeAllCombos();
  };
}
document.addEventListener('mousedown',event=>{
  const target=event.target as HTMLElement|null;
  if(!target?.closest('.filter-combo'))closeAllCombos();
});

function pageItems(current:number,totalPages:number):(number|'ellipsis')[]{
  if(totalPages<=7)return Array.from({length:totalPages},(_,i)=>i+1);
  const pages:(number|'ellipsis')[]=[1];
  const start=Math.max(2,current-1),end=Math.min(totalPages-1,current+1);
  if(start>2)pages.push('ellipsis');
  for(let p=start;p<=end;p++)pages.push(p);
  if(end<totalPages-1)pages.push('ellipsis');
  pages.push(totalPages);
  return pages;
}

let loadSequence=0;
async function load(){
  const summaryParams=new URLSearchParams();exclusions.append(summaryParams);
  const summary=[state.style||'All models',...['q','artist_category','artist_name','media_title','format'].map(key=>state[key as keyof typeof state]).filter(value=>typeof value==='string'&&value.trim()),...[...summaryParams.entries()].map(([key,value])=>'Exclude '+key.slice(8).replace('world','world / series')+': '+value)].join(' | ');
  $('#filter-summary').textContent=summary;$('#filter-summary').title=summary;

  const sequence=++loadSequence;controller?.abort();controller=new AbortController();releasePreviewImages($('#cards'));
  $('#count').textContent='';$('#count').removeAttribute('aria-label');$('#cards').setAttribute('aria-busy','true');
  $('#cards').innerHTML='<div class="collection-loading" role="status"><span class="loading-ring" aria-hidden="true"></span><span>LOADING COLLECTION…</span></div>';$('#pagination').innerHTML='';
  const slowTimer=setTimeout(()=>{if(sequence===loadSequence){const label=$('#cards .collection-loading span:last-child');if(label)label.textContent='STILL LOADING…';$('#count').textContent='Taking longer than usual';}},10000);
  const params=new URLSearchParams();for(const [key,value] of Object.entries(state))if(value&&key!=='view'&&key!=='total')params.set(key,String(value));
  exclusions.append(params);
  try{
    const result=await get<Page>('/api/models?'+params,controller.signal);if(sequence!==loadSequence)return;
    const limit=result.limit||15;
    const pages=Math.max(1,Math.ceil(result.total/limit));
    if(result.total>0&&state.page>pages){state.page=pages;return load()}
    state.page=Math.min(Math.max(1,result.page||state.page),pages);
    models=result.items.map(m=>({...m,artist_name:formatArtist(m.artist_name)}));state.total=result.total;
    $('#demo-note').hidden=!result.demo;const resultLabel=`${result.total} model${result.total===1?'':'s'}`;$('#count').textContent=resultLabel;$('#count').setAttribute('aria-label',`${resultLabel} found`);
    observer.disconnect();
    $('#cards').innerHTML=models.length?models.map(m=>`<article class="model-card"><button class="card-open" data-id="${esc(m.id)}" aria-label="View ${esc(m.title)}"><div class="card-visual">${isNew(m)?'<span class="card-new technical">NEW</span>':''}<span class="card-formats">${modelFormats(m).map(f=>formatChip(f)).join('')}</span><img data-id="${esc(m.id)}" alt="${esc(m.title)} model preview" loading="lazy"><span class="card-arrow">${icon('north_east')}</span></div><div class="card-info"><div class="card-meta technical"><span>${esc(m.style)}</span><span>${esc(m.media_title)}</span></div><h3 title="${esc(m.title)}">${esc(m.title)}</h3><div class="card-foot"><span title="${esc(m.artist_name)}">${esc(m.artist_name)}</span><span class="technical">${m.files.length} FILE${m.files.length!==1?'S':''}</span></div></div></button></article>`).join(''):`<div class="empty-state">${icon('search_off')}<h3>${state.asset_category||state.q||state.style||state.artist_name||state.artist_category||state.media_title||state.format?'No matches this time.':'Your collection starts here.'}</h3><p>${state.asset_category||state.q||state.style||state.artist_name||state.artist_category||state.media_title||state.format?'Try another term or reset the filters.':'Published models will appear here after your first sync.'}</p><button class="button" id="empty-reset">Reset filters</button></div>`;
    document.querySelectorAll<HTMLImageElement>('.card-visual img').forEach(img=>observer.observe(img));
    document.querySelectorAll<HTMLButtonElement>('.card-open').forEach(b=>b.onclick=()=>openModel(b.dataset.id!));
    $('#empty-reset')?.addEventListener('click',reset);
    const nums=pageItems(state.page,pages).map(p=>p==='ellipsis'?'<span class="page-ellipsis technical" aria-hidden="true">…</span>':`<button type="button" class="button page-num${p===state.page?' active':''}" data-page="${p}" aria-label="Page ${p}" ${p===state.page?'aria-current="page"':''}>${p}</button>`).join('');
    $('#pagination').innerHTML=result.total>0?`<button type="button" class="button page-step" id="prev" aria-label="Previous page" ${state.page<=1?'disabled':''}>${icon('west')}</button><div class="page-numbers" role="group" aria-label="Select page">${nums}</div><button type="button" class="button page-step" id="next" aria-label="Next page" ${state.page>=pages?'disabled':''}>${icon('east')}</button>`:'';
    $('#prev')?.addEventListener('click',()=>{if(state.page>1){state.page--;load()}});
    $('#next')?.addEventListener('click',()=>{if(state.page<pages){state.page++;load()}});
    document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(b=>b.onclick=()=>{const target=Number(b.dataset.page);if(target&&target!==state.page){state.page=target;load()}});
  }catch(e){if(sequence!==loadSequence||(e as Error).name==='AbortError')return;$('#count').textContent='CONNECTION UNAVAILABLE';$('#cards').innerHTML=`<div class="empty-state">${icon('cloud_off')}<h3>The archive is taking a moment.</h3><p>${esc((e as Error).message)}</p><button class="button" id="retry">Try again</button></div>`;$('#retry').onclick=load}
  finally{clearTimeout(slowTimer);if(sequence===loadSequence){$('#cards').removeAttribute('aria-busy');reveal($('#cards'))}}
}
let debounce:ReturnType<typeof setTimeout>;
$('#search').addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(()=>{state.q=$<HTMLInputElement>('#search').value;state.page=1;load()},250)});

document.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(button=>button.onclick=()=>{state.style=button.dataset.style!;state.page=1;document.querySelectorAll('[data-style]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button))});load()});
function reset(){clearTimeout(debounce);closeAllCombos();exclusions.reset();state.page=1;state.q='';state.style='';state.artist_category='';state.artist_name='';state.media_title='';state.format='';$<HTMLInputElement>('#search').value='';syncFilterInputs();document.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(b=>{b.classList.toggle('selected',b.dataset.style==='');b.setAttribute('aria-pressed',String(b.dataset.style===''))});syncCategoryNavigation();load()}
$('#clear').onclick=reset;
document.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(b=>b.setAttribute('aria-pressed',String(b.classList.contains('selected'))));
for(const mode of ['grid','list'])$('#'+mode+'-view').onclick=()=>{state.view=mode;$('#cards').classList.toggle('list',mode==='list');reveal($('#cards'));for(const other of ['grid','list']){$('#'+other+'-view').classList.toggle('active',mode===other);$('#'+other+'-view').setAttribute('aria-pressed',String(mode===other))}};
const detail=$<HTMLDialogElement>('#detail-dialog');let detailSequence=0;
let stepDetailImage:((delta:number)=>void)|null=null;
function closeDetail(){detailSequence++;stepDetailImage=null;void closeDialog(detail);if(location.pathname.startsWith('/Characters/'))history.pushState({},'', '/Characters'+location.search)}
$('#close-detail').onclick=closeDetail;detail.addEventListener('cancel',event=>{event.preventDefault();closeDetail()});detail.addEventListener('click',event=>{if(event.target===detail)closeDetail()});
document.addEventListener('keydown',event=>{
  const key=event.key.toLowerCase();
  if(event.key==='F12'||((event.ctrlKey||event.metaKey)&&event.shiftKey&&['i','j','c','k'].includes(key))||((event.ctrlKey||event.metaKey)&&['u','s'].includes(key))){event.preventDefault();event.stopPropagation();return}
  if(!detail.open||!stepDetailImage||event.altKey||event.ctrlKey||event.metaKey)return;
  if(event.key==='ArrowLeft'){event.preventDefault();stepDetailImage(-1)}
  else if(event.key==='ArrowRight'){event.preventDefault();stepDetailImage(1)}
});
document.addEventListener('contextmenu',event=>event.preventDefault());
document.addEventListener('dragstart',event=>event.preventDefault());
document.addEventListener('selectstart',event=>{if(!(event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement))event.preventDefault()});
// Detail metadata links apply the matching catalog filter, close the dialog and reload results.
function applyFilter(field:FilterField,value:string){
  if(value&&!filterOptions[field].includes(value))filterOptions[field].push(value);
  state[field]=value;state.page=1;syncFilterInputs();
  closeDetail();load();$('#search').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
}
const filterLink=(field:string,value:string,label=value)=>`<button type="button" class="meta-link" data-filter="${field}" data-value="${esc(value)}" title="${esc(label)}" aria-label="Filter by ${esc(label)}">${esc(label)}</button>`;
function externalLink(value?:string){if(!value)return '-';try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return '-';return `<a class="model-external-link" href="${esc(u.href)}" target="_blank" rel="noopener noreferrer" title="${esc(value)}"><span>${esc(value)}</span>${icon('open_in_new')}</a>`}catch{return '-'}}
async function openModel(id:string,updateURL=true){
  const sequence=++detailSequence;stepDetailImage=null;releasePreviewImages($('#detail-body'));$('#detail-body').innerHTML='<div class="empty-state" role="status"><span class="loading-ring" aria-hidden="true"></span><h2 id="detail-title">Opening model…</h2></div>';openDialog(detail);
  if(updateURL)history.pushState({},'', '/Characters/'+encodeURIComponent(id)+location.search);
  try{const m=await get<Model>('/api/models/'+encodeURIComponent(id));if(sequence!==detailSequence)return;
    m.artist_name=formatArtist(m.artist_name);
    const many=m.images.length>1;
    const formats=modelFormats(m);
    $('#detail-body').innerHTML=`<div class="detail-gallery"><div class="gallery-frame" id="gallery-frame"><img id="detail-image" alt="${esc(m.title)} main preview"><div id="gallery-loading" class="gallery-loading" role="status" aria-live="polite" hidden><span class="loading-ring" aria-hidden="true"></span><span class="technical">LOADING PREVIEW…</span></div>${many?`<button type="button" class="gallery-nav prev" id="gallery-prev" aria-label="Previous image">${icon('chevron_left')}</button><button type="button" class="gallery-nav next" id="gallery-next" aria-label="Next image">${icon('chevron_right')}</button>`:''}</div>${many?`<div id="thumbs" class="gallery-dots" role="group" aria-label="Images">${m.images.map((_,i)=>`<button type="button" class="gallery-dot" data-image="${i}" aria-label="Image ${i+1} of ${m.images.length}"></button>`).join('')}</div>`:''}</div>
<div class="detail-info"><h2 id="detail-title">${esc(m.title)}</h2>
<dl class="detail-meta"><dt class="technical">SOURCE</dt><dd>${filterLink('artist_category',m.artist_category)}</dd><dt class="technical">ARTIST</dt><dd>${filterLink('artist_name',m.artist_name)}</dd><dt class="technical">WORLD / SERIES</dt><dd>${filterLink('media_title',m.media_title)}</dd><dt class="technical">UPLOAD BY</dt><dd class="detail-uploader">${esc(m.upload_by||'-')}</dd><dt class="technical">LINK</dt><dd>${externalLink(m.link)}</dd><dt class="technical">TYPE</dt><dd class="format-list">${formats.map(f=>formatChip(f,'button',`type="button" data-filter="format" data-value="${esc(f)}" aria-label="Filter by ${esc(f)} files"`)).join('')}</dd></dl>
<div class="detail-rule"></div><span class="technical">FILES</span>
<div class="downloads">${m.files.map(f=>`<div class="download-row"><div class="download-meta"><strong title="${esc(f.filename)}">${esc(f.filename)}</strong><span class="technical">${bytes(f.size)}</span></div><a class="icon-button" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" aria-label="Download ${esc(f.filename)}">${icon('download')}</a></div>`).join('')}</div>${m.description?.trim()?`<section class="model-description"><h3 class="technical">DESCRIPTION</h3><div class="description-box"><p id="description-text" class="description-text">${esc(m.description)}</p><button type="button" id="description-toggle" class="button" aria-expanded="false" aria-controls="description-text" hidden>More</button></div></section>`:''}</div>`;
    const descText=document.querySelector<HTMLParagraphElement>('#description-text'),more=document.querySelector<HTMLButtonElement>('#description-toggle');
    if(descText&&more){
      const syncMore=()=>{const expanded=more.getAttribute('aria-expanded')==='true';if(!expanded)more.hidden=descText.scrollHeight<=descText.clientHeight+1};
      requestAnimationFrame(syncMore);
      more.onclick=()=>{const expanded=more.getAttribute('aria-expanded')!=='true';more.setAttribute('aria-expanded',String(expanded));descText.classList.toggle('expanded',expanded);more.textContent=expanded?'Less':'More';if(!expanded)syncMore()};
    }
    document.querySelectorAll<HTMLButtonElement>('#detail-body [data-filter]').forEach(b=>b.onclick=()=>applyFilter(b.dataset.filter as FilterField,b.dataset.value!));
    let imageSequence=0,currentImage=0;
    const showImage=async(i:number,direction?:number)=>{
      if(!m.images.length)return;const movement=direction??(i<currentImage?-1:1);i=(i+m.images.length)%m.images.length;currentImage=i;
      const current=++imageSequence;const img=$<HTMLImageElement>('#detail-image'),loader=$<HTMLDivElement>('#gallery-loading');const meta=m.images[i];
      img.setAttribute('aria-busy','true');img.alt='Loading preview…';img.style.opacity='.35';loader.hidden=false;
      document.querySelectorAll<HTMLButtonElement>('[data-image]').forEach(b=>{const active=Number(b.dataset.image)===i;b.classList.toggle('selected',active);b.setAttribute('aria-current',String(active))});
      try{const url=await imageURL(meta);const ready=new Image();ready.src=url;await ready.decode();if(sequence!==detailSequence||current!==imageSequence)return;slideImage(img,url,movement);await displayPreview(img,meta.key);img.alt=`${m.title} preview ${i+1} of ${m.images.length}`}
      catch{if(sequence===detailSequence&&current===imageSequence){img.removeAttribute('src');img.alt='Preview unavailable'}}
      finally{if(sequence===detailSequence&&current===imageSequence){loader.hidden=true;img.removeAttribute('aria-busy');img.style.opacity='1'}}
    };
    if(m.images.length)showImage(0);
    document.querySelectorAll<HTMLButtonElement>('[data-image]').forEach(b=>b.onclick=()=>showImage(Number(b.dataset.image)));
    if(many){stepDetailImage=delta=>showImage(currentImage+delta,delta);$('#gallery-prev').onclick=()=>showImage(currentImage-1,-1);$('#gallery-next').onclick=()=>showImage(currentImage+1,1)}
  }catch(e){if(sequence===detailSequence)$('#detail-body').innerHTML=`<div class="empty-state"><h2 id="detail-title">Unable to open this model.</h2><p>${esc((e as Error).message)}</p></div>`}
}
window.addEventListener('popstate',()=>{let path=location.pathname;if(/^\/models(?:\/|$)/.test(path)){path=path.replace(/^\/models/,'/Characters');history.replaceState({},'',path+location.search+location.hash)}const match=path.match(/^\/Characters\/([^/]+)$/);if(match)openModel(decodeURIComponent(match[1]),false);else{detailSequence++;stepDetailImage=null;detail.close()}});
async function start(){
  if(community.active)return;
  if(!['/','/Characters','/Characters/'].includes(location.pathname)&&!location.pathname.match(/^\/Characters\/[^/]+$/)){$('main').innerHTML='<section class="declined"><h1>Nothing here yet.</h1><p>This section is not available.</p><a href="/Characters" class="button primary">Go to collection</a></section>';return}
  load();
  try{
    const facets=await get<Record<string,string[]>>('/api/facets');
    for(const field of ['artist_category','artist_name','media_title','format'] as const){
      if(facets[field])setFilterOptions(field,facets[field]);
    }
    exclusions.setFacets(facets);
    syncCategoryNavigation();
  }catch{exclusions.failFacets()}
  const match=location.pathname.match(/^\/Characters\/([^/]+)$/);if(match)openModel(decodeURIComponent(match[1]),false);
}
window.addEventListener('pagehide',event=>{if(event.persisted)return;clearPreviewURLs()});

// Start only after the observer and request sequence state have initialized.
if(sessionStorage.getItem('my5tb-age')!=='yes')openDialog(age);else start();
