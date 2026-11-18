const CACHE_NAME = 'itc-field-shell-__BUILD_CACHE__';
const SHELL_URLS = ['/manifest.webmanifest', '/field-source-icon.svg'];

function localAssetPaths(text, expression, basePath = '/') {
  return [...text.matchAll(expression)]
    .map((match) => match[1])
    .filter((path) => path && !path.startsWith('data:'))
    .map((path) => new URL(path, new URL(basePath, self.location.origin)).pathname)
    .filter((path) => path.startsWith('/') && !path.startsWith('/api/'));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const response = await fetch('/', { cache: 'reload' });
    if (!response.ok) throw new Error('The Field Source app shell could not be cached.');
    await cache.put('/', response.clone());
    await cache.put('/index.html', response.clone());
    const html = await response.text();
    const pageAssets = localAssetPaths(html, /(?:src|href)=["']([^"']+)["']/g);
    const cssAssets = [];

    for (const path of pageAssets) {
      if (!path.endsWith('.css')) continue;
      try {
        const cssResponse = await fetch(path, { cache: 'reload' });
        if (!cssResponse.ok) continue;
        await cache.put(path, cssResponse.clone());
        cssAssets.push(...localAssetPaths(await cssResponse.text(), /url\(["']?([^"')]+)["']?\)/g, path));
      } catch {
        // A CSS file that failed to load online is not part of the cached shell.
      }
    }

    const assets = [...new Set([...pageAssets, ...cssAssets, ...SHELL_URLS])];
    await Promise.all(assets.map(async (path) => {
      if (path === '/' || path === '/index.html') return;
      try {
        const asset = await fetch(path, { cache: 'reload' });
        if (asset.ok && asset.type !== 'opaque') await cache.put(path, asset);
      } catch {
        // Keep the shell installable if a non-critical asset is unavailable.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('itc-field-shell-') && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
      return response;
    } catch (error) {
      if (request.mode === 'navigate') {
        const shell = await cache.match('/index.html') ?? await cache.match('/');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
