interface Bindings {API:Fetcher}
export const onRequest:PagesFunction<Bindings>=async context=>context.env.API?context.env.API.fetch(context.request):new Response('API service binding is not configured',{status:503});
