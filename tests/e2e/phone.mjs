// End-to-end check of the terminal page against the live test ttyd, with a
// Pixel 7 emulated in headless Chromium. Needs .spike-credential and ssh access
// to the router (for tmux capture-pane). Sends only keys that do not submit a
// prompt: taps, wheel, Esc, arrows, Ctrl+U.
//
//   GB_URL=https://100.104.188.37:7682/ GB_SSH="ssh root@router" node tests/e2e/phone.mjs
import { chromium, devices } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';

const URL_ = process.env.GB_URL || 'https://100.104.188.37:7682/';
const SSH = (process.env.GB_SSH || 'ssh -o BatchMode=yes -o UserKnownHostsFile=/workspace/.ssh/known_hosts -i /workspace/.ssh/openwrt root@100.104.188.37').split(' ');
const SHOTS = process.env.GB_SHOTS || '/workspace/luci-app-grokbuild-shots';
const [username, password] = readFileSync(new URL('../../.spike-credential', import.meta.url), 'utf8').trim().split(/:(.*)/s);
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok: !!ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const router = (cmd) => execFileSync(SSH[0], [...SSH.slice(1), cmd], { encoding: 'utf8' });
const tmux = (args) => router(`tmux -L grokbuild ${args}`);
const capture = () => tmux('capture-pane -p -t grok');
const paneInfo = () => tmux('list-panes -t grok -F "#{pane_width}x#{pane_height} #{pane_current_command} alt=#{alternate_on} mouse=#{mouse_any_flag}"').trim();

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });

async function openPage(ctxOpts) {
	const ctx = await browser.newContext({
		...ctxOpts,
		httpCredentials: { username, password },
		ignoreHTTPSErrors: true,
	});
	await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(URL_).origin });
	// Chromium's device-scale emulation does not scale ResizeObserver's
	// devicePixelContentBoxSize, so xterm's WebGL and canvas renderers draw at
	// 1/DPR size under emulation. A real phone reports device pixels. Make xterm
	// use its css * devicePixelRatio fallback, which matches a real device.
	await ctx.addInitScript(() => {
		const observe = ResizeObserver.prototype.observe;
		ResizeObserver.prototype.observe = function (el, opts) {
			if (opts && String(opts.box).includes('device-pixel')) throw new Error('not under emulation');
			return observe.call(this, el, opts);
		};
	});
	const page = await ctx.newPage();
	const sent = [];
	const sockets = [];
	const external = [];
	page.on('request', (r) => { if (!r.url().startsWith(new URL(URL_).origin)) external.push(r.url()); });
	page.on('websocket', (ws) => {
		sockets.push(ws);
		ws.on('framesent', (f) => sent.push(Buffer.isBuffer(f.payload) ? f.payload.toString('utf8') : String(f.payload)));
	});
	page.on('pageerror', (e) => console.log('pageerror', e.message));
	await page.goto(URL_);
	await page.waitForFunction(() => window.__gb && window.__gb.conn.open, null, { timeout: 15000 });
	await page.waitForFunction(() => /Grok|❯/.test(window.__gb.screenText()), null, { timeout: 15000 });
	await sleep(800);
	return { ctx, page, sent, sockets, external };
}

