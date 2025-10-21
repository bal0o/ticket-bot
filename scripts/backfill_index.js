const { createDB } = require('../utils/quickdb');

(async () => {
	const db = createDB();
	console.log('[backfill] Starting backfill of TicketIndex...');

	function toSeconds(value) {
		if (typeof value !== 'number') return null;
		return value > 2e10 ? Math.floor(value / 1000) : Math.floor(value);
	}

	function inferServerFromResponses(responses) {
		try {
			if (typeof responses !== 'string') return null;
			const m = responses.match(/\*\*Server:\*\*\n(.*?)(?:\n\n|$)/);
			return m && m[1] ? m[1] : null;
		} catch (_) { return null; }
	}

	let ps = await db.get('PlayerStats');
	if (!ps || typeof ps !== 'object') {
		console.log('[backfill] PlayerStats aggregate not found, reconstructing from DB rows...');
		ps = {};
		const all = await db.all();
		for (const row of all) {
			const key = row.id || row.ID || row.key;
			if (!key || !key.startsWith('PlayerStats.')) continue;
			const m = key.match(/^PlayerStats\.(\d+)\.ticketLogs\.(\d+)\.(\w+)$/);
			if (!m) continue;
			const [, userId, ticketId, field] = m;
			if (!ps[userId]) ps[userId] = { ticketLogs: {} };
			if (!ps[userId].ticketLogs[ticketId]) ps[userId].ticketLogs[ticketId] = {};
			ps[userId].ticketLogs[ticketId][field] = row.value ?? row.data;
		}
	}

	const existing = (await db.get('TicketIndex.staffList')) || [];
	const staffList = Array.isArray(existing) ? existing.slice() : [];
	const seen = new Set(staffList.map(r => `${r.userId}:${r.ticketId}`));

	let created = 0;
	let updated = 0;

	for (const userId of Object.keys(ps)) {
		const logs = (ps[userId] && ps[userId].ticketLogs) ? ps[userId].ticketLogs : {};
		for (const ticketId of Object.keys(logs)) {
			const t = logs[ticketId] || {};
			// Only closed tickets are listed in staffList
			if (!t.closeTime && !t.closeType && !t.transcriptURL) continue;
			const url = typeof t.transcriptURL === 'string' ? t.transcriptURL : '';
			let filename = null;
			if (url) {
				const parts = url.split('/');
				filename = parts[parts.length - 1] || null;
			}
			// byFilename index for quick transcript owner lookup (store both variants)
			if (filename) {
				try {
					await db.set(`TicketIndex.byFilename.${filename}`, { ownerId: String(userId), ticketId: String(ticketId) });
					if (/\.full\.html$/i.test(filename)) {
						const alt = filename.replace(/\.full\.html$/i, '.html');
						await db.set(`TicketIndex.byFilename.${alt}`, { ownerId: String(userId), ticketId: String(ticketId) });
					} else if (/\.html$/i.test(filename)) {
						const alt = filename.replace(/\.html$/i, '.full.html');
						await db.set(`TicketIndex.byFilename.${alt}`, { ownerId: String(userId), ticketId: String(ticketId) });
					}
				} catch (_) {}
			}

			const createdAt = toSeconds(t.createdAt);
			const row = {
				userId: String(userId),
				ticketId: String(t.globalTicketNumber || ticketId),
				ticketType: t.ticketType || 'Unknown',
				server: t.server || inferServerFromResponses(t.responses) || null,
				createdAt: createdAt,
				closeTime: toSeconds(t.closeTime),
				closeUserID: t.closeUserID ? String(t.closeUserID) : null,
				transcriptFilename: filename && /\.full\.html$/i.test(filename) ? filename.replace(/\.full\.html$/i, '.html') : (filename || null)
			};
			const key = `${row.userId}:${row.ticketId}`;
			if (!seen.has(key)) {
				staffList.push(row);
				seen.add(key);
				created++;
			} else {
				updated++;
			}
		}
	}

	// Sort by createdAt desc and cap to a high watermark to avoid unbounded growth
	staffList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
	const MAX_INDEX = 25000;
	const trimmed = staffList.length > MAX_INDEX ? staffList.slice(0, MAX_INDEX) : staffList;
	await db.set('TicketIndex.staffList', trimmed);

	console.log(`[backfill] Done. Added ${created} entries, updated ${updated}. Total indexed: ${trimmed.length}.`);
	process.exit(0);
})().catch(err => { console.error('[backfill] Error:', err); process.exit(1); });


