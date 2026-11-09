// Serves the production build the way Render serves it, using the routes and headers of
// render.yaml: a real file wins, otherwise the first matching rewrite applies, and header
// rules match the request path. For local checks only (npm run serve:dist, check:csp).
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Reads the static site's publish path, rewrites and headers from render.yaml. */
export async function loadSite() {
  const { services } = parse(await readFile(join(REPO_ROOT, 'render.yaml'), 'utf8'));
  const site = services.find((service) => service.runtime === 'static');
  const routes = site.routes ?? [];
  const unsupported = routes.find((route) => route.type !== 'rewrite');
  if (unsupported) {
    throw new Error(`serve-dist does not implement ${unsupported.type} routes`);
  }
  return {
    root: resolve(REPO_ROOT, site.staticPublishPath),
    rewrites: routes.map(({ source, destination }) => ({ matches: matcher(source), destination })),
    headers: (site.headers ?? []).map(({ path, name, value }) => ({
      matches: matcher(path),
      name,
      value,
    })),
  };
}

/**
 * Render's path patterns, as far as render.yaml uses them: a trailing `/*` matches every
 * path below it, any other `*` matches within one path segment.
 */
function matcher(pattern) {
  if (pattern.includes('**')) {
    throw new Error(`serve-dist does not implement ** patterns: ${pattern}`);
  }
  if (pattern.endsWith('/*') && !pattern.slice(0, -1).includes('*')) {
    const prefix = pattern.slice(0, -1);
    return (path) => path.startsWith(prefix);
  }
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`^${escaped.join('[^/]*')}$`);
  return (path) => regex.test(path);
}

/** The file at a URL path inside `root`, or null. A directory serves its index.html. */
async function fileAt(root, urlPath) {
  const path = resolve(root, `.${urlPath}`);
  if (path !== root && !path.startsWith(root + sep)) {
    return null;
  }
  const stats = await stat(path).catch(() => null);
  if (stats?.isDirectory()) {
    return fileAt(root, join(urlPath, 'index.html').replaceAll(sep, '/'));
  }
  return stats?.isFile() ? path : null;
}

async function respond(site, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  let file = await fileAt(site.root, urlPath);
  if (file === null) {
    const rewrite = site.rewrites.find(({ matches }) => matches(urlPath));
    file = rewrite ? await fileAt(site.root, rewrite.destination) : null;
  }
  // Matched on the request path, not the rewritten file. A later match for the same header
  // replaces an earlier one.
  for (const { matches, name, value } of site.headers) {
    if (matches(urlPath)) {
      response.setHeader(name, value);
    }
  }
  if (file === null) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  const body = await readFile(file);
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': body.length,
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

/** Starts the server on `port` (0 = any free port) and resolves with its origin. */
export async function serveDist(site, port = 0) {
  // One bad request (a malformed URL, a file removed mid-request) must not stop the server.
  const server = createServer((request, response) =>
    respond(site, request, response).catch((error) => {
      response.writeHead(error instanceof URIError ? 400 : 500).end();
    }),
  );
  await new Promise((done) => server.listen(port, '127.0.0.1', done));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

if (import.meta.main) {
  const site = await loadSite();
  await stat(join(site.root, 'index.html')).catch(() => {
    console.error(`No build in ${site.root}. Run \`npm run build\` first.`);
    process.exit(1);
  });
  const { origin } = await serveDist(site, Number(process.env.PORT ?? 4300));
  console.log(`Serving ${site.root} with the render.yaml routes and headers at ${origin}`);
}