// CDP touch helpers (CSS pixels).
async function touchCtl(page) {
	const cdp = await page.context().newCDPSession(page);
	const t = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
	return {
		async tap(x, y, hold = 60) { await t('touchStart', [{ x, y }]); await sleep(hold); await t('touchEnd', []); },
		async swipe(x, y0, y1, ms, steps = 20) {
			await t('touchStart', [{ x, y: y0 }]);
			for (let i = 1; i <= steps; i++) {
				await sleep(ms / steps);
				await t('touchMove', [{ x, y: y0 + ((y1 - y0) * i) / steps }]);
			}
			await t('touchEnd', []);
		},
		async pinch(cx, cy, d0, d1, steps = 10) {
			await t('touchStart', [{ x: cx - d0 / 2, y: cy, id: 0 }, { x: cx + d0 / 2, y: cy, id: 1 }]);
			for (let i = 1; i <= steps; i++) {
				const d = d0 + ((d1 - d0) * i) / steps;
				await sleep(16);
				await t('touchMove', [{ x: cx - d / 2, y: cy, id: 0 }, { x: cx + d / 2, y: cy, id: 1 }]);
			}
			await t('touchEnd', []);
		},
	};
}
const cellXY = (page, col, row) => page.evaluate(([c, r]) => {
	const s = document.querySelector('#term .xterm-screen').getBoundingClientRect();
	const t = window.__gb.term;
	return { x: s.left + (c - 0.5) * s.width / t.cols, y: s.top + (r - 0.5) * s.height / t.rows };
}, [col, row]);
const termSize = (page) => page.evaluate(() => ({ cols: window.__gb.term.cols, rows: window.__gb.term.rows }));
const since = (arr, n) => arr.slice(n);
const wheels = (frames) => frames.join('').match(/\x1b\[<6[45];\d+;\d+M/g) || [];

// GB_FRESH=1 restarts grok in the pane so its welcome screen (with the
// Changelog item to tap and scroll) is showing. Only use it when grok is idle.
if (process.env.GB_FRESH === '1') {
	tmux('respawn-pane -k -t grok');
	await sleep(4000);
}

// ---------------- phone ----------------
const phone = await openPage({ ...devices['Pixel 7'] });
const { page, sent, sockets } = phone;
const touch = await touchCtl(page);

check('page uses only its own origin', phone.external.length === 0, phone.external.join(', '));
check('renderer is webgl', (await page.evaluate(() => window.__gb.renderer())) === 'webgl');
const ws0 = sent.find((f) => f.startsWith('{'));
check('auth message sent with size', ws0 && /"AuthToken"/.test(ws0) && /"columns":\d+/.test(ws0));
let size = await termSize(page);
let pane = paneInfo();
check('tmux pane matches the phone grid', pane.startsWith(`${size.cols}x${size.rows}`), `page ${size.cols}x${size.rows}, pane ${pane}`);
check('font size default 13 on touch', (await page.evaluate(() => window.__gb.term.options.fontSize)) === 13);
check('key bar visible on touch', await page.isVisible('#bar'));
await page.screenshot({ path: `${SHOTS}/01-phone-portrait.png` });

// Tap a menu item ("Changelog") to check tap = click at the right cell.
let text = await page.evaluate(() => window.__gb.screenText());
let lines = text.split('\n');
let row = lines.findIndex((l) => l.includes('Changelog'));
if (row >= 0) {
	const col = lines[row].indexOf('Changelog') + 3;
	const p = await cellXY(page, col, row + 1);
	const n = sent.length;
	await touch.tap(p.x, p.y);
	await sleep(1500);
	const out = since(sent, n).join('');
	check('tap sends one SGR press+release at the cell', out.includes(`\x1b[<0;${col};${row + 1}M\x1b[<0;${col};${row + 1}m`), JSON.stringify(out));
	check('tap sends no wheel or motion', !/\x1b\[<(6[45]|3\d);/.test(out));
} else {
	check('found Changelog on screen to tap', false, 'not on screen; grok is not on its welcome screen');
}
await sleep(1000);
const afterTap = capture();
console.log('--- pane after tap (first 12 lines) ---\n' + afterTap.split('\n').filter((l) => l.trim()).slice(0, 12).join('\n'));
await page.screenshot({ path: `${SHOTS}/02-phone-after-tap.png` });

// How many lines does grok move per wheel event? Informational.
if (afterTap.includes('Release Notes')) {
	const at = await cellXY(page, 10, 10);
	const body = (c) => c.split('\n').slice(3, -4).map((l) => l.trim());
	const b0 = body(capture());
	await page.evaluate(() => window.__gb.conn.input('\x1b[<65;10;10M'));
	await sleep(800);
	const b1 = body(capture());
	let shift = -1;
	for (let k = 1; k < 10; k++) if (b1.slice(0, 8).join('\n') === b0.slice(k, k + 8).join('\n')) { shift = k; break; }
	check('grok lines per wheel event (info)', true, String(shift));
	await page.evaluate(() => window.__gb.conn.input('\x1b[<64;10;10M'));
	await sleep(800);
}

// Swipe down (finger moves down) = wheel up = older content.
size = await termSize(page);
const mid = await cellXY(page, Math.floor(size.cols / 2), Math.floor(size.rows / 2));
const lineH = await page.evaluate(() => document.querySelector('#term .xterm-screen').getBoundingClientRect().height / window.__gb.term.rows);
async function swipeTest(label, dy) {
	const before = capture();
	const n = sent.length;
	await touch.swipe(mid.x, mid.y - dy / 2, mid.y + dy / 2, 900, 30); // slow: no fling
	await sleep(1200);
	const w = wheels(since(sent, n));
	const after = capture();
	const expect = Math.floor((Math.abs(dy) - 10) / lineH);
	const btn = dy > 0 ? 64 : 65;
	check(`${label}: ~1 wheel per line of travel`, w.length >= expect - 1 && w.length <= expect + 1 && w.every((s) => s.startsWith(`\x1b[<${btn};`)), `${w.length} events for ${Math.abs(dy)}px at ${lineH.toFixed(1)}px/line, expected ${expect}, first ${JSON.stringify(w[0])}`);
	const top = (c) => c.split('\n').filter((l) => l.trim()).slice(1, 6).join('\n');
	console.log(`--- ${label}: before ---\n${top(before)}\n--- ${label}: after ---\n${top(after)}`);
	return { before, after, changed: before !== after };
}
// Scroll forward first so there is something to scroll back to, then back.
const s1 = await swipeTest('swipe up', -lineH * 12 - 10);
const s2 = await swipeTest('swipe down', lineH * 12 + 10);
check('grok screen changed on swipe (up or down)', s1.changed || s2.changed);

// Fling: fast swipe keeps sending after the finger lifts.
{
	const n = sent.length;
	await touch.swipe(mid.x, mid.y + 150, mid.y - 150, 80, 8);
	const atLift = wheels(since(sent, n)).length;
	await sleep(1500);
	const total = wheels(since(sent, n)).length;
	check('fling adds momentum events after lift', total > atLift + 5, `${atLift} during swipe, ${total} total`);
	await sleep(300);
	const settled = wheels(sent).length;
	await sleep(700);
	check('momentum stops', wheels(sent).length === settled);
	// Fling back the other way to restore position roughly.
	await touch.swipe(mid.x, mid.y - 150, mid.y + 150, 80, 8);
	await sleep(2000);
}

// Tap during a fling stops it without clicking.
{
	await touch.swipe(mid.x, mid.y + 150, mid.y - 150, 80, 8);
	await sleep(120);
	const n = sent.length;
	await touch.tap(mid.x, mid.y);
	await sleep(50);
	const k = sent.length;
	await sleep(600);
	check('tap during fling stops it and sends no click', since(sent, k).length === 0 && !since(sent, n).join('').includes('\x1b[<0;'));
	await touch.swipe(mid.x, mid.y - 150, mid.y + 150, 80, 8);
	await sleep(2000);
}

// Long-press sends nothing.
{
	const n = sent.length;
	await touch.tap(mid.x, mid.y, 900);
	await sleep(300);
	check('long-press sends nothing', since(sent, n).length === 0, JSON.stringify(since(sent, n)));
}

// Pinch zoom changes the font and is saved.
{
	const f0 = await page.evaluate(() => window.__gb.term.options.fontSize);
	await touch.pinch(mid.x, mid.y, 100, 160);
	await sleep(500);
	const f1 = await page.evaluate(() => window.__gb.term.options.fontSize);
	const saved = await page.evaluate(() => localStorage.getItem('grokbuild.fontSize'));
	check('pinch out enlarges the font and saves it', f1 > f0 && saved === String(f1), `${f0} -> ${f1}, saved ${saved}`);
	await touch.pinch(mid.x, mid.y, 160, 100);
	await sleep(500);
	const f2 = await page.evaluate(() => window.__gb.term.options.fontSize);
	check('pinch in shrinks it back', f2 <= f0 + 1, `${f1} -> ${f2}`);
	await page.evaluate((f) => window.__gb.setFont(f), 13);
}

// Key bar: Esc, arrows, Ctrl sticky, PgUp/PgDn.
async function barKey(k) {
	const n = sent.length;
	const b = await page.$(`#bar [data-k="${k}"]`);
	await b.scrollIntoViewIfNeeded();
	const box = await b.boundingBox();
	await touch.tap(box.x + box.width / 2, box.y + box.height / 2);
	await sleep(250);
	return since(sent, n).join('');
}
const appCursor = await page.evaluate(() => window.__gb.term.modes.applicationCursorKeysMode);
check('Esc key', (await barKey('esc')) === '0\x1b');
check('Up arrow', (await barKey('up')) === (appCursor ? '0\x1bOA' : '0\x1b[A'), `appCursor=${appCursor}`);
check('Down arrow', (await barKey('down')) === (appCursor ? '0\x1bOB' : '0\x1b[B'));
check('PgUp', (await barKey('pgup')) === '0\x1b[5~');
check('PgDn', (await barKey('pgdn')) === '0\x1b[6~');
{
	// Shift+Tab cycles grok's approval mode. Check it reached grok, then cycle
	// back to the mode it had.
	const modeLine = () => (capture().match(/Grok [^\n│]*?\)[^─│\n]*/) || [''])[0].trim();
	const m0 = modeLine();
	check('Shift+Tab', (await barKey('stab')) === '0\x1b[Z');
	await sleep(600);
	const m1 = modeLine();
	check('Shift+Tab reached grok (mode changed)', m1 !== m0, `${m0} -> ${m1}`);
	for (let i = 0; i < 6 && modeLine() !== m0; i++) { tmux('send-keys -t grok BTab'); await sleep(600); }
	check('grok mode restored', modeLine() === m0, modeLine());
}
check('Ctrl tap sends nothing by itself', (await barKey('ctrl')) === '');
check('Ctrl button shows armed', await page.$eval('#bar [data-k="ctrl"]', (b) => b.classList.contains('on')));
{
	const n = sent.length;
	await page.evaluate(() => window.__gb.term.focus());
	await page.keyboard.type('u'); // Ctrl+U: clear the input line in grok
	await sleep(250);
	const typed = since(sent, n).filter((f) => f !== '0\x1b[I' && f !== '0\x1b[O').join('');
	check('sticky Ctrl turns typed u into Ctrl+U, once', typed === '0\x15', JSON.stringify(since(sent, n)));
	check('Ctrl released after one key', !(await page.$eval('#bar [data-k="ctrl"]', (b) => b.classList.contains('on'))));
	await page.evaluate(() => document.activeElement.blur());
}
check('Ctrl+Right with sticky Ctrl', ((await barKey('ctrl')), (await barKey('right'))) === '0\x1b[1;5C');
check('bar buttons keep the button unfocused', await page.evaluate(() => !document.activeElement || document.activeElement.tagName !== 'BUTTON'));
console.log('--- pane after keys ---\n' + capture().split('\n').filter((l) => l.trim()).slice(-6).join('\n'));

// Font buttons resize the grid and tmux follows.
{
	const a = await termSize(page);
	await barKey('font+');
	await barKey('font+');
	await sleep(600);
	const b = await termSize(page);
	const p = paneInfo();
	check('A+ shrinks the grid and tmux follows', b.cols < a.cols && p.startsWith(`${b.cols}x${b.rows}`), `${a.cols}x${a.rows} -> ${b.cols}x${b.rows}, pane ${p}`);
	await barKey('font-');
	await barKey('font-');
	await sleep(400);
}

// OSC 52 from tmux reaches the browser clipboard.
{
	tmux(`set-buffer -w "grokbuild osc52 test ✓"`);
	await sleep(1000);
	const got = await page.evaluate(() => window.__gbLastOsc52);
	const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e.message));
	check('OSC 52 decoded', got === 'grokbuild osc52 test ✓', JSON.stringify(got));
	check('OSC 52 written to the clipboard', clip === 'grokbuild osc52 test ✓', JSON.stringify(clip));
	tmux('delete-buffer');
}

