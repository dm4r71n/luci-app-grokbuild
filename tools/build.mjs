// Bundle src/terminal into one self-contained HTML file for `ttyd -I`.
// ttyd serves only that file, /token, and /ws, so nothing can be a separate asset.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src/terminal');
const out = join(root, 'root/usr/share/grokbuild/www/index.html');

const js = await build({
	entryPoints: [join(src, 'main.js')],
	bundle: true,
	minify: true,
	format: 'iife',
	target: ['chrome100', 'firefox100', 'safari15'],
	write: false,
	legalComments: 'eof',
});
const css = readFileSync(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8') +
	readFileSync(join(src, 'style.css'), 'utf8');
const script = js.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1');

let html = readFileSync(join(src, 'index.html'), 'utf8');
html = html.replace('/*CSS*/', () => css.replace(/<\/(style)/gi, '<\\/$1'));
html = html.replace('/*JS*/', () => script);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${out} ${(html.length / 1024).toFixed(0)} KiB`);
