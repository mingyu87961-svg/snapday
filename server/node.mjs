import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDatabase } from './sqlite.mjs';
import { createApi } from './api.mjs';
import { createDeepSeekAI } from './ai.mjs';

const staticRoot = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.wasm':'application/wasm', '.gz':'application/gzip', '.json':'application/json; charset=utf-8', '.txt':'text/plain; charset=utf-8' };
const security = { 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin', 'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; base-uri 'self'; form-action 'self'" };

export async function startServer({ port = Number(process.env.PORT || 4173), host = process.env.HOST || '127.0.0.1', databasePath = process.env.DATABASE_PATH || fileURLToPath(new URL('../data/snapday.sqlite', import.meta.url)), publicOrigin = process.env.PUBLIC_ORIGIN || '' } = {}) {
  if (publicOrigin && !['http:', 'https:'].includes(new URL(publicOrigin).protocol)) throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin');
  const db = createDatabase(databasePath);
  const ai = createDeepSeekAI({ apiKey:process.env.DEEPSEEK_API_KEY || '', model:process.env.DEEPSEEK_MODEL || 'deepseek-flash' });
  const handleApi = createApi({ db, storage: 'sqlite', ai });
  const server = http.createServer(async (incoming, outgoing) => {
    const apiRequest = incoming.url?.startsWith('/api/');
    try {
      const origin = publicOrigin || `http://${incoming.headers.host || '127.0.0.1'}`;
      const url = new URL(incoming.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; let size = 0;
        for await (const chunk of incoming) {
          size += chunk.length;
          if (size > 131072) {
            outgoing.writeHead(413, { ...security, 'Content-Type':'application/json', 'Cache-Control':'no-store' });
            outgoing.end(JSON.stringify({ error:{ code:'BODY_TOO_LARGE', message:'请求内容超过大小限制。' } }));
            return;
          }
          chunks.push(chunk);
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const controller = new AbortController();
        outgoing.once('close', () => { if (!outgoing.writableEnded) controller.abort(); });
        const request = new Request(url, { method:incoming.method, headers, signal:controller.signal, ...(!['GET','HEAD'].includes(incoming.method) ? { body:Buffer.concat(chunks) } : {}) });
        const response = await handleApi(request, { clientIp:incoming.socket.remoteAddress || '' });
        const resultHeaders = { ...security, ...Object.fromEntries(response.headers) };
        if (response.headers.getSetCookie().length) resultHeaders['set-cookie'] = response.headers.getSetCookie();
        outgoing.writeHead(response.status, resultHeaders);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (!['GET','HEAD'].includes(incoming.method)) { outgoing.writeHead(405, security); outgoing.end(); return; }
      const pathname = decodeURIComponent(url.pathname);
      const filename = path.resolve(staticRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!filename.startsWith(staticRoot + path.sep) || pathname.split('/').some(part => part.startsWith('.') && part !== '.nojekyll')) {
        outgoing.writeHead(404, security); outgoing.end('Not found'); return;
      }
      if (!(await stat(filename)).isFile()) throw new Error('Not a file');
      const content = await readFile(filename);
      outgoing.writeHead(200, { ...security, 'Content-Type':types[path.extname(filename)] || 'application/octet-stream', 'Content-Length':content.length, 'Cache-Control':'no-cache' });
      outgoing.end(incoming.method === 'HEAD' ? undefined : content);
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(apiRequest ? 500 : 404, { ...security, 'Content-Type':apiRequest ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control':'no-store' });
      outgoing.end(apiRequest ? JSON.stringify({ error:{code:'INTERNAL_ERROR',message:'服务器暂时无法处理请求，请稍后重试。'} }) : 'Not found');
    }
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
  catch (error) { db.close(); throw error; }
  return { server, db, url:`http://${host}:${server.address().port}`, close:() => new Promise((resolve, reject) => { server.close(error => { db.close(); error ? reject(error) : resolve(); }); server.closeIdleConnections(); }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startServer();
  console.log(`拾刻 Snapday 全栈版: ${app.url}`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
