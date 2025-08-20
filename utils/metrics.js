const client = require('prom-client');
const { QuickDB } = require('quick.db');
const kv = new QuickDB();

// Create a singleton registry
const registry = new client.Registry();

// Gauges
const openTicketsGauge = new client.Gauge({
	name: 'ticketbot_open_tickets',
	help: 'Current number of open ticket channels',
});

// Counters
const ticketsOpenedCounter = new client.Counter({
	name: 'ticketbot_tickets_opened_total',
	help: 'Total tickets opened',
	labelNames: ['type', 'server']
});

const userTicketsOpenedCounter = new client.Counter({
	name: 'ticketbot_user_tickets_opened_total',
	help: 'Tickets opened per user',
	labelNames: ['opened_by', 'type', 'server']
});

const ticketsClosedCounter = new client.Counter({
	name: 'ticketbot_tickets_closed_total',
	help: 'Total tickets closed',
	labelNames: ['type', 'closed_by']
});

const staffActionsCounter = new client.Counter({
	name: 'ticketbot_staff_actions_total',
	help: 'Total staff actions',
	labelNames: ['action', 'type', 'staff_id']
});

const ticketsClaimedCounter = new client.Counter({
	name: 'ticketbot_tickets_claimed_total',
	help: 'Total ticket claims',
	labelNames: ['type']
});

// Aggregates for duration and message counts across tickets (restart-safe via persisted totals)
const ticketDurationSumCounter = new client.Counter({
	name: 'ticketbot_ticket_duration_seconds_sum',
	help: 'Sum of ticket open durations in seconds',
	labelNames: ['type', 'server']
});

const ticketDurationCountCounter = new client.Counter({
	name: 'ticketbot_ticket_duration_tickets_total',
	help: 'Number of closed tickets contributing to duration sum',
	labelNames: ['type', 'server']
});

const ticketMessagesTotalCounter = new client.Counter({
	name: 'ticketbot_ticket_messages_total',
	help: 'Total messages counted across tickets',
	labelNames: ['type', 'server']
});

const ticketUserMessagesTotalCounter = new client.Counter({
	name: 'ticketbot_ticket_user_messages_total',
	help: 'Total end-user messages across tickets',
	labelNames: ['type', 'server']
});

const ticketStaffMessagesTotalCounter = new client.Counter({
	name: 'ticketbot_ticket_staff_messages_total',
	help: 'Total staff messages across tickets',
	labelNames: ['type', 'server']
});

// User-specific metrics counters
const userTicketDurationSumCounter = new client.Counter({
	name: 'ticketbot_user_ticket_duration_seconds_sum',
	help: 'Sum of ticket open durations in seconds per user',
	labelNames: ['opened_by', 'type', 'server']
});

const userTicketDurationCountCounter = new client.Counter({
	name: 'ticketbot_user_ticket_duration_tickets_total',
	help: 'Number of closed tickets contributing to duration sum per user',
	labelNames: ['opened_by', 'type', 'server']
});

const userTicketMessagesTotalCounter = new client.Counter({
	name: 'ticketbot_user_ticket_messages_total',
	help: 'Total messages counted across tickets per user',
	labelNames: ['opened_by', 'type', 'server']
});

registry.registerMetric(openTicketsGauge);
registry.registerMetric(ticketsOpenedCounter);
registry.registerMetric(userTicketsOpenedCounter);
registry.registerMetric(ticketsClosedCounter);
registry.registerMetric(staffActionsCounter);
registry.registerMetric(ticketsClaimedCounter);
registry.registerMetric(ticketDurationSumCounter);
registry.registerMetric(ticketDurationCountCounter);
registry.registerMetric(ticketMessagesTotalCounter);
registry.registerMetric(ticketUserMessagesTotalCounter);
registry.registerMetric(ticketStaffMessagesTotalCounter);
registry.registerMetric(userTicketDurationSumCounter);
registry.registerMetric(userTicketDurationCountCounter);
registry.registerMetric(userTicketMessagesTotalCounter);

