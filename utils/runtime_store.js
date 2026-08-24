function parseJson(value, fallback = null) {
	if (value == null) return fallback;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch (_) {
		return value;
	}
}

async function ensureRuntimeTables(conn) {
	await conn.query(`
		CREATE TABLE IF NOT EXISTS message_forwards (
			message_id VARCHAR(32) NOT NULL,
			kind ENUM('user','staff') NOT NULL,
			payload JSON NOT NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			PRIMARY KEY (message_id, kind)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
	`);
	await conn.query(`
		CREATE TABLE IF NOT EXISTS ticket_claims (
			channel_id VARCHAR(32) NOT NULL PRIMARY KEY,
			payload JSON NOT NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
	`);
	await conn.query(`
		CREATE TABLE IF NOT EXISTS app_maps (
			map_type ENUM('channelToApp','ticketToApp','userToChannels') NOT NULL,
			map_key VARCHAR(64) NOT NULL,
			payload JSON NOT NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			PRIMARY KEY (map_type, map_key)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
	`);
	await conn.query(`
		CREATE TABLE IF NOT EXISTS interview_cleanups (
			channel_id VARCHAR(32) NOT NULL PRIMARY KEY,
			payload JSON NOT NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
	`);
	await conn.query(`
		CREATE TABLE IF NOT EXISTS feature_flags (
			flag_key VARCHAR(255) NOT NULL PRIMARY KEY,
			value JSON NOT NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
	`);
	await conn.query(`
		CREATE TABLE IF NOT EXISTS bot_counters (
			counter_key VARCHAR(255) NOT NULL PRIMARY KEY,
			value BIGINT NOT NULL DEFAULT 0,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
	`);
}

async function kvGet(conn, key) {
	const [rows] = await conn.query('SELECT value FROM kv_store WHERE `key` = ?', [key]);
	if (!rows.length) return null;
	return parseJson(rows[0].value, rows[0].value);
}

async function kvSet(conn, key, value) {
	const jsonValue = typeof value === 'object' ? JSON.stringify(value) : value;
	await conn.query(
		'INSERT INTO kv_store (`key`, value, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
		[key, jsonValue, jsonValue]
	);
}

async function kvDelete(conn, key) {
	await conn.query('DELETE FROM kv_store WHERE `key` = ?', [key]);
}

async function kvDeletePrefix(conn, prefix) {
	await conn.query('DELETE FROM kv_store WHERE `key` = ? OR `key` LIKE ?', [prefix, `${prefix}.%`]);
}

function classifyKey(key) {
	if (!key || typeof key !== 'string') return { type: 'kv', key };
	if (key === 'globalTicketCount') return { type: 'counter', name: 'globalTicketCount' };
	if (key === 'InterviewCleanup' || key.startsWith('InterviewCleanup.')) {
		const channelId = key === 'InterviewCleanup' ? null : key.slice('InterviewCleanup.'.length);
		return { type: 'interviewCleanup', channelId };
	}
	if (key.startsWith('FeatureFlags.')) {
		return { type: 'featureFlag', flagKey: key };
	}
	if (key.startsWith('Claims.')) {
		return { type: 'claim', channelId: key.slice('Claims.'.length) };
	}
	if (key.startsWith('ForwardMap.') || key.startsWith('StaffForwardMap.')) {
		const kind = key.startsWith('StaffForwardMap.') ? 'staff' : 'user';
		const rest = key.slice(kind === 'staff' ? 'StaffForwardMap.'.length : 'ForwardMap.'.length);
		const parts = rest.split('.');
		const messageId = parts[0];
		const fieldPath = parts.slice(1);
		return { type: 'forward', kind, messageId, fieldPath };
	}
	if (key.startsWith('AppMap.')) {
		const rest = key.slice('AppMap.'.length);
		const parts = rest.split('.');
		const mapType = parts[0];
		const mapKey = parts.slice(1).join('.');
		if (['channelToApp', 'ticketToApp', 'userToChannels'].includes(mapType) && mapKey) {
			return { type: 'appMap', mapType, mapKey };
		}
	}
	return { type: 'kv', key };
}

async function getForward(conn, kind, messageId) {
	const [rows] = await conn.query(
		'SELECT payload FROM message_forwards WHERE message_id = ? AND kind = ?',
		[messageId, kind]
	);
	if (rows.length) return parseJson(rows[0].payload, {});

	const prefix = kind === 'staff' ? `StaffForwardMap.${messageId}` : `ForwardMap.${messageId}`;
	const exact = await kvGet(conn, prefix);
	if (exact && typeof exact === 'object') {
		await setForward(conn, kind, messageId, exact);
		await kvDeletePrefix(conn, prefix);
		return exact;
	}

	const [nested] = await conn.query(
		'SELECT `key`, value FROM kv_store WHERE `key` LIKE ?',
		[`${prefix}.%`]
	);
	if (!nested.length) return null;

	const obj = {};
	for (const row of nested) {
		const field = row.key.slice(prefix.length + 1);
		obj[field] = parseJson(row.value, row.value);
	}
	await setForward(conn, kind, messageId, obj);
	await kvDeletePrefix(conn, prefix);
	return obj;
}

