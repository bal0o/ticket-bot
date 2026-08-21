const http = require('./http');

async function findSteamIdByDiscord(client, discordId) {
	const secret = client?.config?.tokens?.Linking_System_API_Key_Or_Secret;
	const linkingSystem = Number(client?.config?.linking_settings?.linkingSystem);
	if (!secret || !linkingSystem) return null;

	try {
		if (linkingSystem === 1) {
			const base = client.config.linking_settings.verify_link;
			if (!base) return null;
			const res = await http.get(
				`${base}/api.php?action=findByDiscord&id=${discordId}&secret=${secret}`,
				{ timeout: 10000, json: true }
			);
			let body = res.data;
			if (typeof body === 'string') {
				const trimmed = body.trim();
				if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
					try { body = JSON.parse(trimmed); } catch (_) { body = trimmed.slice(1, -1); }
				} else {
					body = trimmed;
				}
			}
			const steamId = body == null ? '' : String(body).trim();
			if (steamId.startsWith('7656119')) return steamId;
			return null;
		}

		if (linkingSystem === 2) {
			const res = await http.get(
				`https://api.steamcord.io/players?discordId=${discordId}`,
				{
					timeout: 10000,
					headers: {
						Authorization: `Bearer ${secret}`,
						'Content-Type': 'application/json',
					},
				}
			);
			const id = res.data?.[0]?.steamAccounts?.[0]?.steamId;
			if (id && String(id).startsWith('7656119')) return String(id);
			return null;
		}

		if (linkingSystem === 3) {
			const res = await http.get(
				`https://link.platformsync.io/api.php?id=${discordId}&token=${secret}`,
				{ timeout: 10000 }
			);
			if (res.data?.linked === true && res.data?.steam_id && String(res.data.steam_id).startsWith('7656119')) {
				return String(res.data.steam_id);
			}
			return null;
		}
	} catch (_) {
		return null;
	}

	return null;
}

async function fetchBattlemetricsPlayer(steamId, token) {
	if (!steamId || !token) return null;
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: 'application/json',
	};
	const playerUrl = `https://api.battlemetrics.com/players?filter[search]=${encodeURIComponent(steamId)}&include=identifier,server`;
	const bmResponse = await http.get(playerUrl, { headers, timeout: 10000 });
	if (!bmResponse.ok || !bmResponse.data?.data?.length) return null;

	const playerData = bmResponse.data.data[0];
	const playerId = playerData.id;
	let inGameName = null;
	let mostRecentServer = null;
	let mostRecentServerId = null;
	let timePlayed = null;
	let firstSeen = null;
	let lastSeen = null;

	if (bmResponse.data.included) {
		for (const inc of bmResponse.data.included) {
			if (inc.type === 'identifier' && inc.attributes?.type === 'name' && !inGameName) {
				inGameName = inc.attributes.identifier;
			}
		}
	}

	if (playerData.relationships?.servers?.data?.length) {
		const servers = playerData.relationships.servers.data.slice();
		servers.sort((a, b) => String(b.meta?.lastSeen || '').localeCompare(String(a.meta?.lastSeen || '')));
		const recentServer = servers[0];
		const sid = recentServer?.id;
		mostRecentServerId = sid || null;
		timePlayed = recentServer?.meta?.timePlayed || null;
		firstSeen = recentServer?.meta?.firstSeen || null;
		lastSeen = recentServer?.meta?.lastSeen || null;
		if (sid && bmResponse.data.included) {
			const serverObj = bmResponse.data.included.find(i => i.type === 'server' && String(i.id) === String(sid));
			mostRecentServer = serverObj?.attributes?.name || null;
		}
	}

	let banCount = 0;
	try {
		const bansUrl = `https://api.battlemetrics.com/bans?filter[player]=${playerId}&include=server`;
		const bansResponse = await http.get(bansUrl, { headers, timeout: 10000 });
		if (bansResponse.ok && Array.isArray(bansResponse.data?.data)) {
			banCount = bansResponse.data.data.length;
		}
	} catch (_) {}

	return {
		playerId,
		inGameName,
		name: inGameName,
		mostRecentServer,
		mostRecentServerId,
		timePlayed,
		firstSeen,
		lastSeen,
		banCount,
	};
}

async function fetchCheetosReport(discordId, cheetosToken, requestorId) {
	if (!discordId || !cheetosToken) return null;
	const url = `https://Cheetos.gg/api.php?action=search&id=${encodeURIComponent(discordId)}`;
	const res = await http.get(url, {
		timeout: 10000,
		json: false,
		headers: {
			'Auth-Key': cheetosToken,
			DiscordID: String(requestorId || ''),
			Accept: 'text/plain',
			'User-Agent': 'ticket-bot (Discord.js)',
		},
	});
	return typeof res.data === 'string' ? res.data : String(res.data || '');
}

module.exports = {
	findSteamIdByDiscord,
	fetchBattlemetricsPlayer,
	fetchCheetosReport,
};
