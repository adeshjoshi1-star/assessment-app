const ORIGIN = new URL('https://assessment-app-production-74d9.up.railway.app');

export default {
  async fetch(request) {
    const clientUrl = new URL(request.url);
    const upstreamUrl = new URL(clientUrl.pathname + clientUrl.search, ORIGIN);
    const headers = new Headers(request.headers);

    // The browser talks only to workers.dev. Rewrite same-origin headers so
    // Railway's CSRF protection still validates every state-changing request.
    headers.set('origin', ORIGIN.origin);
    const referer = headers.get('referer');
    if (referer) {
      const refererUrl = new URL(referer);
      headers.set('referer', ORIGIN.origin + refererUrl.pathname + refererUrl.search);
    }

    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamRequest);
    } catch (error) {
      return Response.json(
        { error: 'Assessment portal is temporarily unavailable' },
        { status: 502, headers: { 'cache-control': 'no-store' } },
      );
    }

    const response = new Response(upstreamResponse.body, upstreamResponse);
    response.headers.set('cache-control', 'no-store');
    response.headers.set('x-assessment-proxy', 'cloudflare');

    const location = response.headers.get('location');
    if (location && location.startsWith(ORIGIN.origin)) {
      response.headers.set('location', clientUrl.origin + location.slice(ORIGIN.origin.length));
    }

    return response;
  },
};