module.exports = {
	registry,
	setOpenTickets: (count) => openTicketsGauge.set(count || 0),
	// Increment and persist totals
	ticketOpened: (type, server, openedBy) => {
		const t = type || 'unknown';
		const s = server || 'unknown';
		const ob = String(openedBy || 'unknown');
		ticketsOpenedCounter.inc({ type: t, server: s });
		userTicketsOpenedCounter.inc({ opened_by: ob, type: t, server: s });
		kv.add(`Metrics.total.ticketsOpened.${t}.${s}`, 1).catch(()=>{});
		kv.add(`Metrics.total.user.ticketsOpened.${ob}.${t}.${s}`, 1).catch(()=>{});
	},
	ticketClosed: (type, closedBy) => {
		const t = type || 'unknown';
		const cb = String(closedBy || 'unknown');
		ticketsClosedCounter.inc({ type: t, closed_by: cb });
		kv.add(`Metrics.total.ticketsClosed.${t}.${cb}`, 1).catch(()=>{});
	},
	staffAction: (action, type, staffId) => {
		const a = action || 'unknown';
		const t = type || 'unknown';
		const s = String(staffId || 'unknown');
		staffActionsCounter.inc({ action: a, type: t, staff_id: s });
		kv.add(`Metrics.total.staffActions.${a}.${t}.${s}`, 1).catch(()=>{});
	},
	ticketClaimed: (type) => {
		const t = type || 'unknown';
		ticketsClaimedCounter.inc({ type: t });
		kv.add(`Metrics.total.ticketsClaimed.${t}`, 1).catch(()=>{});
	},
	// Record per-ticket aggregates for duration and message totals
	recordTicketAggregates: (type, server, durationSeconds, messageCount, userMessages, staffMessages, openedBy) => {
		const t = type || 'unknown';
		const s = server || 'unknown';
		const ob = String(openedBy || 'unknown');
		const dur = Math.max(0, Math.floor(durationSeconds || 0));
		const msgs = Math.max(0, Math.floor(messageCount || 0));
		if (dur > 0) ticketDurationSumCounter.inc({ type: t, server: s }, dur);
		ticketDurationCountCounter.inc({ type: t, server: s }, 1);
		if (msgs > 0) ticketMessagesTotalCounter.inc({ type: t, server: s }, msgs);
		kv.add(`Metrics.total.duration.sum.${t}.${s}`, dur).catch(()=>{});
		kv.add(`Metrics.total.duration.count.${t}.${s}`, 1).catch(()=>{});
		kv.add(`Metrics.total.messages.${t}.${s}`, msgs).catch(()=>{});
		const um = Math.max(0, Math.floor(userMessages || 0));
		const sm = Math.max(0, Math.floor(staffMessages || 0));
		if (um > 0) ticketUserMessagesTotalCounter.inc({ type: t, server: s }, um);
		if (sm > 0) ticketStaffMessagesTotalCounter.inc({ type: t, server: s }, sm);
		kv.add(`Metrics.total.messages.user.${t}.${s}`, um).catch(()=>{});
		kv.add(`Metrics.total.messages.staff.${t}.${s}`, sm).catch(()=>{});
		// Per-user aggregates
		if (dur > 0) {
			userTicketDurationSumCounter.inc({ opened_by: ob, type: t, server: s }, dur);
			kv.add(`Metrics.total.user.duration.sum.${ob}.${t}.${s}`, dur).catch(()=>{});
		}
		userTicketDurationCountCounter.inc({ opened_by: ob, type: t, server: s }, 1);
		kv.add(`Metrics.total.user.duration.count.${ob}.${t}.${s}`, 1).catch(()=>{});
		if (msgs > 0) {
			userTicketMessagesTotalCounter.inc({ opened_by: ob, type: t, server: s }, msgs);
			kv.add(`Metrics.total.user.messages.${ob}.${t}.${s}`, msgs).catch(()=>{});
		}
	},
	// Hydrate counters from persisted totals on startup to avoid resets breaking graphs
	initPersisted: async () => {
		try {
			// Get all available ticket types and servers from configuration
			const handlerRaw = require("../content/handler/options.json");
			const allTicketTypes = Object.keys(handlerRaw.options);
			const allServers = ['EU1', 'EU2', 'EU3', 'EU4', 'EU5', 'US1', 'US2', 'US3', 'US4', 'US5']; // All configured servers
			
			// Note: We can't get actual user IDs here since we don't have guild access
			// The detailed initialization with actual user IDs happens in initStaffMetrics() after bot is ready
			
			// Initialize all ticket types and servers with 0 values to ensure Grafana graphs start properly
			for (const ticketType of allTicketTypes) {
				for (const server of allServers) {
					// Initialize counters with 0 to ensure labels exist
					ticketsOpenedCounter.inc({ type: ticketType, server: server }, 0);
					ticketsClaimedCounter.inc({ type: ticketType }, 0);
					ticketDurationSumCounter.inc({ type: ticketType, server: server }, 0);
					ticketDurationCountCounter.inc({ type: ticketType, server: server }, 0);
					ticketMessagesTotalCounter.inc({ type: ticketType, server: server }, 0);
					ticketUserMessagesTotalCounter.inc({ type: ticketType, server: server }, 0);
					ticketStaffMessagesTotalCounter.inc({ type: ticketType, server: server }, 0);
				}
				

			}
			


			let opened = await kv.get('Metrics.total.ticketsOpened') || {};
			for (const t of Object.keys(opened)) {
				const byServer = opened[t] || {};
				for (const s of Object.keys(byServer)) {
					const v = byServer[s] || 0;
					if (v > 0) ticketsOpenedCounter.inc({ type: t, server: s }, v);
				}
			}
			let userOpened = await kv.get('Metrics.total.user.ticketsOpened') || {};
			for (const ob of Object.keys(userOpened)) {
				const byType = userOpened[ob] || {};
				for (const t of Object.keys(byType)) {
					const byServer = byType[t] || {};
					for (const s of Object.keys(byServer)) {
						const v = byServer[s] || 0;
						if (v > 0) userTicketsOpenedCounter.inc({ opened_by: ob, type: t, server: s }, v);
					}
				}
			}
			let closed = await kv.get('Metrics.total.ticketsClosed') || {};
			for (const t of Object.keys(closed)) {
				const byCloser = closed[t] || {};
				for (const cb of Object.keys(byCloser)) {
					const v = byCloser[cb] || 0;
					if (v > 0) ticketsClosedCounter.inc({ type: t, closed_by: cb }, v);
				}
			}
			let actions = await kv.get('Metrics.total.staffActions') || {};
			for (const a of Object.keys(actions)) {
				const byType = actions[a] || {};
				for (const t of Object.keys(byType)) {
					const byStaff = byType[t] || {};
					for (const s of Object.keys(byStaff)) {
						const v = byStaff[s] || 0;
						if (v > 0) staffActionsCounter.inc({ action: a, type: t, staff_id: s }, v);
					}
				}
			}
			let claimed = await kv.get('Metrics.total.ticketsClaimed') || {};
			for (const t of Object.keys(claimed)) {
				const v = claimed[t] || 0;
				if (v > 0) ticketsClaimedCounter.inc({ type: t }, v);
			}
			// Duration and messages aggregates
			let durSum = await kv.get('Metrics.total.duration.sum') || {};
			for (const t of Object.keys(durSum)) {
				for (const s of Object.keys(durSum[t] || {})) {
					const v = durSum[t][s] || 0;
					if (v > 0) ticketDurationSumCounter.inc({ type: t, server: s }, v);
				}
			}
			let durCount = await kv.get('Metrics.total.duration.count') || {};
			for (const t of Object.keys(durCount)) {
				for (const s of Object.keys(durCount[t] || {})) {
					const v = durCount[t][s] || 0;
					if (v > 0) ticketDurationCountCounter.inc({ type: t, server: s }, v);
				}
			}
			let msgsTotal = await kv.get('Metrics.total.messages') || {};
			for (const t of Object.keys(msgsTotal)) {
				for (const s of Object.keys(msgsTotal[t] || {})) {
					const v = msgsTotal[t][s] || 0;
					if (v > 0) ticketMessagesTotalCounter.inc({ type: t, server: s }, v);
				}
			}
			let userMsgs = await kv.get('Metrics.total.messages.user') || {};
			for (const t of Object.keys(userMsgs)) {
				for (const s of Object.keys(userMsgs[t] || {})) {
					const v = userMsgs[t][s] || 0;
					if (v > 0) ticketUserMessagesTotalCounter.inc({ type: t, server: s }, v);
				}
			}
			let staffMsgs = await kv.get('Metrics.total.messages.staff') || {};
			for (const t of Object.keys(staffMsgs)) {
				for (const s of Object.keys(staffMsgs[t] || {})) {
					const v = staffMsgs[t][s] || 0;
					if (v > 0) ticketStaffMessagesTotalCounter.inc({ type: t, server: s }, v);
				}
			}
			// If totals are empty (first run), rebuild from existing DB so counters are not zeroed on restart
			const needRebuild = (Object.keys(opened).length === 0) && (Object.keys(closed).length === 0) && (Object.keys(actions).length === 0) && (Object.keys(claimed).length === 0);
			if (needRebuild) {
				const ps = await kv.get('PlayerStats');
				const openedAgg = {};
				const userOpenedAgg = {};
				const closedAgg = {};
				if (ps && typeof ps === 'object') {
					for (const userId of Object.keys(ps)) {
						const logs = ps[userId]?.ticketLogs || {};
						for (const ticketId of Object.keys(logs)) {
							const t = logs[ticketId] || {};
							const type = (t.ticketType || 'unknown');
							const server = (t.server || 'unknown');
							openedAgg[type] = openedAgg[type] || {};
							openedAgg[type][server] = (openedAgg[type][server] || 0) + 1;
							userOpenedAgg[userId] = userOpenedAgg[userId] || {};
							userOpenedAgg[userId][type] = userOpenedAgg[userId][type] || {};
							userOpenedAgg[userId][type][server] = (userOpenedAgg[userId][type][server] || 0) + 1;
							if (t.closeUserID || t.closeUser) {
								const cb = String(t.closeUserID || t.closeUser || 'unknown');
								closedAgg[type] = closedAgg[type] || {};
								closedAgg[type][cb] = (closedAgg[type][cb] || 0) + 1;
							}
						}
					}
				}
				await kv.set('Metrics.total.ticketsOpened', openedAgg).catch(()=>{});
				await kv.set('Metrics.total.user.ticketsOpened', userOpenedAgg).catch(()=>{});
				await kv.set('Metrics.total.ticketsClosed', closedAgg).catch(()=>{});
				// hydrate the counters
				for (const t of Object.keys(openedAgg)) {
					for (const s of Object.keys(openedAgg[t])) {
						const v = openedAgg[t][s];
						if (v > 0) ticketsOpenedCounter.inc({ type: t, server: s }, v);
					}
				}
				for (const ob of Object.keys(userOpenedAgg)) {
					for (const t of Object.keys(userOpenedAgg[ob] || {})) {
						for (const s of Object.keys(userOpenedAgg[ob][t] || {})) {
							const v = userOpenedAgg[ob][t][s] || 0;
							if (v > 0) userTicketsOpenedCounter.inc({ opened_by: ob, type: t, server: s }, v);
						}
					}
				}
				for (const t of Object.keys(closedAgg)) {
					for (const cb of Object.keys(closedAgg[t])) {
						const v = closedAgg[t][cb];
						if (v > 0) ticketsClosedCounter.inc({ type: t, closed_by: cb }, v);
					}
				}
				// Staff actions/claims are optional to rebuild; skip to avoid heavy scans
			}
		} catch (_) {}
	},
	
	// Initialize metrics with actual staff user IDs from roles (called after bot is ready)
	initStaffMetrics: async (client) => {
		try {
			if (!client || !client.guilds) {
				console.log('[Metrics] Client not ready, cannot initialize staff metrics');
				return;
			}
			
			console.log(`[Metrics] Client config:`, {
				hasConfig: !!client.config,
				hasChannelIds: !!client.config?.channel_ids,
				staffGuildId: client.config?.channel_ids?.staff_guild_id,
				availableGuilds: Array.from(client.guilds.cache.keys())
			});
			
			const staffGuild = client.guilds.cache.get(client.config?.channel_ids?.staff_guild_id);
			if (!staffGuild) {
				console.log('[Metrics] Staff guild not found, cannot initialize staff metrics');
				return;
			}
			
			console.log(`[Metrics] Found staff guild: ${staffGuild.name} (${staffGuild.id})`);
			console.log(`[Metrics] Guild has ${staffGuild.roles.cache.size} roles and ${staffGuild.members.cache.size} members`);
			
			// Try to fetch members if the cache is empty
			if (staffGuild.members.cache.size === 0) {
				console.log('[Metrics] Guild member cache is empty, attempting to fetch members...');
				try {
					await staffGuild.members.fetch();
					console.log(`[Metrics] After fetch: Guild now has ${staffGuild.members.cache.size} members`);
				} catch (fetchError) {
					console.error('[Metrics] Error fetching guild members:', fetchError);
				}
			}
			
			const handlerRaw = require("../content/handler/options.json");
			const allTicketTypes = Object.keys(handlerRaw.options);
			
			// Get all unique user IDs from access roles across all ticket types
			const allStaffUserIds = new Set();
			for (const ticketType of allTicketTypes) {
				try {
					const questionFile = require(`../content/questions/${handlerRaw.options[ticketType].question_file}`);
					if (questionFile["access-role-id"] && Array.isArray(questionFile["access-role-id"])) {
						console.log(`[Metrics] Processing ${ticketType} with access roles:`, questionFile["access-role-id"]);
						for (const roleId of questionFile["access-role-id"]) {
							if (!roleId) continue;
							const role = staffGuild.roles.cache.get(roleId);
							if (role) {
								console.log(`[Metrics] Found role ${role.name} (${role.id}) with ${role.members?.size || 0} members`);
								
								// Try to fetch role members if they're not loaded
								if (role.members && role.members.size === 0) {
									console.log(`[Metrics] Role ${role.name} has no members in cache, attempting to fetch...`);
									try {
										await role.members.fetch();
										console.log(`[Metrics] After fetch: Role ${role.name} now has ${role.members.size} members`);
									} catch (fetchError) {
										console.error(`[Metrics] Error fetching members for role ${role.name}:`, fetchError);
									}
								}
								
								if (role.members && role.members.size > 0) {
									// Add all user IDs from this role
									for (const [userId, member] of role.members) {
										allStaffUserIds.add(userId);
										console.log(`[Metrics] Added staff member: ${member.user?.tag || userId} (${userId})`);
									}
								} else {
									console.log(`[Metrics] Warning: Role ${role.name} still has no members after fetch attempt`);
								}
							} else {
								console.log(`[Metrics] Warning: Role ID ${roleId} not found in guild`);
							}
						}
					}
				} catch (error) {
					console.error(`[Metrics] Error processing ${ticketType}:`, error);
				}
			}
			
			console.log(`[Metrics] Initializing staff metrics for ${allStaffUserIds.size} staff members across ${allTicketTypes.length} ticket types`);
			
			if (allStaffUserIds.size === 0) {
				console.log('[Metrics] Warning: No staff members found! This may indicate an issue with role configuration or guild access.');
				return;
			}
			
			// Initialize metrics for all staff members
			for (const ticketType of allTicketTypes) {
				// Initialize "closed by" metrics for all staff members
				for (const staffId of allStaffUserIds) {
					ticketsClosedCounter.inc({ type: ticketType, closed_by: staffId }, 0);
				}
				
				// Initialize staff actions counter for all staff members
				for (const staffId of allStaffUserIds) {
					staffActionsCounter.inc({ action: 'openticket', type: ticketType, staff_id: staffId }, 0);
					staffActionsCounter.inc({ action: 'closeticket', type: ticketType, staff_id: staffId }, 0);
					staffActionsCounter.inc({ action: 'moveticket', type: ticketType, staff_id: staffId }, 0);
					staffActionsCounter.inc({ action: 'claimticket', type: ticketType, staff_id: staffId }, 0);
				}
				
				// Initialize tickets claimed counter for this ticket type
				ticketsClaimedCounter.inc({ type: ticketType }, 0);
			}
			
			console.log(`[Metrics] Staff metrics initialization complete`);
		} catch (error) {
			console.error(`[Metrics] Error initializing staff metrics:`, error);
		}
	},
	
	// Clean up incorrect role IDs from metrics database and replace with actual user IDs
	cleanupRoleIds: async (client) => {
		try {
			if (!client || !client.guilds) {
				console.log('[Metrics] Client not ready, cannot cleanup role IDs');
				return;
			}
			
			const staffGuild = client.guilds.cache.get(client.config?.channel_ids?.staff_guild_id);
			if (!staffGuild) {
				console.log('[Metrics] Staff guild not found, cannot cleanup role IDs');
				return;
			}
			
			console.log('[Metrics] Starting cleanup of incorrect role IDs from metrics database...');
			
			// Get all access role IDs from question files
			const handlerRaw = require("../content/handler/options.json");
			const allTicketTypes = Object.keys(handlerRaw.options);
			const roleIdsToClean = new Set();
			
			for (const ticketType of allTicketTypes) {
				try {
					const questionFile = require(`../content/questions/${handlerRaw.options[ticketType].question_file}`);
					if (questionFile["access-role-id"] && Array.isArray(questionFile["access-role-id"])) {
						questionFile["access-role-id"].forEach(roleId => {
							if (roleId) roleIdsToClean.add(roleId);
						});
					}
				} catch (_) {}
			}
			
			console.log(`[Metrics] Found ${roleIdsToClean.size} role IDs to clean up`);
			
			// Clean up ticketsClosedCounter - remove role IDs and add actual user IDs
			let cleaned = 0;
			for (const ticketType of allTicketTypes) {
				for (const roleId of roleIdsToClean) {
					// Check if this role ID exists in the database
					const existingValue = await kv.get(`Metrics.total.ticketsClosed.${ticketType}.${roleId}`);
					if (existingValue && existingValue > 0) {
						console.log(`[Metrics] Cleaning up ticketsClosed for ${ticketType} - role ${roleId} (value: ${existingValue})`);
						
						// Get actual user IDs from this role
						const role = staffGuild.roles.cache.get(roleId);
						if (role && role.members && role.members.size > 0) {
							// Distribute the value among actual users (simple approach: give to first user)
							const firstUserId = role.members.firstKey();
							if (firstUserId) {
								await kv.set(`Metrics.total.ticketsClosed.${ticketType}.${firstUserId}`, existingValue);
								console.log(`[Metrics] Moved ${existingValue} closed tickets from role ${roleId} to user ${firstUserId}`);
							}
						}
						
						// Remove the role ID entry
						await kv.delete(`Metrics.total.ticketsClosed.${ticketType}.${roleId}`);
						cleaned++;
					}
				}
			}
			
			// Clean up staffActionsCounter - remove role IDs and add actual user IDs
			for (const action of ['openticket', 'closeticket', 'moveticket', 'claimticket']) {
				for (const ticketType of allTicketTypes) {
					for (const roleId of roleIdsToClean) {
						const existingValue = await kv.get(`Metrics.total.staffActions.${action}.${ticketType}.${roleId}`);
						if (existingValue && existingValue > 0) {
							console.log(`[Metrics] Cleaning up staffActions for ${action} ${ticketType} - role ${roleId} (value: ${existingValue})`);
							
							// Get actual user IDs from this role
							const role = staffGuild.roles.cache.get(roleId);
							if (role && role.members && role.members.size > 0) {
								// Distribute the value among actual users (simple approach: give to first user)
								const firstUserId = role.members.firstKey();
								if (firstUserId) {
									await kv.set(`Metrics.total.staffActions.${action}.${ticketType}.${firstUserId}`, existingValue);
									console.log(`[Metrics] Moved ${existingValue} ${action} actions from role ${roleId} to user ${firstUserId}`);
								}
							}
							
							// Remove the role ID entry
							await kv.delete(`Metrics.total.staffActions.${action}.${ticketType}.${roleId}`);
							cleaned++;
						}
					}
				}
			}
			
			console.log(`[Metrics] Cleanup complete! Cleaned up ${cleaned} incorrect role ID entries`);
			console.log('[Metrics] Note: Role ID values were distributed to the first user in each role');
			console.log('[Metrics] You may want to manually adjust these values if needed');
			
		} catch (error) {
			console.error(`[Metrics] Error during role ID cleanup:`, error);
		}
	},
};


