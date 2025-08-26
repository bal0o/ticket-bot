const path = require('path');

let _handlerOptions = null;
let _questionFiles = new Map();

function loadHandlerOptions() {
	if (_handlerOptions) return _handlerOptions;
	try {
		_handlerOptions = require('../content/handler/options.json');
		return _handlerOptions;
	} catch (_) {
		return { options: {} };
	}
}

function getQuestionFileForType(ticketType) {
	if (!ticketType) return null;
	
	// Check cache first
	if (_questionFiles.has(ticketType)) {
		return _questionFiles.get(ticketType);
	}
	
	const handlerOptions = loadHandlerOptions();
	const key = Object.keys(handlerOptions.options || {}).find(k => k.toLowerCase() === String(ticketType).toLowerCase());
	if (!key) return null;
	
	const file = handlerOptions.options[key]?.question_file;
	if (!file) return null;
	
	try {
		const questionFile = require(path.join('..', 'content', 'questions', file));
		// Cache the result
		_questionFiles.set(ticketType, questionFile);
		return questionFile;
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

function buildPermissionOverwritesForTicketType({ client, guild, ticketType }) {
	const config = client?.config || {};
	const staffGuild = guild || (client && client.guilds && client.guilds.cache.get(config.channel_ids?.staff_guild_id));
	if (!staffGuild) return [];
	const everyoneId = staffGuild.id;
	const botId = client.user.id;
	const accessRoles = getAccessRolesForTicketType(ticketType, config);
	const overwrites = [
		{ id: everyoneId, deny: ['VIEW_CHANNEL', 'ADD_REACTIONS'] },
		{ id: botId, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'ADD_REACTIONS', 'MANAGE_THREADS'] }
	];
	// Add each access role with basic view/send
	for (const roleId of accessRoles) {
		overwrites.push({ id: roleId, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] });
	}
	return overwrites;
}

module.exports = {
	getQuestionFileForType,
	getAccessRolesForTicketType,
	userHasAccessToTicketType,
	buildPermissionOverwritesForTicketType
};


