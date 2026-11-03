// Direction-sensitive mobile header. Scroll sampling stays off the layout path.
export function setupHeaderScroll(){
  const element=document.querySelector<HTMLElement>('.header');
  if(!element)return;
  const header:HTMLElement=element;
  const mobile=matchMedia('(max-width: 1280px)');
  let previous=Math.max(0,scrollY),direction=0,distance=0,queued=false;
  function sample(){
    queued=false;
    const current=Math.max(0,Math.min(scrollY,document.documentElement.scrollHeight-innerHeight));
    const delta=current-previous;previous=current;
    if(!mobile.matches||current<80||document.querySelector('dialog[open]')||header.contains(document.activeElement)){
      header.classList.remove('header-hidden');distance=0;direction=0;return;
    }
    if(!delta)return;
    const next=Math.sign(delta);if(next!==direction){distance=0;direction=next}
    distance+=Math.abs(delta);
    if(next<0&&distance>=3)header.classList.remove('header-hidden');
    else if(next>0&&distance>=12)header.classList.add('header-hidden');
  }
  function schedule(){if(!queued){queued=true;requestAnimationFrame(sample)}}
  addEventListener('scroll',schedule,{passive:true});
  mobile.addEventListener('change',()=>{header.classList.remove('header-hidden');previous=Math.max(0,scrollY);distance=0;direction=0});
  header.addEventListener('focusin',()=>header.classList.remove('header-hidden'));
  new MutationObserver(()=>{if(document.querySelector('dialog[open]'))header.classList.remove('header-hidden')}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
}
