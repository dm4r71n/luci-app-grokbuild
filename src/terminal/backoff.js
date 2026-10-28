// Reconnect delay in ms for attempt n (0-based): 0.5 s, 1, 2, 4, 8, then 15 s.
export function backoff(n, jitter = Math.random) {
	const base = Math.min(500 * Math.pow(2, n), 15000);
	return Math.round(base * (0.85 + 0.3 * jitter()));
}
