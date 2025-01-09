addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

/**
 * 获取目标域名
 * @param {string} host - 请求的主机名（如 a.com.b.com）
 * @param {string} ownDomain - 自己的域名（如 b.com）
 * @returns {string} - 目标域名（如 a.com）
 */
function getTargetDomain(host, ownDomain) {
  // 移除自己的域名部分
  return host.replace(`.${ownDomain}`, '');
}

const ownDomain = "b.com";
const contentTypesToProcess = [
  'text/html',
  'text/css',
  'application/javascript',
  'application/x-javascript',
  'text/javascript',
];

// 定义允许访问的国家和地区列表
const allowedCountries = ['CN', 'DE']; // 例如，只允许中国大陆和德国访问

async function handleRequest(request) {
  // 检查是否允许访问
  if (!request.cf.country || !allowedCountries.includes(request.cf.country)) {
    return new Response('Access denied for your country.', { status: 403 });
  }

  const url = new URL(request.url);
  const { host, pathname } = url;

  // 处理 robots.txt
  if (pathname === '/robots.txt') {
    const robots = `User-agent: *\nDisallow: /`;
    return new Response(robots, { status: 200 });
  }

  // 获取目标域名
  const targetDomain = getTargetDomain(host, ownDomain);
  if (!targetDomain) {
    return new Response('错误的请求：主机中未指定目标域名。', { status: 400 });
  }

  // 判断是否是子域名（如 dl.dmhy.org）
  const isSubdomain = targetDomain.split('.').length > 2; // 如果包含多个点，则是子域名
  let actualUrl;

  if (isSubdomain) {
    // 如果是子域名，直接访问目标服务器
    actualUrl = new URL(`https://${targetDomain}${pathname}${url.search}${url.hash}`);
  } else {
    // 如果是主域名，通过代理处理
    const origin = `https://${targetDomain}`;
    actualUrl = new URL(origin + pathname + url.search + url.hash);
  }

  // 创建修改后的请求
  const modifiedRequestInit = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: 'manual',
    body: request.body, // 使用原始 body 流
  };

  modifiedRequestInit.headers.set('User-Agent', 'Cloudflare-Worker-Agent');

  const modifiedRequest = new Request(actualUrl.toString(), modifiedRequestInit);

  // 发起请求
  let response;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000); // 10秒超时
    response = await fetch(modifiedRequest, { signal: controller.signal });
  } catch (error) {
    console.error('Fetch error:', error);
    return new Response('无法访问目标服务器。', { status: 502 });
  }

  // 处理重定向
  const redirectStatus = [301, 302, 303, 307, 308];
  if (redirectStatus.includes(response.status)) {
    let location = response.headers.get('Location');
    if (location) {
      let locationUrl = new URL(location, actualUrl);
      locationUrl.hostname = host; // 将重定向的域名替换为代理域名
      response.headers.set('Location', locationUrl.toString());
    }
  }

  // 处理响应内容
  let modifiedResponse;

  const contentType = response.headers.get('content-type') || '';
  if (contentTypesToProcess.some(type => contentType.toLowerCase().includes(type))) {
    let originalText;
    if (contentType.includes('charset=')) {
      const charset = contentType.split('charset=')[1].split(';')[0].trim();
      originalText = new TextDecoder(charset).decode(await response.arrayBuffer());
    } else {
      originalText = await response.text();
    }

    // 只替换主域名（如 dmhy.org），而不替换子域名（如 dl.dmhy.org）
    const mainDomainRegex = new RegExp(`(https?:\\/\\/|^)${targetDomain.replace(/\./g, '\\.')}(\\/|$)`, 'g');
    let modifiedText = originalText.replace(mainDomainRegex, `$1${host}$2`);

    modifiedResponse = new Response(modifiedText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } else {
    modifiedResponse = new Response(response.body, response);
  }

  // 处理 Set-Cookie 头
  if (modifiedResponse.headers.has('Set-Cookie')) {
    let cookieHeader = modifiedResponse.headers.get('Set-Cookie');
    let cookieArray = cookieHeader.split(/,(?=\s*[A-Za-z])/);
    cookieArray = cookieArray.map(cookie => {
      return cookie.replace(new RegExp(`Domain=\\s*${targetDomain}`, 'i'), `Domain=${host}`);
    });
    modifiedResponse.headers.set('Set-Cookie', cookieArray.join(', '));
  }

  // 设置 CORS 和其他头
  modifiedResponse.headers.set('Access-Control-Allow-Origin', '*');
  modifiedResponse.headers.delete('Content-Security-Policy');
  modifiedResponse.headers.delete('X-Frame-Options');

  return modifiedResponse;
}
