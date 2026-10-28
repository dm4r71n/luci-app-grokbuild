// Grok Build terminal page. Everything is bundled into one HTML file by
// tools/build.mjs; the page makes no requests except /auth, /token and /ws,
// all to the Grok Build proxy that serves it.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SwipeScroller, sgrWheel, sgrClick, cellAt, WHEEL_UP } from './swipe.js';
import { keySequence, applyMods, Sticky } from './keys.js';
import { decodeOsc52 } from './osc52.js';
import { TtydConnection } from './ttyd.js';
import { Auth, ticketFromHash, sessionStore, parentTicket } from './auth.js';

const $ = (s) => document.querySelector(s);
const app = $('#app');
const termEl = $('#term');
const bar = $('#bar');
const pill = $('#pill');
const toast = $('#toast');

const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const params = new URLSearchParams(location.search);
const showKeys = params.has('keys') ? params.get('keys') !== '0' : touch;
document.documentElement.classList.toggle('keys', showKeys);

// ---------- settings ----------
const store = {
	get(k, d) { try { const v = localStorage.getItem('grokbuild.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
	set(k, v) { try { localStorage.setItem('grokbuild.' + k, JSON.stringify(v)); } catch {} },
};
const FONT_MIN = 8, FONT_MAX = 24;
let fontSize = store.get('fontSize', touch ? 13 : 14);
let barHidden = store.get('barHidden', false);
// Lines of finger travel per wheel event. 1 by default; ?swipe=N changes and saves it.
if (params.has('swipe') && +params.get('swipe') > 0) store.set('swipeLines', Math.min(10, +params.get('swipe')));
const swipeLines = store.get('swipeLines', 1);

// ---------- terminal ----------
const theme = {
	background: '#0a0e17', foreground: '#e6e8eb', cursor: '#00b3a9', cursorAccent: '#0a0e17',
	selectionBackground: '#00958e66', selectionInactiveBackground: '#00958e33',
	black: '#141822', red: '#f17070', green: '#51bd85', yellow: '#e5c07b',
	blue: '#64aed5', magenta: '#c49be6', cyan: '#2ec4b6', white: '#d4d7dc',
	brightBlack: '#5f666d', brightRed: '#ff8a8a', brightGreen: '#6fd8a0', brightYellow: '#f0d494',
	brightBlue: '#90c1ff', brightMagenta: '#dab8f5', brightCyan: '#5fe0d4', brightWhite: '#f9fafb',
};

const term = new Terminal({
	fontSize,
	fontFamily: '"JetBrains Mono", "Cascadia Mono", "DejaVu Sans Mono", "Roboto Mono", "Noto Sans Mono", "Droid Sans Mono", ui-monospace, Menlo, Consolas, monospace',
	theme,
	scrollback: 1000,
	allowProposedApi: true,
	cursorBlink: false,
	macOptionIsMeta: true,
	drawBoldTextInBrightColors: false,
	minimumContrastRatio: 1,
	smoothScrollDuration: 0,
});
const fit = new FitAddon();
term.loadAddon(fit);
const unicode = new Unicode11Addon();
term.loadAddon(unicode);
term.unicode.activeVersion = '11';
term.open(termEl);

// Renderer: ?renderer=webgl|canvas|dom, remembered in localStorage.
// WebGL is the default; it falls back to the DOM renderer if the GPU context is lost.
const RENDERERS = ['webgl', 'canvas', 'dom'];
if (params.has('renderer') && RENDERERS.includes(params.get('renderer'))) store.set('renderer', params.get('renderer'));
let renderer = store.get('renderer', 'webgl');
if (!RENDERERS.includes(renderer)) renderer = 'webgl';
if (renderer === 'webgl') {
	try {
		const webgl = new WebglAddon();
		webgl.onContextLoss(() => { webgl.dispose(); renderer = 'dom'; });
		term.loadAddon(webgl);
	} catch { renderer = 'canvas'; }
}
if (renderer === 'canvas') {
	try { term.loadAddon(new CanvasAddon()); } catch { renderer = 'dom'; }
}

const ta = term.textarea;
if (ta) {
	ta.setAttribute('autocapitalize', 'off');
	ta.setAttribute('autocorrect', 'off');
	ta.setAttribute('autocomplete', 'off');
	ta.setAttribute('spellcheck', 'false');
	ta.setAttribute('enterkeyhint', 'enter');
}

// ---------- connection ----------
// A ticket in the fragment comes from LuCI. Drop it from the address bar and
// history straight away; it works only once anyway.
const hashTicket = ticketFromHash(location.hash);
if (hashTicket) history.replaceState(null, '', location.pathname + location.search);
const framed = window.parent !== window;
// Tell a framing LuCI page that the page loaded (so it hides its certificate
// hint). Nothing secret, and its origin is not known here.
if (framed) window.parent.postMessage({ grokbuild: 'loaded' }, '*');
const base = new URL('./', location.href).href;
const auth = new Auth({
	base,
	store: sessionStore(window.sessionStorage),
	fetch: (...a) => fetch(...a),
	requestTicket: () => parentTicket(window),
	ticket: hashTicket,
});
const conn = new TtydConnection({
	base,
	auth,
	size: () => ({ columns: term.cols, rows: term.rows }),
	onOutput: (data, done) => term.write(data, done),
	onTitle: () => {},
	onStatus: status,
});

const ctrl = new Sticky();
const alt = new Sticky();

term.onData((data) => {
	// Sequences xterm makes itself (mouse and focus reports, keys from a real
	// keyboard) start with ESC and pass through without the sticky modifiers.
	if ((ctrl.on || alt.on) && !data.startsWith('\x1b')) {
		data = applyMods(data, { ctrl: ctrl.on, alt: alt.on });
		ctrl.used(); alt.used(); refreshMods();
	}
	conn.input(data);
});
term.onBinary((data) => conn.input(data));
term.onResize(({ cols, rows }) => conn.resize(cols, rows));

// ---------- status pill ----------
let pillTimer = null, countdown = null;
function status(s, ms) {
	clearTimeout(pillTimer);
	clearInterval(countdown);
	pill.className = 'pill ' + s;
	pill.hidden = false;
	if (s === 'open') {
		term.reset();
		ctrl.clear(); alt.clear(); refreshMods();
		requestAnimationFrame(doFit);
		pill.textContent = 'connected';
		pillTimer = setTimeout(() => { pill.hidden = true; }, 1500);
	} else if (s === 'connecting') {
		pill.textContent = 'connecting…';
	} else if (s === 'retry') {
		const until = Date.now() + ms;
		const tick = () => {
			const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
			pill.textContent = navigator.onLine === false ? 'offline · retrying' : `reconnecting in ${left}s · tap`;
		};
		tick();
		countdown = setInterval(tick, 500);
	} else if (s === 'auth') {
		pill.textContent = framed ? 'LuCI sign-in needed · tap to retry' : 'open from LuCI · tap';
	}
}
pill.addEventListener('click', () => {
	if (pill.classList.contains('auth') && !framed)
		location.href = `https://${location.hostname.includes(':') ? '[' + location.hostname + ']' : location.hostname}/cgi-bin/luci/admin/services/grokbuild/terminal`;
	else if (pill.classList.contains('auth')) conn.connect();
	else conn.kick();
});

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
	if (document.hidden) { hiddenAt = Date.now(); stopMomentum(); return; }
	// A phone that slept can keep a dead socket that still says OPEN.
	if (conn.open && hiddenAt && Date.now() - hiddenAt > 30000) conn.connect();
	else conn.kick();
	layout();
});
addEventListener('online', () => conn.kick());
addEventListener('focus', () => conn.kick());
addEventListener('pageshow', (e) => { if (e.persisted) conn.connect(); });

// ---------- layout ----------
const vv = window.visualViewport;
let maxVH = 0;
function layout() {
	const h = vv ? vv.height : innerHeight;
	maxVH = Math.max(maxVH, h);
	document.documentElement.style.setProperty('--app-h', h + 'px');
	app.style.transform = vv && vv.offsetTop > 0 ? `translateY(${vv.offsetTop}px)` : '';
	if (scrollX || scrollY) scrollTo(0, 0);
	refreshKbd();
}
addEventListener('orientationchange', () => { maxVH = 0; setTimeout(layout, 50); });
addEventListener('resize', layout);
if (vv) { vv.addEventListener('resize', layout); vv.addEventListener('scroll', layout); }

let fitQueued = false;
function doFit() {
	fitQueued = false;
	try { fit.fit(); } catch {}
}
new ResizeObserver(() => {
	if (!fitQueued) { fitQueued = true; requestAnimationFrame(doFit); }
}).observe(termEl);

function setFont(n, save = true) {
	n = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
	if (n === fontSize) return;
	fontSize = n;
	term.options.fontSize = n;
	doFit();
	if (save) store.set('fontSize', n);
}

// ---------- touch: swipe to wheel, tap to click, pinch to zoom ----------
const scroller = new SwipeScroller();
let lastPt = { x: 0, y: 0 };
let raf = 0, rafT = 0;
let tapStoppedFling = false;
let pinch = null;

function screenRect() {
	const s = termEl.querySelector('.xterm-screen');
	return (s || termEl).getBoundingClientRect();
}
function cellHeight() {
	const r = screenRect();
	return r.height / term.rows || 16;
}
function mouseOn() {
	return term.modes.mouseTrackingMode !== 'none';
}
function sendWheel(buttons, x, y) {
	if (!buttons.length) return;
	if (mouseOn()) {
		const { col, row } = cellAt(x, y, screenRect(), term.cols, term.rows);
		conn.input(buttons.map((b) => sgrWheel(b, col, row)).join(''));
	} else {
		let n = 0;
		for (const b of buttons) n += b === WHEEL_UP ? -1 : 1;
		term.scrollLines(n);
	}
}
function stopMomentum() {
	scroller.stop();
	cancelAnimationFrame(raf);
	raf = 0;
}
function momentum(t) {
	const dt = rafT ? Math.min(t - rafT, 50) : 16;
	rafT = t;
	sendWheel(scroller.step(dt), lastPt.x, lastPt.y);
	raf = scroller.moving ? requestAnimationFrame(momentum) : 0;
}
const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

function onTouchStart(e) {
	e.preventDefault();
	e.stopPropagation();
	if (e.touches.length === 2) {
		stopMomentum();
		scroller.reset();
		pinch = { d: dist(e.touches[0], e.touches[1]), size: fontSize };
		return;
	}
	if (e.touches.length > 2 || pinch) return;
	tapStoppedFling = scroller.moving;
	stopMomentum();
	const t = e.touches[0];
	lastPt = { x: t.clientX, y: t.clientY };
	scroller.lineHeight = cellHeight() * swipeLines;
	scroller.start(t.clientX, t.clientY, performance.now());
}
function onTouchMove(e) {
	e.preventDefault();
	e.stopPropagation();
	if (pinch) {
		if (e.touches.length >= 2) {
			const ratio = dist(e.touches[0], e.touches[1]) / pinch.d;
			setFont(pinch.size * ratio, false);
		}
		return;
	}
	const t = e.touches[0];
	if (!t) return;
	lastPt = { x: t.clientX, y: t.clientY };
	sendWheel(scroller.move(t.clientX, t.clientY, performance.now()), t.clientX, t.clientY);
}
function onTouchEnd(e) {
	e.preventDefault();
	e.stopPropagation();
	if (pinch) {
		if (e.touches.length === 0) { pinch = null; store.set('fontSize', fontSize); }
		scroller.reset();
		return;
	}
	if (e.type === 'touchcancel') { scroller.reset(); return; }
	const r = scroller.end(performance.now());
	if (r.kind === 'tap' && !tapStoppedFling) {
		const t = e.changedTouches[0];
		if (mouseOn()) {
			const { col, row } = cellAt(t.clientX, t.clientY, screenRect(), term.cols, term.rows);
			conn.input(sgrClick(col, row));
		}
		if (document.activeElement === ta) term.focus();
	} else if (r.kind === 'swipe' && r.velocity) {
		rafT = 0;
		raf = requestAnimationFrame(momentum);
	}
	// 'longpress' sends nothing: no stray motion or click.
}
const opt = { capture: true, passive: false };
termEl.addEventListener('touchstart', onTouchStart, opt);
termEl.addEventListener('touchmove', onTouchMove, opt);
termEl.addEventListener('touchend', onTouchEnd, opt);
termEl.addEventListener('touchcancel', onTouchEnd, opt);
termEl.addEventListener('contextmenu', (e) => { if (touch) e.preventDefault(); });
// No page zoom or overscroll anywhere.
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
// Any mouse wheel press stops a running fling.
termEl.addEventListener('wheel', () => stopMomentum(), { passive: true, capture: true });

// ---------- key bar ----------
function kbdVisible() {
	return document.activeElement === ta && vv && vv.height < maxVH - 120;
}
function refreshKbd() {
	const b = bar.querySelector('[data-k="kbd"]');
	if (b) b.classList.toggle('on', document.activeElement === ta);
}
function refreshMods() {
	for (const [name, s] of [['ctrl', ctrl], ['alt', alt]]) {
		const b = bar.querySelector(`[data-k="${name}"]`);
		if (b) { b.classList.toggle('on', s.state === 'once'); b.classList.toggle('lock', s.state === 'lock'); }
	}
}
if (ta) { ta.addEventListener('focus', refreshKbd); ta.addEventListener('blur', refreshKbd); }

function setBarHidden(h) {
	barHidden = h;
	store.set('barHidden', h);
	document.documentElement.classList.toggle('bar-hidden', h);
}
setBarHidden(barHidden);

const actions = {
	kbd() {
		if (document.activeElement === ta && (kbdVisible() || !vv)) { ta.blur(); }
		else { if (document.activeElement === ta) ta.blur(); term.focus(); }
		refreshKbd();
	},
	ctrl() { ctrl.tap(); refreshMods(); },
	alt() { alt.tap(); refreshMods(); },
	'font-': () => setFont(fontSize - 1),
	'font+': () => setFont(fontSize + 1),
	copy: openCopySheet,
	paste: async () => {
		try { const t = await navigator.clipboard.readText(); if (t) term.paste(t); }
		catch { showToast('Paste blocked by the browser. Use the keyboard\'s clipboard.'); }
	},
	hide: () => setBarHidden(true),
};

// Keep focus (and the soft keyboard) where it is when a bar button is pressed.
for (const el of [bar, $('#show-bar')]) {
	el.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
}
bar.addEventListener('click', (e) => {
	const b = e.target.closest('button');
	if (!b) return;
	const k = b.dataset.k;
	if (actions[k]) { actions[k](); return; }
	const seq = keySequence(k, { ctrl: ctrl.on, alt: alt.on }, term.modes.applicationCursorKeysMode);
	ctrl.used(); alt.used(); refreshMods();
	stopMomentum();
	conn.input(seq);
});
$('#show-bar').addEventListener('click', () => setBarHidden(false));

// Desktop: Ctrl/Cmd + and - change the font when the bar is hidden.
document.addEventListener('keydown', (e) => {
	if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setFont(fontSize + 1); }
	if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setFont(fontSize - 1); }
}, true);