// Copy screen sheet.
{
	await barKey('copy');
	await sleep(300);
	const v = await page.$eval('#sheet-text', (t) => t.value);
	check('copy sheet shows the screen text', !(await page.$eval('#sheet', (s) => s.hidden)) && v.length > 20, `${v.length} chars`);
	await page.screenshot({ path: `${SHOTS}/05-phone-copy-sheet.png` });
	await page.click('#sheet-copy');
	await sleep(300);
	const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
	check('copy sheet Copy puts the screen on the clipboard', clip === v);
	await page.click('#sheet-close');
}

// Soft keyboard: shrink the viewport like the keyboard does; the bar stays above it.
{
	const vp = page.viewportSize();
	const a = await termSize(page);
	await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.55) });
	await sleep(800);
	const b = await termSize(page);
	const barBox = await page.locator('#bar').boundingBox();
	const h = page.viewportSize().height;
	check('keyboard-height viewport: rows shrink, bar at the bottom edge', b.rows < a.rows && Math.abs(barBox.y + barBox.height - h) < 2, `rows ${a.rows} -> ${b.rows}, bar bottom ${barBox.y + barBox.height} of ${h}`);
	check('no page scroll', (await page.evaluate(() => [scrollX, scrollY, document.scrollingElement.scrollTop])).every((v) => v === 0));
	check('tmux follows keyboard resize', paneInfo().startsWith(`${b.cols}x${b.rows}`), paneInfo());
	await page.evaluate(() => { document.getElementById('bar').scrollLeft = 0; });
	await sleep(300);
	await page.screenshot({ path: `${SHOTS}/03-phone-keyboard-open-simulated.png` });
	await page.setViewportSize(vp);
	await sleep(600);
	// Rotate.
	await page.setViewportSize({ width: vp.height, height: vp.width });
	await sleep(800);
	const c = await termSize(page);
	check('landscape refits', c.cols > a.cols && c.rows < a.rows, `${c.cols}x${c.rows}; pane ${paneInfo()}`);
	await page.screenshot({ path: `${SHOTS}/06-phone-landscape.png` });
	await page.setViewportSize(vp);
	await sleep(600);
}

