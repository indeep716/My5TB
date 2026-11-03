// Cloudflare Pages proxy: API stays same-origin, avoiding browser token/CORS leakage.
interface Bindings {API:Fetcher}
export const onRequest:PagesFunction<Bindings>=async context=>{
  if(!context.env.API)return new Response('API service binding is not configured',{status:503,headers:{'X-Robots-Tag':'noindex, nofollow'}});
  return context.env.API.fetch(context.request);
};
