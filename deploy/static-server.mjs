import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const root = resolve(Bun.env.STATIC_ROOT ?? '/app/public');
const apiOrigin = Bun.env.API_ORIGIN ?? 'http://api:4009';
const port = Number(Bun.env.PORT ?? 3000);

const contentTypes = new Map([
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

Bun.serve({
  hostname: '0.0.0.0',
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // Finalizing an upload can wait on object storage without producing a response byte.
      server.timeout(request, 255);
      const apiPath = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
      const upstream = new URL(`${apiPath}${url.search}`, apiOrigin);
      return fetch(new Request(upstream, request));
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Invalid path', { status: 400 });
    }
    const filePath = resolve(root, `.${pathname}`);
    const fromRoot = relative(root, filePath);
    if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
      return new Response('Invalid path', { status: 400 });
    }

    let file = Bun.file(filePath);
    if (!(await file.exists())) {
      if (pathname.startsWith('/assets/') || extname(pathname)) {
        return new Response('Not found', { status: 404 });
      }
      file = Bun.file(resolve(root, 'index.html'));
    }
    if (!(await file.exists())) return new Response('App shell not found', { status: 404 });

    const headers = new Headers({
      'Content-Type': contentTypes.get(extname(pathname)) ?? file.type ?? 'application/octet-stream'
    });
    if (pathname === '/' || pathname === '/index.html' || pathname === '/sw.js' || pathname === '/manifest.webmanifest') {
      headers.set('Cache-Control', 'no-cache');
    } else if (pathname.startsWith('/assets/')) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
    return new Response(file, { headers });
  }
});

console.log(`Static React app listening on port ${port}; API proxy is ${apiOrigin}.`);
