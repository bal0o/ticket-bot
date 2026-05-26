const path = require('path');

function loadHandlerOptions() {
	try {
		return require('../content/handler/options.json');
	} catch (_) {
		return { options: {} };
	}
}

function getQuestionFileForType(ticketType) {
	if (!ticketType) return null;
	const handlerOptions = loadHandlerOptions();
	const key = Object.keys(handlerOptions.options || {}).find(k => k.toLowerCase() === String(ticketType).toLowerCase());
	if (!key) return null;
	const file = handlerOptions.options[key]?.question_file;
	if (!file) return null;
	try {
		return require(path.join('..', 'content', 'questions', file));
	} catch (_) {
		return null;
	}
}

function getAccessRolesForTicketType(ticketType, config) {
	const qf = getQuestionFileForType(ticketType);
	const roles = Array.isArray(qf?.['access-role-id']) ? qf['access-role-id'].filter(Boolean) : [];
	// Always include default admin if present
	if (config?.role_ids?.default_admin_role_id) {
		roles.push(config.role_ids.default_admin_role_id);
	}
	return Array.from(new Set(roles));
}

function userHasAccessToTicketType({ userRoleIds, ticketType, config, adminRoleIds = [] }) {
	const roleSet = new Set((userRoleIds || []).map(String));
	// Admins always allowed
	for (const rid of adminRoleIds) {
		if (roleSet.has(String(rid))) return true;
	}
	if (config?.role_ids?.default_admin_role_id && roleSet.has(String(config.role_ids.default_admin_role_id))) return true;
	const allowed = new Set(getAccessRolesForTicketType(ticketType, config).map(String));
	for (const rid of roleSet) {
		if (allowed.has(rid)) return true;
	}
	return false;
}

/**
 * Channel overwrites for a ticket — matches openTicket in functions.js (config roles only,
 * not category inheritance). Replaces all overwrites on move so old type roles lose access.
 */
function buildPermissionOverwritesForTicketType({ client, guild, ticketType, userId = null }) {
	const config = client?.config || {};
	const staffGuild = guild || (client && client.guilds && client.guilds.cache.get(config.channel_ids?.staff_guild_id));
	if (!staffGuild || !client?.user?.id) return [];

	const qf = getQuestionFileForType(ticketType);
	const accessRoleIDs = Array.isArray(qf?.['access-role-id']) ? qf['access-role-id'].filter(Boolean) : [];

	const overwrites = [
		{ id: staffGuild.id, deny: ['ViewChannel', 'AddReactions'] },
		{
			id: client.user.id,
			allow: ['ViewChannel', 'SendMessages', 'AddReactions', 'ManageThreads'],
		},
	];

	if (config?.role_ids?.default_admin_role_id) {
		overwrites.push({
			id: config.role_ids.default_admin_role_id,
			allow: ['ViewChannel', 'SendMessages'],
		});
	}

	const seen = new Set(overwrites.map((o) => String(o.id)));
	for (const roleId of accessRoleIDs) {
		if (!roleId || seen.has(String(roleId))) continue;
		seen.add(String(roleId));
		overwrites.push({ id: roleId, allow: ['ViewChannel', 'SendMessages'] });
	}

	if (qf?.internal && userId && /^\d{17,19}$/.test(String(userId)) && !seen.has(String(userId))) {
		overwrites.push({
			id: String(userId),
			allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
		});
	}

	return overwrites;
}

module.exports = {
	getQuestionFileForType,
	getAccessRolesForTicketType,
	userHasAccessToTicketType,
	buildPermissionOverwritesForTicketType
};


