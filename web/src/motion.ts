const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const running = new WeakMap<Element, Animation>();
const imageTransitions = new WeakMap<HTMLImageElement, () => void>();
export function slideImage(image: HTMLImageElement, url: string, direction: number) {
  imageTransitions.get(image)?.();
  const previous=image.getAttribute('src');
  if (!previous || previous===url || reduced()) { image.src=url; return; }
  const outgoing=image.cloneNode() as HTMLImageElement;
  outgoing.removeAttribute('id');outgoing.removeAttribute('aria-busy');
  outgoing.className='gallery-outgoing';outgoing.alt='';outgoing.setAttribute('aria-hidden','true');outgoing.style.opacity='1';
  image.before(outgoing);image.src=url;
  const sign=direction<0?-1:1;
  const options={duration:220,easing:'cubic-bezier(.2,0,0,1)'};
  const leave=outgoing.animate([{transform:'translateX(0)'},{transform:`translateX(${-sign*100}%)`}],options);
  const enter=image.animate([{transform:`translateX(${sign*100}%)`},{transform:'translateX(0)'}],options);
  const cleanup=()=>{leave.cancel();enter.cancel();outgoing.remove();if(imageTransitions.get(image)===cleanup)imageTransitions.delete(image)};
  imageTransitions.set(image,cleanup);
  void Promise.all([leave.finished,enter.finished]).then(cleanup,cleanup);
}
export function reveal(element: Element) {
  running.get(element)?.cancel();
  if (reduced()) return;
  const animation = element.animate([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:180,easing:'cubic-bezier(.2,0,0,1)'});
  running.set(element,animation);
}
export function openDialog(dialog: HTMLDialogElement) {
  running.get(dialog)?.cancel();
  if (!dialog.open) dialog.showModal();
  reveal(dialog);
}
export async function closeDialog(dialog: HTMLDialogElement) {
  if (!dialog.open) return;
  running.get(dialog)?.cancel();
  if (!reduced()) {
    const animation=dialog.animate([{opacity:1},{opacity:0}],{duration:150,easing:'cubic-bezier(.4,0,1,1)'});
    running.set(dialog,animation);
    try { await animation.finished; } catch { return; }
    if(running.get(dialog)!==animation)return;
  }
  dialog.close();
}
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',event=>{if(event.matches)document.getAnimations().forEach(animation=>{try{animation.finish()}catch{animation.cancel()}})});
