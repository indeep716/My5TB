interface Env { ASSETS: Fetcher; API: Fetcher }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/admin' || path.startsWith('/api/')) return env.API.fetch(request);
    return env.ASSETS.fetch(request);
  }
};
