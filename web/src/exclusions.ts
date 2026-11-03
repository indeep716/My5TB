import './exclusions.css';

const fields=['source','world','character','filename','artist'] as const;
type Field=typeof fields[number];
const labels:Record<Field,string>={source:'Source',world:'World / series',character:'Character',filename:'Filename',artist:'Artist'};
const facets:Record<Field,string>={source:'artist_category',world:'media_title',character:'character_name',filename:'filename',artist:'artist_name'};
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const symbol=(name:string)=>`<span class="material-symbols-outlined" aria-hidden="true">${name}</span>`;

export function exclusionsMarkup(){
  return `<details id="advanced-filters" class="advanced-filters"><summary><span>Advanced</span><span id="exclude-count" class="exclude-count" aria-label="0 exclusions">0</span>${symbol('expand_more')}</summary><div class="advanced-body"><p id="exclude-status" class="exclude-status" role="status" aria-live="polite">Loading suggestions… You can type a name.</p>${fields.map(field=>`<div class="exclude-group" data-exclude-group="${field}"><label class="technical" for="exclude-${field}">Exclude ${labels[field]}</label><div class="exclude-combo"><input id="exclude-${field}" type="text" role="combobox" aria-label="Exclude ${labels[field].toLowerCase()}" aria-expanded="false" aria-controls="exclude-${field}-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" maxlength="200" placeholder="Choose or type…"><button type="button" class="exclude-toggle" aria-label="Browse excluded ${labels[field].toLowerCase()} options">${symbol('expand_more')}</button><button type="button" class="exclude-add" aria-label="Add excluded ${labels[field].toLowerCase()}" disabled>${symbol('add')}</button><ul id="exclude-${field}-list" class="exclude-options" role="listbox" aria-label="${labels[field]} suggestions" hidden></ul></div><div class="exclude-tags" aria-label="Excluded ${labels[field].toLowerCase()}"></div></div>`).join('')}</div></details>`;
}