async function setForward(conn, kind, messageId, payload) {
	const json = JSON.stringify(payload || {});
	await conn.query(
		`INSERT INTO message_forwards (message_id, kind, payload, updated_at)
		 VALUES (?, ?, ?, NOW())
		 ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = NOW()`,
		[messageId, kind, json]
	);
	const prefix = kind === 'staff' ? `StaffForwardMap.${messageId}` : `ForwardMap.${messageId}`;
	await kvDeletePrefix(conn, prefix);
}

async function deleteForward(conn, kind, messageId) {
	await conn.query('DELETE FROM message_forwards WHERE message_id = ? AND kind = ?', [messageId, kind]);
	const prefix = kind === 'staff' ? `StaffForwardMap.${messageId}` : `ForwardMap.${messageId}`;
	await kvDeletePrefix(conn, prefix);
}

async function mergeForwardField(conn, kind, messageId, fieldPath, value) {
	const current = (await getForward(conn, kind, messageId)) || {};
	let cursor = current;
	for (let i = 0; i < fieldPath.length - 1; i++) {
		const part = fieldPath[i];
		if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
		cursor = cursor[part];
	}
	cursor[fieldPath[fieldPath.length - 1]] = value;
	await setForward(conn, kind, messageId, current);
	return current;
}

async function getClaim(conn, channelId) {
	const [rows] = await conn.query('SELECT payload FROM ticket_claims WHERE channel_id = ?', [channelId]);
	if (rows.length) return parseJson(rows[0].payload, {});
	const legacy = await kvGet(conn, `Claims.${channelId}`);
	if (legacy != null) {
		await setClaim(conn, channelId, legacy);
		await kvDelete(conn, `Claims.${channelId}`);
		return legacy;
	}
	return null;
}

async function setClaim(conn, channelId, payload) {
	await conn.query(
		`INSERT INTO ticket_claims (channel_id, payload, updated_at)
		 VALUES (?, ?, NOW())
		 ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = NOW()`,
		[channelId, JSON.stringify(payload || {})]
	);
	await kvDelete(conn, `Claims.${channelId}`);
}

async function deleteClaim(conn, channelId) {
	await conn.query('DELETE FROM ticket_claims WHERE channel_id = ?', [channelId]);
	await kvDelete(conn, `Claims.${channelId}`);
}

async function getAppMap(conn, mapType, mapKey) {
	const [rows] = await conn.query(
		'SELECT payload FROM app_maps WHERE map_type = ? AND map_key = ?',
		[mapType, mapKey]
	);
	if (rows.length) return parseJson(rows[0].payload, rows[0].payload);
	const legacy = await kvGet(conn, `AppMap.${mapType}.${mapKey}`);
	if (legacy != null) {
		await setAppMap(conn, mapType, mapKey, legacy);
		await kvDelete(conn, `AppMap.${mapType}.${mapKey}`);
		return legacy;
	}
	return null;
}

async function setAppMap(conn, mapType, mapKey, payload) {
	await conn.query(
		`INSERT INTO app_maps (map_type, map_key, payload, updated_at)
		 VALUES (?, ?, ?, NOW())
		 ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = NOW()`,
		[mapType, mapKey, JSON.stringify(payload)]
	);
	await kvDelete(conn, `AppMap.${mapType}.${mapKey}`);
}

async function deleteAppMap(conn, mapType, mapKey) {
	await conn.query('DELETE FROM app_maps WHERE map_type = ? AND map_key = ?', [mapType, mapKey]);
	await kvDelete(conn, `AppMap.${mapType}.${mapKey}`);
}

async function getAllInterviewCleanups(conn) {
	const [rows] = await conn.query('SELECT channel_id, payload FROM interview_cleanups');
	const result = {};
	for (const row of rows) {
		result[row.channel_id] = parseJson(row.payload, {});
	}
	const legacy = await kvGet(conn, 'InterviewCleanup');
	if (legacy && typeof legacy === 'object') {
		for (const [channelId, payload] of Object.entries(legacy)) {
			if (!result[channelId]) {
				result[channelId] = payload;
				await setInterviewCleanup(conn, channelId, payload);
			}
		}
		await kvDelete(conn, 'InterviewCleanup');
	}
	return result;
}

async function getInterviewCleanup(conn, channelId) {
	const [rows] = await conn.query('SELECT payload FROM interview_cleanups WHERE channel_id = ?', [channelId]);
	if (rows.length) return parseJson(rows[0].payload, {});
	const all = await getAllInterviewCleanups(conn);
	return all[channelId] || null;
}

