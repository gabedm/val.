import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const port = Number(process.env.VAL_PREVIEW_PORT || 13208);
const fonts = new URL('../assets/fonts/', root);
const logos = new URL('logos/', root);
const logoManifest = JSON.parse(await readFile(new URL('manifest.json', logos)));
const files = new Map([
  ['/', [new URL('index.html', root), 'text/html']],
  ['/index.html', [new URL('index.html', root), 'text/html']],
  ['/styles.css', [new URL('styles.css', root), 'text/css']],
  ['/app.js', [new URL('app.js', root), 'text/javascript']],
  ['/catalogue.json', [new URL('../catalogue/catalogue.json', root), 'application/json']],
  ['/logos/manifest.json', [new URL('manifest.json', logos), 'application/json']],
  ['/fonts/Arimo-Regular.ttf', [new URL('Arimo-Regular.ttf', fonts), 'font/ttf']],
  ['/fonts/Arimo-Bold.ttf', [new URL('Arimo-Bold.ttf', fonts), 'font/ttf']],
]);
for (const logo of logoManifest.records) {
  if (!/^[a-z0-9-]+\.(svg|png|jpg)$/.test(logo.file)) throw new Error('Invalid logo file');
  const type = { svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg' }[logo.file.split('.').pop()];
  files.set(`/logos/${logo.file}`, [new URL(logo.file, logos), type]);
}

createServer(async (request, response) => {
  const file = files.get(new URL(request.url, 'http://localhost').pathname);
  if (!file) { response.writeHead(404); response.end('Not found'); return; }
  try {
    const contents = await readFile(fileURLToPath(file[0]));
    response.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(contents);
  } catch {
    response.writeHead(500);
    response.end('Unable to load design preview');
  }
}).listen(port, '127.0.0.1', () => console.log(`Val design preview: http://127.0.0.1:${port}`));