export function setupExclusions(onChange:()=>void,closeOtherCombos:()=>void){
  const section=document.querySelector<HTMLDetailsElement>('#advanced-filters')!;
  const selected:Record<Field,string[]>={source:[],artist:[],world:[],character:[],filename:[]};
  const suggestions:Record<Field,string[]>={source:[],artist:[],world:[],character:[],filename:[]};
  const status=section.querySelector<HTMLElement>('#exclude-status')!;
  const input=(field:Field)=>section.querySelector<HTMLInputElement>('#exclude-'+field)!;
  const group=(field:Field)=>section.querySelector<HTMLElement>(`[data-exclude-group="${field}"]`)!;
  const list=(field:Field)=>section.querySelector<HTMLUListElement>('#exclude-'+field+'-list')!;
  const key=(value:string)=>value.toLocaleLowerCase();
  function close(except?:Field){for(const field of fields)if(field!==except){list(field).hidden=true;input(field).setAttribute('aria-expanded','false');input(field).removeAttribute('aria-activedescendant')}}
  function renderTags(field:Field){
    const tags=group(field).querySelector<HTMLElement>('.exclude-tags')!;
    tags.innerHTML=selected[field].length?selected[field].map((value,index)=>`<button type="button" class="exclude-tag" data-index="${index}" title="${escape(value)}" aria-label="Remove excluded ${labels[field].toLowerCase()} ${escape(value)}"><span>${escape(value)}</span>${symbol('close')}</button>`).join(''):'<span class="exclude-none">No exclusions</span>';
    tags.querySelectorAll<HTMLButtonElement>('.exclude-tag').forEach(button=>button.onclick=()=>{
      const index=Number(button.dataset.index);selected[field].splice(index,1);renderTags(field);updateCount();
      (tags.querySelectorAll<HTMLButtonElement>('.exclude-tag')[Math.min(index,selected[field].length-1)]||input(field)).focus();onChange();
    });
    const add=group(field).querySelector<HTMLButtonElement>('.exclude-add')!;
    add.disabled=!input(field).value.trim()||selected[field].length>=20;
  }
  function updateCount(){const count=fields.reduce((sum,field)=>sum+selected[field].length,0);const badge=section.querySelector('#exclude-count')!;badge.textContent=String(count);badge.setAttribute('aria-label',`${count} exclusions`)}
  function add(field:Field,value:string){
    value=value.trim();if(!value)return;
    if(value.length>200){status.textContent='Use 200 characters or fewer per exclusion.';return}
    if(selected[field].some(item=>key(item)===key(value))){status.textContent='That name is already excluded.';return}
    if(selected[field].length>=20){status.textContent='You can exclude up to 20 names in each field.';return}
    selected[field].push(value);input(field).value='';close();renderTags(field);updateCount();
    status.textContent=`Excluded ${labels[field].toLowerCase()}: ${value}`;input(field).focus();close();onChange();
  }
  function open(field:Field){
    closeOtherCombos();close(field);
    const query=key(input(field).value.trim()),options=suggestions[field].filter(value=>(!query||key(value).includes(query))&&!selected[field].some(item=>key(item)===key(value))).slice(0,100);
    const listbox=list(field);
    listbox.innerHTML=options.map((value,index)=>`<li id="exclude-${field}-option-${index}" role="option" aria-selected="false" data-value="${escape(value)}"><span>${escape(value)}</span></li>`).join('')+(!options.length?'<li class="exclude-option-empty" role="presentation">Type a name and press Enter</li>':'');
    listbox.hidden=false;input(field).setAttribute('aria-expanded','true');input(field).removeAttribute('aria-activedescendant');
    listbox.querySelectorAll<HTMLElement>('[role="option"]').forEach(option=>{
      option.onmousedown=event=>event.preventDefault();option.onclick=()=>add(field,option.dataset.value!);
    });
    const addButton=group(field).querySelector<HTMLButtonElement>('.exclude-add')!;addButton.disabled=!query||selected[field].length>=20;
  }
  for(const field of fields){
    const control=input(field),container=group(field);
    renderTags(field);
    control.addEventListener('input',()=>open(field));control.addEventListener('focus',()=>open(field));control.addEventListener('click',()=>{if(list(field).hidden)open(field)});
    control.addEventListener('keydown',event=>{
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){
        event.preventDefault();if(list(field).hidden)open(field);
        const options=[...list(field).querySelectorAll<HTMLElement>('[role="option"]')];if(!options.length)return;
        const current=options.findIndex(option=>option.id===control.getAttribute('aria-activedescendant'));
        const next=current<0?(event.key==='ArrowUp'?options.length-1:0):(current+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;
        options.forEach((option,index)=>{option.classList.toggle('active',index===next);option.setAttribute('aria-selected',String(index===next))});control.setAttribute('aria-activedescendant',options[next].id);options[next].scrollIntoView({block:'nearest'});
      }else if(event.key==='Enter'){
        event.preventDefault();const active=control.getAttribute('aria-activedescendant');const option=active?document.getElementById(active):null;
        add(field,option?.dataset.value||control.value);
      }else if(event.key==='Escape'&&!list(field).hidden){event.preventDefault();event.stopPropagation();close()}
    });
    container.addEventListener('focusout',event=>{if(!container.contains(event.relatedTarget as Node|null))close()});
    container.querySelector<HTMLButtonElement>('.exclude-add')!.onclick=()=>add(field,control.value);
    container.querySelector<HTMLButtonElement>('.exclude-toggle')!.onclick=()=>{if(list(field).hidden){control.focus();open(field)}else close()};
  }
  document.addEventListener('mousedown',event=>{if(!(event.target as Element).closest('.exclude-combo'))close()});
  section.addEventListener('toggle',()=>{if(!section.open)close()});
  return {
    append(params:URLSearchParams){for(const field of fields)for(const value of selected[field])params.append('exclude_'+field,value)},
    reset(){for(const field of fields){selected[field]=[];input(field).value='';renderTags(field)}close();updateCount();status.textContent='Exclusions cleared.'},
    setFacets(values:Record<string,string[]>){for(const field of fields)suggestions[field]=values[facets[field]]||[];status.textContent=''},
    failFacets(){status.textContent='Suggestions unavailable. Type a name and press Enter.'},
    close,
  };
}