// ---------- clipboard ----------
let toastTimer = null;
function showToast(msg, action) {
	clearTimeout(toastTimer);
	toast.textContent = msg;
	toast.hidden = false;
	toast.onclick = () => { toast.hidden = true; if (action) action(); };
	toastTimer = setTimeout(() => { toast.hidden = true; }, action ? 8000 : 2500);
}
function fallbackCopy(text) {
	const t = document.createElement('textarea');
	t.value = text;
	t.setAttribute('readonly', '');
	t.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
	document.body.appendChild(t);
	t.select();
	let ok = false;
	try { ok = document.execCommand('copy'); } catch {}
	t.remove();
	if (ta && document.activeElement !== ta) {} // leave focus alone
	return ok;
}
async function copyText(text, fromUser = false) {
	try {
		await navigator.clipboard.writeText(text);
		showToast(`Copied ${text.length} characters`);
		return true;
	} catch {}
	if (fromUser && fallbackCopy(text)) { showToast(`Copied ${text.length} characters`); return true; }
	// No user gesture: offer a tap, which is one.
	showToast('Tap to copy', () => copyText(text, true));
	return false;
}
window.__gbLastOsc52 = null;
term.parser.registerOscHandler(52, (data) => {
	const text = decodeOsc52(data);
	if (text !== null) { window.__gbLastOsc52 = text; copyText(text); }
	return true;
});

// Copy screen: a plain textarea with the visible screen, for native selection on touch.
const sheet = $('#sheet');
const sheetText = $('#sheet-text');
function screenText() {
	const b = term.buffer.active;
	const lines = [];
	for (let i = 0; i < term.rows; i++) {
		const l = b.getLine(b.viewportY + i);
		lines.push(l ? l.translateToString(true) : '');
	}
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	return lines.join('\n');
}
function openCopySheet() {
	sheetText.value = term.hasSelection() ? term.getSelection() : screenText();
	sheet.hidden = false;
	sheetText.scrollTop = sheetText.scrollHeight;
}
$('#sheet-copy').addEventListener('click', () => {
	const s = sheetText.value.substring(sheetText.selectionStart, sheetText.selectionEnd);
	copyText(s || sheetText.value, true);
});
$('#sheet-close').addEventListener('click', () => { sheet.hidden = true; });

// ---------- start ----------
layout();
doFit();
conn.connect();

// Hooks for tests and debugging in the console.
window.__gb = { term, conn, scroller, setFont, renderer: () => renderer, screenText };