// Hide the bar.
{
	await barKey('hide');
	await sleep(400);
	check('bar hides and the restore button shows', !(await page.isVisible('#bar')) && (await page.isVisible('#show-bar')));
	await page.screenshot({ path: `${SHOTS}/04-phone-bar-hidden.png` });
	const b = await page.locator('#show-bar').boundingBox();
	await touch.tap(b.x + b.width / 2, b.y + b.height / 2);
	await sleep(400);
	check('restore button brings the bar back', await page.isVisible('#bar'));
}

// Reconnect: client-side drop, then server-side kill of ttyd.
{
	const created = tmux('display -p -t grok "#{session_created}"').trim();
	const nSock = sockets.length;
	await page.evaluate(() => window.__gb.conn.ws.close());
	await page.waitForSelector('#pill.retry', { timeout: 3000 }).catch(() => {});
	const pillText = await page.$eval('#pill', (p) => p.textContent).catch(() => '');
	await page.waitForFunction(() => window.__gb.conn.open, null, { timeout: 10000 });
	await sleep(1500);
	check('reconnects after the socket closes', sockets.length === nSock + 1, `pill said "${pillText}"`);
	check('same tmux session after reconnect', tmux('display -p -t grok "#{session_created}"').trim() === created);
	check('screen redrawn after reconnect', /❯|Grok/.test(await page.evaluate(() => window.__gb.screenText())));

	router('kill $(ps w | grep "[t]tyd -p 7682" | awk \'{print $1}\')');
	await page.waitForFunction(() => !window.__gb.conn.open, null, { timeout: 5000 });
	await page.screenshot({ path: `${SHOTS}/07-phone-reconnecting.png` });
	const t0 = Date.now();
	await page.waitForFunction(() => window.__gb.conn.open, null, { timeout: 30000 });
	await sleep(1500);
	check('reconnects after ttyd is killed and the supervisor restarts it', true, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
	check('same tmux session after ttyd restart', tmux('display -p -t grok "#{session_created}"').trim() === created);
	check('grok still running', paneInfo().includes(' grok '), paneInfo());
}
await page.evaluate(() => { document.getElementById('bar').scrollLeft = 0; });
await sleep(300);
await page.screenshot({ path: `${SHOTS}/01-phone-portrait.png` });
await phone.ctx.close();

// ---------------- desktop ----------------
{
	const d = await openPage({ viewport: { width: 1280, height: 800 } });
	check('desktop: key bar hidden', !(await d.page.isVisible('#bar')));
	check('desktop: font size 14', (await d.page.evaluate(() => window.__gb.term.options.fontSize)) === 14);
	const box = await d.page.locator('#term .xterm-screen').boundingBox();
	await d.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	const n = d.sent.length;
	await d.page.mouse.wheel(0, -300);
	await sleep(500);
	await d.page.mouse.wheel(0, 300);
	await sleep(500);
	const w = wheels(since(d.sent, n));
	check('desktop: mouse wheel sends SGR wheel through xterm', w.some((s) => s.startsWith('\x1b[<64;')) && w.some((s) => s.startsWith('\x1b[<65;')), `${w.length} events`);
	await d.page.screenshot({ path: `${SHOTS}/08-desktop.png` });
	await d.ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
