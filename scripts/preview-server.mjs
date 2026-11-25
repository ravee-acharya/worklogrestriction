// Dependency-free static server for the preview build.
//   npm run preview   ->  http://localhost:4599/admin/  and  /panel/
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PREVIEW_PORT ?? 4599);
// fileURLToPath, not .pathname — the project path contains spaces, which
// pathname leaves percent-encoded.
const ROOT = fileURLToPath(new URL('../preview/', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://localhost:${PORT}`);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';

    // Keep the server inside preview/.
    const resolved = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(resolved);

    response.writeHead(200, {
      'Content-Type': TYPES[extname(resolved)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`preview: http://localhost:${PORT}/admin/  and  http://localhost:${PORT}/panel/`);
  console.log('panel scenarios: ?scenario=grace|violation|compliant|disabled|error');
});
