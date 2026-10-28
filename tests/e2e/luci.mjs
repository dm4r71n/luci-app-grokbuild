// End-to-end check of Services > Grok Build in LuCI with a Pixel 7 in headless
// Chromium: log in through the LuCI form, the framed terminal attaches to the
// grok session, a lost key is replaced through the parent page, Full screen,
// Restart service (the session survives), and Restart grok's confirm. It
// never confirms Restart grok, so the real grok session is left alone.
//
//   OPENWRT_PASSWORD=... GB_HOST=100.104.188.37 node tests/e2e/luci.mjs
import { chromium, devices } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const HOST = process.env.GB_HOST || '100.104.188.37';
const PORT = +(process.env.GB_PORT || 7682);
const SSH = (process.env.GB_SSH || 'ssh -o BatchMode=yes -o UserKnownHostsFile=/workspace/.ssh/known_hosts -i /workspace/.ssh/openwrt root@100.104.188.37').split(' ');
const SHOTS = process.env.GB_SHOTS || '/workspace/luci-app-grokbuild-shots';
const PASSWORD = process.env.OPENWRT_PASSWORD;
if (!PASSWORD) { console.error('OPENWRT_PASSWORD is not set'); process.exit(2); }
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok: !!ok });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const router = (cmd) => execFileSync(SSH[0], [...SSH.slice(1), cmd], { encoding: 'utf8' });
const created = () => router('tmux -L grokbuild display -p -t grok "#{session_created}"').trim();

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true });
// Same as phone.mjs: under Chromium's device-scale emulation xterm's WebGL
// renderer draws at the wrong size unless it uses its css * dpr fallback.
// Init scripts run in every frame, so this covers the framed terminal too.
await ctx.addInitScript(() => {
	const observe = ResizeObserver.prototype.observe;
	ResizeObserver.prototype.observe = function (el, opts) {
		if (opts && String(opts.box).includes('device-pixel')) throw new Error('not under emulation');
		return observe.call(this, el, opts);
	};
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));

// Log in through the form, like a person.
await page.goto(`https://${HOST}/cgi-bin/luci/`);
await page.fill('input[name="luci_password"]', PASSWORD);
await page.press('input[name="luci_password"]', 'Enter');
await page.waitForLoadState('networkidle');
check('LuCI login', (await ctx.cookies()).some((c) => c.name === 'sysauth_https'));

await page.goto(`https://${HOST}/cgi-bin/luci/admin/services/grokbuild`);
await page.waitForSelector('iframe.gb-frame', { timeout: 15000 });
check('Services > Grok Build opens the Terminal tab', /admin\/services\/grokbuild/.test(page.url()));
const menu = await page.evaluate(() => [...document.querySelectorAll('a')].some((a) => /services\/grokbuild/.test(a.getAttribute('href') || '') && /Grok Build/.test(a.textContent)));
check('menu has Services > Grok Build', menu);

const termFrame = async () => {
	for (let i = 0; i < 60; i++) {
		const f = page.frames().find((fr) => fr.url().startsWith(`https://${HOST}:${PORT}/`));
		if (f) return f;
		await sleep(250);
	}
	return null;
};
let frame = await termFrame();
check('terminal frame loads from the proxy port', !!frame, frame && frame.url());
const waitOpen = (f, ms = 20000) => f.waitForFunction(() => window.__gb && window.__gb.conn.open, null, { timeout: ms }).then(() => true, () => false);
check('framed terminal connects', await waitOpen(frame));
await frame.waitForFunction(() => /Grok|❯/.test(window.__gb.screenText()), null, { timeout: 15000 }).catch(() => {});
check('framed terminal shows grok', /Grok|❯/.test(await frame.evaluate(() => window.__gb.screenText())));
check('ticket is not left in the frame URL', !frame.url().includes('#t='));
const clients = router('tmux -L grokbuild list-clients -t grok | wc -l').trim();
check('frame is a client of the grok session', +clients >= 1, `${clients} client(s)`);

