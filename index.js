// Cloudflare Worker 脚本 - 带有 URL 重写和重定向处理的反向代理

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

/**
 * 从主机名中提取目标域名，移除 ownDomain 后缀。
 * @param {string} host - 请求中的主机头。
 * @param {string} ownDomain - Worker 运行的自身域名。
 * @returns {string} - 请求应代理到的目标域名。
 */
function getTargetDomain(host, ownDomain) {
  return host.split(`.${ownDomain}`)[0];
}

// 您的 Worker 部署的自身域名。
const ownDomain = "b.com";

// 修改此列表以包含需要处理的内容类型
const contentTypesToProcess = [
  'text/html',
  'text/css',
  'application/javascript',
  'application/x-javascript',
  'text/javascript',
  'application/json',
  // 如有需要，添加更多内容类型
];

async function handleRequest(request) {
  const url = new URL(request.url);
  const { host, pathname } = url;

  // 处理代理域名的 robots.txt
  if (pathname === '/robots.txt') {
    const robots = `User-agent: *
Disallow: /
    `;
    return new Response(robots, { status: 200 });
  }

  // 从主机名中提取目标域名
  const targetDomain = getTargetDomain(host, ownDomain);

  if (!targetDomain) {
    // 如果未找到目标域名，返回错误响应
    return new Response('错误的请求：主机中未指定目标域名。', { status: 400 });
  }

  const origin = `https://${targetDomain}`;
  const actualUrl = new URL(origin + pathname + url.search + url.hash);

  // 创建到目标域名的新请求，保留方法和头部信息
  const modifiedRequestInit = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: 'manual', // 设置为 'manual'，以便我们可以处理重定向
  };

  // 如有需要，克隆请求体
  if (!['GET', 'HEAD'].includes(request.method)) {
    modifiedRequestInit.body = await request.clone().arrayBuffer();
  }

  // 删除 'Accept-Encoding' 头部，因为编码由客户端处理
  modifiedRequestInit.headers.delete('Accept-Encoding');

  // 创建到目标域的新请求
  const modifiedRequest = new Request(actualUrl.toString(), modifiedRequestInit);

  // 获取目标 URL
  let response = await fetch(modifiedRequest);

  // 如果响应是重定向，手动跟踪并修改 Location 头部
  const redirectStatus = [301, 302, 303, 307, 308];
  if (redirectStatus.includes(response.status)) {
    let location = response.headers.get('Location');
    if (location) {
      // 将绝对 URL 转换成相对于目标域名的 URL
      let locationUrl = new URL(location, actualUrl);

      // 将目标域名替换为代理域名
      if (locationUrl.hostname.endsWith(targetDomain)) {
        locationUrl.hostname = locationUrl.hostname.replace(targetDomain, host);
      } else {
        // 如果重定向到其他域名，可以根据需要处理，或者直接返回
      }

      // 创建新的响应，修改 Location 头部
      response = new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
      response.headers.set('Location', locationUrl.toString());
    }
  }

  // 克隆响应以进行修改
  let modifiedResponse;

  const contentType = response.headers.get('content-type');

  // 检查内容类型是否存在并匹配需要处理的类型
  if (contentType && contentTypesToProcess.some(type => contentType.includes(type))) {
    // 处理响应体
    const originalText = await response.text();

    let modifiedText = originalText;

    // 将所有目标域名的实例替换为代理域名
    const regex = new RegExp(targetDomain.replace(/\./g, '\\.'), 'g');

    modifiedText = modifiedText.replace(regex, host);

    // 使用修改后的文本创建新的响应
    modifiedResponse = new Response(modifiedText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } else {
    // 如果不需要处理，返回原始响应
    modifiedResponse = new Response(response.body, response);
  }

  // 处理 Set-Cookie 头部，将 Domain 修改为代理域名
  if (modifiedResponse.headers.has('Set-Cookie')) {
    let cookieHeader = modifiedResponse.headers.get('Set-Cookie');

    // 处理多个 Set-Cookie 头部
    let cookieArray = cookieHeader.split(',');
    cookieArray = cookieArray.map(cookie => {
      // 将 Domain=targetDomain 替换为 Domain=host
      return cookie.replace(new RegExp(`Domain=${targetDomain}`, 'i'), `Domain=${host}`);
    });

    // 删除原有的 Set-Cookie 头部
    modifiedResponse.headers.delete('Set-Cookie');

    // 重新设置修改后的 Set-Cookie 头部
    cookieArray.forEach(cookie => {
      modifiedResponse.headers.append('Set-Cookie', cookie.trim());
    });
  }

  // 如有需要，添加 CORS 头部
  modifiedResponse.headers.set('Access-Control-Allow-Origin', '*');

  // 删除或修改可能导致问题的头部
  modifiedResponse.headers.delete('Content-Security-Policy');
  modifiedResponse.headers.delete('X-Frame-Options');

  // 返回修改后的响应
  return modifiedResponse;
}
