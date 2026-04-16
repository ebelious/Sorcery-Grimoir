export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    // Get channel_id from query string: ?channel_id=UCxxxxxxx
    const channelId = url.searchParams.get('channel_id');
    if (!channelId) {
      return new Response('Sorcery Grimoire YT RSS Proxy — use ?channel_id=UCxxxxxx', {
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

    const resp = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RSS Reader)',
        'Accept': 'application/atom+xml, application/xml, text/xml',
      }
    });

    const body = await resp.text();

    return new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/xml',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      }
    });
  }
};