const box = await page.locator('iframe.gb-frame').boundingBox();
const vp = page.viewportSize();
check('frame fills the phone width and the rest of the height', box.width >= vp.width - 40 && box.y + box.height <= vp.height + 2 && box.height > vp.height * 0.5, JSON.stringify({ box, vp }));
check('certificate hint stays hidden', await page.locator('.gb-note').isHidden());
const statusText = await page.locator('.gb-status').textContent();
check('status line shows the service and session', /Service running/.test(statusText) && /attached/.test(statusText), statusText);
await sleep(1000);
await page.screenshot({ path: `${SHOTS}/10-luci-terminal-pixel7.png` });

// A refused key: the frame asks LuCI for a new ticket and reconnects.
{
	await frame.evaluate(() => { sessionStorage.setItem('grokbuild.key', '0'.repeat(32)); window.__gb.conn.drop(); });
	check('frame gets a new key from the LuCI page and reconnects', await waitOpen(frame), await frame.evaluate(() => (sessionStorage.getItem('grokbuild.key') || '').length + ' char key'));
	check('new key is the LuCI session', await frame.evaluate(() => sessionStorage.getItem('grokbuild.key')) === (await ctx.cookies()).find((c) => c.name === 'sysauth_https').value);
}

// Restart grok asks first; dismissing leaves the session alone.
{
	const before = created();
	page.once('dialog', (d) => d.dismiss());
	await page.getByRole('button', { name: 'Restart grok' }).click();
	await sleep(1500);
	check('Restart grok asks for confirmation, and Cancel keeps the session', created() === before);
}

// Restart service: everything comes back, the grok session survives.
{
	const before = created();
	const pidBefore = router('pgrep -f "^/usr/bin/stunnel /var/run/grokbuild"').trim();
	await page.getByRole('button', { name: 'Restart service' }).click();
	await sleep(4000);
	const pidAfter = router('pgrep -f "^/usr/bin/stunnel /var/run/grokbuild"').trim();
	check('Restart service restarts the service', pidAfter && pidAfter !== pidBefore);
	check('grok session survives a service restart', created() === before);
	check('framed terminal reconnects after the restart', await waitOpen(frame, 30000));
}

// Full screen: a new tab with its own ticket.
{
	const [tab] = await Promise.all([ctx.waitForEvent('page'), page.getByRole('button', { name: 'Full screen' }).click()]);
	await tab.waitForLoadState('domcontentloaded');
	const ok = await tab.waitForFunction(() => window.__gb && window.__gb.conn.open, null, { timeout: 20000 }).then(() => true, () => false);
	check('Full screen opens the terminal in a new tab', ok && tab.url().startsWith(`https://${HOST}:${PORT}/`), tab.url().replace(/#.*/, '#…'));
	check('full-screen tab has no opener', await tab.evaluate(() => window.opener === null));
	await tab.waitForFunction(() => /Grok|❯/.test(window.__gb.screenText()), null, { timeout: 10000 }).catch(() => {});
	await sleep(1000);
	await tab.screenshot({ path: `${SHOTS}/11-fullscreen-pixel7.png` });
	await tab.close();
}

// Settings tab renders.
await page.goto(`https://${HOST}/cgi-bin/luci/admin/services/grokbuild/settings`);
await page.waitForSelector('[data-name="port"] input, input[id*="port"]', { timeout: 15000 }).catch(() => {});
check('Settings tab shows the port', (await page.locator('input[id$=".port"]').inputValue().catch(() => '')) === String(PORT));
await page.screenshot({ path: `${SHOTS}/12-luci-settings-pixel7.png`, fullPage: true });

// Log out: the open terminal stops working.
{
	await page.goto(`https://${HOST}/cgi-bin/luci/admin/services/grokbuild`);
	frame = await termFrame();
	await waitOpen(frame);
	const key = await frame.evaluate(() => sessionStorage.getItem('grokbuild.key'));
	await page.goto(`https://${HOST}/cgi-bin/luci/admin/logout`);
	const r = await ctx.request.get(`https://${HOST}:${PORT}/token`, { headers: { 'X-GrokBuild-Key': key } });
	check('after LuCI logout the terminal key is refused', r.status() === 401);
}

await browser.close();
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
