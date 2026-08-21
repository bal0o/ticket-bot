const http = require('./http');

const API = 'https://discord.com/api/v10';

function botHeaders(token) {
	return {
		Authorization: `Bot ${token}`,
		'Content-Type': 'application/json',
	};
}

async function discordRequest(token, method, path, body, timeout = 10000) {
	const res = await http.request(`${API}${path}`, {
		method,
		headers: botHeaders(token),
		body,
		timeout,
	});
	if (!res.ok) {
		const err = new Error(`Discord API ${method} ${path} failed: ${res.status}`);
		err.status = res.status;
		err.data = res.data;
		throw err;
	}
	return res.data;
}

async function getGuildMember(token, guildId, userId) {
	return discordRequest(token, 'GET', `/guilds/${guildId}/members/${userId}`);
}

async function getUser(token, userId) {
	return discordRequest(token, 'GET', `/users/${userId}`);
}

async function getChannel(token, channelId) {
	return discordRequest(token, 'GET', `/channels/${channelId}`);
}

async function createGuildChannel(token, guildId, body) {
	return discordRequest(token, 'POST', `/guilds/${guildId}/channels`, body);
}

async function createMessage(token, channelId, body) {
	return discordRequest(token, 'POST', `/channels/${channelId}/messages`, body);
}

async function createDmChannel(token, recipientId) {
	return discordRequest(token, 'POST', `/users/@me/channels`, { recipient_id: recipientId });
}

async function sendDm(token, userId, contentOrBody) {
	const channel = await createDmChannel(token, userId);
	if (!channel?.id) return null;
	const body = typeof contentOrBody === 'string'
		? { content: contentOrBody }
		: contentOrBody;
	return createMessage(token, channel.id, body);
}

async function startThreadFromMessage(token, channelId, messageId, body) {
	return discordRequest(token, 'POST', `/channels/${channelId}/messages/${messageId}/threads`, body);
}

async function createChannelThread(token, channelId, body) {
	return discordRequest(token, 'POST', `/channels/${channelId}/threads`, body);
}

async function exchangeOauthCode({ clientId, clientSecret, code, redirectUri }) {
	const params = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
	});
	const res = await http.request(`${API}/oauth2/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params.toString(),
		timeout: 10000,
		json: true,
	});
	if (!res.ok) {
		const err = new Error('OAuth token exchange failed');
		err.status = res.status;
		err.data = res.data;
		throw err;
	}
	return res.data;
}

async function fetchOauthUser(accessToken) {
	const res = await http.request(`${API}/users/@me`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${accessToken}` },
		timeout: 10000,
	});
	if (!res.ok) {
		const err = new Error('OAuth user fetch failed');
		err.status = res.status;
		err.data = res.data;
		throw err;
	}
	return res.data;
}

function oauthAuthorizeUrl({ clientId, redirectUri, scopes, state }) {
	const params = new URLSearchParams({
		client_id: clientId,
		response_type: 'code',
		redirect_uri: redirectUri,
		scope: Array.isArray(scopes) ? scopes.join(' ') : String(scopes || 'identify'),
	});
	if (state) params.set('state', state);
	return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

module.exports = {
	getGuildMember,
	getUser,
	getChannel,
	createGuildChannel,
	createMessage,
	createDmChannel,
	sendDm,
	startThreadFromMessage,
	createChannelThread,
	exchangeOauthCode,
	fetchOauthUser,
	oauthAuthorizeUrl,
};
