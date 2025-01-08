addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

function getTargetDomain(host, ownDomain) {
  return host.split(`.${ownDomain}`)[0];
}

const ownDomain = "b.com";
const contentTypesToProcess = [
  'text/html',
  'text/css',
  'application/javascript',
  'application/x-javascript',
  'text/javascript',
  'application/json',
];

async function handleRequest(request) {
  const url = new URL(request.url);
  const { host, pathname } = url;

  if (pathname === '/robots.txt') {
    const robots = `User-agent: *\nDisallow: /`;
    return new Response(robots, { status: 200 });
  }

  const targetDomain = getTargetDomain(host, ownDomain);
  if (!targetDomain) {
    return new Response('错误的请求：主机中未指定目标域名。', { status: 400 });
  }

  const origin = `https://${targetDomain}`;
  const actualUrl = new URL(origin + pathname + url.search + url.hash);

  console.log('Request URL:', request.url);
  console.log('Target Domain:', targetDomain);
  console.log('Actual URL:', actualUrl.toString());

  const modifiedRequestInit = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    modifiedRequestInit.body = await request.clone().text();
  }

  modifiedRequestInit.headers.set('User-Agent', 'Cloudflare-Worker-Agent');

  const modifiedRequest = new Request(actualUrl.toString(), modifiedRequestInit);

  let response;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000); // 10秒超时
    response = await fetch(modifiedRequest, { signal: controller.signal });
  } catch (error) {
    console.error('Fetch error:', error);
    return new Response('无法访问目标服务器。', { status: 502 });
  }

  console.log('Response Status:', response.status);
  console.log('Response Headers:', response.headers);

  const redirectStatus = [301, 302, 303, 307, 308];
  if (redirectStatus.includes(response.status)) {
    let location = response.headers.get('Location');
    if (location) {
      let locationUrl = new URL(location, actualUrl);
      locationUrl.hostname = host;
      response.headers.set('Location', locationUrl.toString());
    }
  }

  let modifiedResponse;

  const contentType = response.headers.get('content-type') || '';
  if (contentTypesToProcess.some(type => contentType.toLowerCase().includes(type))) {
    let originalText;
    if (contentType.includes('charset=')) {
      const charset = contentType.split('charset=')[1];
      originalText = new TextDecoder(charset).decode(await response.arrayBuffer());
    } else {
      originalText = await response.text();
    }

    let modifiedText = originalText.replace(new RegExp(targetDomain.replace(/\./g, '\\.'), 'g'), host);

    modifiedResponse = new Response(modifiedText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } else {
    modifiedResponse = new Response(response.body, response);
  }

  if (modifiedResponse.headers.has('Set-Cookie')) {
    let cookieHeader = modifiedResponse.headers.get('Set-Cookie');
    let cookieArray = cookieHeader.split(/,(?=\s*[A-Za-z])/);
    cookieArray = cookieArray.map(cookie => {
      return cookie.replace(new RegExp(`Domain=\\s*${targetDomain}`, 'i'), `Domain=${host}`);
    });
    modifiedResponse.headers.set('Set-Cookie', cookieArray.join(', '));
  }

  modifiedResponse.headers.set('Access-Control-Allow-Origin', '*');
  modifiedResponse.headers.delete('Content-Security-Policy');
  modifiedResponse.headers.delete('X-Frame-Options');

  return modifiedResponse;
}
