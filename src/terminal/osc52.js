// OSC 52 payload: "<selection>;<base64>". Returns the decoded text, or null for
// a query ("?") or anything that is not valid base64.
export function decodeOsc52(data) {
	const i = data.indexOf(';');
	if (i < 0) return null;
	const b64 = data.slice(i + 1).replace(/\s+/g, '');
	if (b64 === '?' || b64 === '') return null;
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
	try {
		const bin = atob(b64);
		const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
		return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	} catch {
		return null;
	}
}
