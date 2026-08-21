const { Client, Collection, GatewayIntentBits, Partials } = require("discord.js");

function publicClient(client) {
	return (client && client.bots && client.bots.public) || client;
}

function staffClient(client) {
	return (client && client.bots && client.bots.staff) || client;
}

function staffGuild(client) {
	const staff = staffClient(client);
	const id = staff && staff.config && staff.config.channel_ids && staff.config.channel_ids.staff_guild_id;
	if (!staff || !id) return null;
	return staff.guilds.cache.get(id) || null;
}

function publicGuild(client) {
	const pub = publicClient(client);
	const id = pub && pub.config && pub.config.channel_ids && pub.config.channel_ids.public_guild_id;
	if (!pub || !id) return null;
	return pub.guilds.cache.get(id) || null;
}

function botUserIds(client) {
	const ids = new Set();
	if (client && client.user && client.user.id) ids.add(client.user.id);
	if (client && client.bots) {
		if (client.bots.public && client.bots.public.user && client.bots.public.user.id) ids.add(client.bots.public.user.id);
		if (client.bots.staff && client.bots.staff.user && client.bots.staff.user.id) ids.add(client.bots.staff.user.id);
	}
	return ids;
}

function isOurBotId(client, userId) {
	if (!userId) return false;
	return botUserIds(client).has(String(userId));
}

async function fetchDmUser(client, userId) {
	if (!userId) return null;
	const pub = publicClient(client);
	if (!pub || !pub.users) return null;
	try {
		return await pub.users.fetch(userId);
	} catch (_) {
		return null;
	}
}

async function fetchStaffChannel(client, channelId) {
	if (!channelId) return null;
	const staff = staffClient(client);
	if (!staff || !staff.channels) return null;
	try {
		return await staff.channels.fetch(channelId);
	} catch (_) {
		return null;
	}
}

async function fetchPublicChannel(client, channelId) {
	if (!channelId) return null;
	const pub = publicClient(client);
	if (!pub || !pub.channels) return null;
	try {
		return await pub.channels.fetch(channelId);
	} catch (_) {
		return null;
	}
}

function findCachedChannel(client, channelId) {
	if (!client || !channelId) return null;
	const staff = staffClient(client);
	const pub = publicClient(client);
	return (staff && staff.channels.cache.get(channelId))
		|| (pub && pub.channels.cache.get(channelId))
		|| null;
}

async function fetchGuildChannel(client, guildId, channelId) {
	if (!client || !channelId) return null;
	const id = String(channelId);
	const cached = client.channels.cache.get(id);
	if (cached) return cached;
	if (guildId) {
		let guild = client.guilds.cache.get(String(guildId));
		if (!guild) {
			try { guild = await client.guilds.fetch(String(guildId)); } catch (_) { guild = null; }
		}
		if (guild) {
			const fromGuild = guild.channels.cache.get(id);
			if (fromGuild) return fromGuild;
			try { return await guild.channels.fetch(id); } catch (_) {}
		}
	}
	try { return await client.channels.fetch(id); } catch (_) { return null; }
}

function createClients(config) {
	const shared = {
		commands: new Collection(),
		blocked_users: new Set(),
		cooldown: new Set(),
		claims: new Map(),
		replyContext: new Map(),
		config
	};

	const publicBot = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.DirectMessages
		],
		partials: [
			Partials.Message,
			Partials.Channel
		]
	});

	const staffBot = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessageReactions,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent
		],
		partials: [
			Partials.Message,
			Partials.Channel,
			Partials.Reaction,
			Partials.GuildMember
		]
	});

	shared.bots = { public: publicBot, staff: staffBot };

	for (const c of [publicBot, staffBot]) {
		c.commands = shared.commands;
		c.blocked_users = shared.blocked_users;
		c.cooldown = shared.cooldown;
		c.claims = shared.claims;
		c.replyContext = shared.replyContext;
		c.config = shared.config;
		c.bots = shared.bots;
	}

	publicBot.botRole = "public";
	staffBot.botRole = "staff";

	return { publicClient: publicBot, staffClient: staffBot };
}

function warnWrongGuilds(publicBot, staffBot, config, logger) {
	const publicGuildId = config.channel_ids && config.channel_ids.public_guild_id;
	const staffGuildId = config.channel_ids && config.channel_ids.staff_guild_id;
	if (publicGuildId && staffBot.guilds.cache.has(publicGuildId)) {
		logger.error("[Bots] Staff bot is in the public guild. Remove it or Message Content will hit the 10k-user review gate.");
	}
	if (staffGuildId && publicBot.guilds.cache.has(staffGuildId)) {
		logger.warn("[Bots] Public bot is still in the staff guild. Kick it from the staff server so only the staff bot handles ticket channels.");
	}
}

module.exports = {
	publicClient,
	staffClient,
	staffGuild,
	publicGuild,
	botUserIds,
	isOurBotId,
	fetchDmUser,
	fetchStaffChannel,
	fetchPublicChannel,
	findCachedChannel,
	fetchGuildChannel,
	createClients,
	warnWrongGuilds
};