async function setInterviewCleanup(conn, channelId, payload) {
	await conn.query(
		`INSERT INTO interview_cleanups (channel_id, payload, updated_at)
		 VALUES (?, ?, NOW())
		 ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = NOW()`,
		[channelId, JSON.stringify(payload || {})]
	);
	await kvDelete(conn, `InterviewCleanup.${channelId}`);
}

async function setAllInterviewCleanups(conn, cleanups) {
	await conn.query('DELETE FROM interview_cleanups');
	const entries = Object.entries(cleanups || {});
	for (const [channelId, payload] of entries) {
		await setInterviewCleanup(conn, channelId, payload);
	}
	await kvDelete(conn, 'InterviewCleanup');
}

async function getFeatureFlag(conn, flagKey) {
	const [rows] = await conn.query('SELECT value FROM feature_flags WHERE flag_key = ?', [flagKey]);
	if (rows.length) return parseJson(rows[0].value, rows[0].value);
	const legacy = await kvGet(conn, flagKey);
	if (legacy != null) {
		await setFeatureFlag(conn, flagKey, legacy);
		await kvDelete(conn, flagKey);
		return legacy;
	}
	return null;
}

async function setFeatureFlag(conn, flagKey, value) {
	await conn.query(
		`INSERT INTO feature_flags (flag_key, value, updated_at)
		 VALUES (?, ?, NOW())
		 ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()`,
		[flagKey, JSON.stringify(value)]
	);
	await kvDelete(conn, flagKey);
}

async function getCounter(conn, name) {
	const [rows] = await conn.query('SELECT value FROM bot_counters WHERE counter_key = ?', [name]);
	if (rows.length) return Number(rows[0].value) || 0;
	const legacy = await kvGet(conn, name);
	if (legacy != null) {
		const num = Number(legacy) || 0;
		await setCounter(conn, name, num);
		await kvDelete(conn, name);
		return num;
	}
	return null;
}

async function setCounter(conn, name, value) {
	const num = Number(value) || 0;
	await conn.query(
		`INSERT INTO bot_counters (counter_key, value, updated_at)
		 VALUES (?, ?, NOW())
		 ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()`,
		[name, num]
	);
	await kvDelete(conn, name);
}

async function runtimeGet(conn, key) {
	const info = classifyKey(key);
	switch (info.type) {
		case 'forward':
			return getForward(conn, info.kind, info.messageId);
		case 'claim':
			return getClaim(conn, info.channelId);
		case 'appMap':
			return getAppMap(conn, info.mapType, info.mapKey);
		case 'interviewCleanup':
			if (!info.channelId) return getAllInterviewCleanups(conn);
			return getInterviewCleanup(conn, info.channelId);
		case 'featureFlag':
			return getFeatureFlag(conn, info.flagKey);
		case 'counter':
			return getCounter(conn, info.name);
		default:
			return kvGet(conn, key);
	}
}

async function runtimeSet(conn, key, value) {
	const info = classifyKey(key);
	switch (info.type) {
		case 'forward':
			if (info.fieldPath && info.fieldPath.length) {
				return mergeForwardField(conn, info.kind, info.messageId, info.fieldPath, value);
			}
			return setForward(conn, info.kind, info.messageId, value);
		case 'claim':
			return setClaim(conn, info.channelId, value);
		case 'appMap':
			return setAppMap(conn, info.mapType, info.mapKey, value);
		case 'interviewCleanup':
			if (!info.channelId) return setAllInterviewCleanups(conn, value || {});
			return setInterviewCleanup(conn, info.channelId, value);
		case 'featureFlag':
			return setFeatureFlag(conn, info.flagKey, value);
		case 'counter':
			return setCounter(conn, info.name, value);
		default:
			return kvSet(conn, key, value);
	}
}

async function runtimeDelete(conn, key) {
	const info = classifyKey(key);
	switch (info.type) {
		case 'forward':
			return deleteForward(conn, info.kind, info.messageId);
		case 'claim':
			return deleteClaim(conn, info.channelId);
		case 'appMap':
			return deleteAppMap(conn, info.mapType, info.mapKey);
		case 'interviewCleanup':
			if (!info.channelId) {
				await conn.query('DELETE FROM interview_cleanups');
				await kvDelete(conn, 'InterviewCleanup');
				return;
			}
			await conn.query('DELETE FROM interview_cleanups WHERE channel_id = ?', [info.channelId]);
			await kvDelete(conn, `InterviewCleanup.${info.channelId}`);
			return;
		case 'featureFlag':
			await conn.query('DELETE FROM feature_flags WHERE flag_key = ?', [info.flagKey]);
			await kvDelete(conn, info.flagKey);
			return;
		case 'counter':
			await conn.query('DELETE FROM bot_counters WHERE counter_key = ?', [info.name]);
			await kvDelete(conn, info.name);
			return;
		default:
			return kvDelete(conn, key);
	}
}

module.exports = {
	ensureRuntimeTables,
	runtimeGet,
	runtimeSet,
	runtimeDelete,
	classifyKey,
};
