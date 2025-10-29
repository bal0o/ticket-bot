const client = require('prom-client');
const { createDB } = require('./mysql');
const kv = createDB();

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
	labelNames: ['type', 'server', 'scope']
});

const userTicketsOpenedCounter = new client.Counter({
	name: 'ticketbot_user_tickets_opened_total',
	help: 'Tickets opened per user',
	labelNames: ['opened_by', 'type', 'server', 'scope']
});

const ticketsClosedCounter = new client.Counter({
	name: 'ticketbot_tickets_closed_total',
	help: 'Total tickets closed',
	labelNames: ['type', 'closed_by', 'closed_by_name', 'scope']
});

const staffActionsCounter = new client.Counter({
	name: 'ticketbot_staff_actions_total',
	help: 'Total staff actions',
	labelNames: ['action', 'type', 'staff_id', 'staff_name', 'scope']
});

const ticketsClaimedCounter = new client.Counter({
	name: 'ticketbot_tickets_claimed_total',
	help: 'Total ticket claims',
	labelNames: ['type', 'scope']
});

// Aggregates for duration and message counts across tickets (restart-safe via persisted totals)
const ticketDurationSumCounter = new client.Counter({
	name: 'ticketbot_ticket_duration_seconds_sum',
	help: 'Sum of ticket open durations in seconds',
	labelNames: ['type', 'server', 'scope']
});

const ticketDurationCountCounter = new client.Counter({
	name: 'ticketbot_ticket_duration_tickets_total',
	help: 'Number of closed tickets contributing to duration sum',
	labelNames: ['type', 'server', 'scope']
});

const ticketMessagesTotalCounter = new client.Counter({
	name: 'ticketbot_ticket_messages_total',
	help: 'Total messages counted across tickets',
	labelNames: ['type', 'server', 'scope']
});

const ticketUserMessagesTotalCounter = new client.Counter({
	name: 'ticketbot_ticket_user_messages_total',
	help: 'Total end-user messages across tickets',
	labelNames: ['type', 'server', 'scope']
});

const ticketStaffMessagesTotalCounter = new client.Counter({
	name: 'ticketbot_ticket_staff_messages_total',
	help: 'Total staff messages across tickets',
	labelNames: ['type', 'server', 'scope']
});

// User-specific metrics counters
const userTicketDurationSumCounter = new client.Counter({
	name: 'ticketbot_user_ticket_duration_seconds_sum',
	help: 'Sum of ticket open durations in seconds per user',
	labelNames: ['opened_by', 'type', 'server', 'scope']
});

const userTicketDurationCountCounter = new client.Counter({
	name: 'ticketbot_user_ticket_duration_tickets_total',
	help: 'Number of closed tickets contributing to duration sum per user',
	labelNames: ['opened_by', 'type', 'server', 'scope']
});

const userTicketMessagesTotalCounter = new client.Counter({
	name: 'ticketbot_user_ticket_messages_total',
	help: 'Total messages counted across tickets per user',
	labelNames: ['opened_by', 'type', 'server', 'scope']
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
	ticketOpened: (type, server, openedBy, openedByUsername, scope = 'public') => {
		const t = type || 'unknown';
		const s = (server && String(server).trim().toLowerCase() !== 'unknown') ? server : 'none';
		const ob = String(openedBy || 'unknown');
		const obu = String(openedByUsername || 'unknown');
		ticketsOpenedCounter.inc({ type: t, server: s, scope });
		userTicketsOpenedCounter.inc({ opened_by: ob, type: t, server: s, scope });
		// Metrics no longer stored in kv_store - Grafana queries MySQL tickets table directly
	},
	ticketClosed: (type, closedBy, closedByUsername, scope = 'public') => {
		const t = type || 'unknown';
		const cb = String(closedBy || 'unknown');
		const cbu = String(closedByUsername || 'unknown');
		ticketsClosedCounter.inc({ type: t, closed_by: cb, closed_by_name: cbu, scope });
		// Metrics no longer stored in kv_store - Grafana queries MySQL tickets table directly
	},
	staffAction: (action, type, staffId, staffUsername, scope = 'public') => {
		const a = action || 'unknown';
		const t = type || 'unknown';
		const s = String(staffId || 'unknown');
		const su = String(staffUsername || 'unknown');
		staffActionsCounter.inc({ action: a, type: t, staff_id: s, staff_name: su, scope });
		// Metrics no longer stored in kv_store - Grafana queries MySQL tickets table directly
	},
	ticketClaimed: (type, scope = 'public') => {
		const t = type || 'unknown';
		ticketsClaimedCounter.inc({ type: t, scope });
		// Metrics no longer stored in kv_store - Grafana queries MySQL tickets table directly
	},
	// Record per-ticket aggregates for duration and message totals
	recordTicketAggregates: (type, server, durationSeconds, messageCount, userMessages, staffMessages, openedBy, openedByUsername, scope = 'public') => {
		const t = type || 'unknown';
		const s = (server && String(server).trim().toLowerCase() !== 'unknown') ? server : 'none';
		const ob = String(openedBy || 'unknown');
		const obu = String(openedByUsername || 'unknown');
		const dur = Math.max(0, Math.floor(durationSeconds || 0));
		const msgs = Math.max(0, Math.floor(messageCount || 0));
		if (dur > 0) ticketDurationSumCounter.inc({ type: t, server: s, scope }, dur);
		ticketDurationCountCounter.inc({ type: t, server: s, scope }, 1);
		if (msgs > 0) ticketMessagesTotalCounter.inc({ type: t, server: s, scope }, msgs);
		const um = Math.max(0, Math.floor(userMessages || 0));
		const sm = Math.max(0, Math.floor(staffMessages || 0));
		if (um > 0) ticketUserMessagesTotalCounter.inc({ type: t, server: s, scope }, um);
		if (sm > 0) ticketStaffMessagesTotalCounter.inc({ type: t, server: s, scope }, sm);
		// Per-user aggregates
		if (dur > 0) {
			userTicketDurationSumCounter.inc({ opened_by: ob, type: t, server: s, scope }, dur);
		}
		userTicketDurationCountCounter.inc({ opened_by: ob, type: t, server: s, scope }, 1);
		if (msgs > 0) {
			userTicketMessagesTotalCounter.inc({ opened_by: ob, type: t, server: s, scope }, msgs);
		}
		// Metrics no longer stored in kv_store - Grafana queries MySQL tickets table directly
		// Duration and message data not used, so not stored
	},
	
	// Helper function to get username for a Discord ID
	// Usernames now come from tickets table - query MySQL directly
	getUsername: async (discordId) => {
		if (!discordId) return 'unknown';
		try {
			// Query tickets table for username instead of kv_store
			const [rows] = await kv.query(
				'SELECT username FROM tickets WHERE user_id = ? AND username IS NOT NULL ORDER BY created_at DESC LIMIT 1',
				[String(discordId)]
			);
			return rows[0]?.username || 'unknown';
		} catch (_) {
			return 'unknown';
		}
	},
	
	// Get all stored usernames - now from tickets table
	getAllUsernames: async () => {
		try {
			const [rows] = await kv.query(
				'SELECT DISTINCT user_id, username FROM tickets WHERE username IS NOT NULL'
			);
			const usernames = {};
			for (const row of rows) {
				usernames[row.user_id] = row.username;
			}
			return usernames;
		} catch (_) {
			return {};
		}
	},
	
	// Update username for a Discord ID (updates tickets table)
	updateUsername: async (discordId, newUsername) => {
		if (!discordId || !newUsername) return false;
		try {
			await kv.query(
				'UPDATE tickets SET username = ? WHERE user_id = ?',
				[String(newUsername), String(discordId)]
			);
			return true;
		} catch (_) {
			return false;
		}
	},
	
	// Get metrics data with usernames for better readability
	// Now queries MySQL tickets table directly - no longer uses kv_store
	getMetricsWithUsernames: async () => {
		try {
			// Query tickets table directly for all metrics
			const [ticketsRows] = await kv.query(`
				SELECT 
					ticket_type,
					server,
					user_id,
					username,
					close_user_id,
					close_user
				FROM tickets
				WHERE (close_time IS NOT NULL OR close_type IS NOT NULL OR transcript_url IS NOT NULL)
			`);
			
			const ticketsOpened = {};
			const ticketsClosed = {};
			const usernames = {};
			
			for (const row of ticketsRows) {
				const type = row.ticket_type || 'unknown';
				const server = row.server || 'none';
				const userId = String(row.user_id || '');
				const username = row.username || 'unknown';
				const closedBy = String(row.close_user_id || row.close_user || '');
				
				// Collect usernames
				if (userId) usernames[userId] = username;
				if (closedBy) {
					// Try to get username for closer from tickets table
					const [closerRows] = await kv.query(
						'SELECT username FROM tickets WHERE user_id = ? AND username IS NOT NULL ORDER BY created_at DESC LIMIT 1',
						[closedBy]
					);
					if (closerRows[0]) usernames[closedBy] = closerRows[0].username;
				}
				
				// Count opened
				if (!ticketsOpened[type]) ticketsOpened[type] = {};
				ticketsOpened[type][server] = (ticketsOpened[type][server] || 0) + 1;
				
				// Count closed
				if (closedBy) {
					if (!ticketsClosed[type]) ticketsClosed[type] = {};
					ticketsClosed[type][closedBy] = (ticketsClosed[type][closedBy] || 0) + 1;
				}
			}
			
			return {
				ticketsOpened,
				ticketsClosed,
				staffActions: {}, // Not tracked in tickets table
				usernames
			};
		} catch (_) {
			return {};
		}
	},
	
	// Update usernames for existing users (updates tickets table)
	updateExistingUsernames: async (client) => {
		try {
			if (!client || !client.guilds) {
				console.log('[Metrics] Client not ready, cannot update existing usernames');
				return;
			}
			
			const staffGuild = client.guilds.cache.get(client.config?.channel_ids?.staff_guild_id);
			if (!staffGuild) {
				console.log('[Metrics] Staff guild not found, cannot update existing usernames');
				return;
			}
			
			console.log('[Metrics] Updating usernames for existing users...');
			
			// Get distinct user IDs from tickets table
			const [userRows] = await kv.query(
				'SELECT DISTINCT user_id FROM tickets WHERE user_id IS NOT NULL'
			);
			
			let updated = 0;
			for (const row of userRows) {
				const userId = String(row.user_id);
				try {
					const member = staffGuild.members.cache.get(userId);
					if (member && member.user) {
						const newUsername = member.user.username || member.user.tag || 'unknown';
						await kv.query(
							'UPDATE tickets SET username = ? WHERE user_id = ?',
							[newUsername, userId]
						);
						updated++;
					}
				} catch (error) {
					console.error(`[Metrics] Error updating username for ${userId}:`, error);
				}
			}
			
			console.log(`[Metrics] Username update complete. Updated ${updated} usernames.`);
		} catch (error) {
			console.error(`[Metrics] Error updating existing usernames:`, error);
		}
	},
	
	// Get a summary of metrics with usernames for reporting
	// Now queries MySQL tickets table directly - no longer uses kv_store
	getMetricsSummary: async () => {
		try {
			// Query tickets table for statistics
			const [ticketsRows] = await kv.query(`
				SELECT 
					COUNT(*) as total_tickets,
					COUNT(CASE WHEN close_time IS NOT NULL OR close_type IS NOT NULL OR transcript_url IS NOT NULL THEN 1 END) as closed_tickets,
					COUNT(DISTINCT user_id) as unique_users,
					COUNT(DISTINCT close_user_id) as unique_closers
				FROM tickets
			`);
			
			const totals = ticketsRows[0] || {};
			
			// Get top closers
			const [closerRows] = await kv.query(`
				SELECT 
					close_user_id as user_id,
					MAX(username) as username,
					COUNT(*) as closed_count
				FROM tickets
				WHERE close_user_id IS NOT NULL
				GROUP BY close_user_id
				ORDER BY closed_count DESC
				LIMIT 10
			`);
			
			const topStaff = closerRows.map(row => ({
				userId: String(row.user_id),
				username: row.username || 'unknown',
				totalActions: row.closed_count,
				actions: { closeticket: row.closed_count }
			}));
			
			// Get username map
			const [usernameRows] = await kv.query(
				'SELECT DISTINCT user_id, username FROM tickets WHERE username IS NOT NULL'
			);
			const usernames = {};
			for (const row of usernameRows) {
				usernames[String(row.user_id)] = row.username;
			}
			
			return {
				totalTicketsOpened: totals.total_tickets || 0,
				totalTicketsClosed: totals.closed_tickets || 0,
				totalStaffActions: totals.closed_tickets || 0, // Approximate from closed tickets
				topStaff,
				usernames
			};
		} catch (_) {
			return {};
		}
	},
	
	// Get current Prometheus metrics with username labels for verification
	getCurrentMetricsWithUsernames: async () => {
		try {
			const ticketsClosedData = ticketsClosedCounter.get();
			const staffActionsData = staffActionsCounter.get();
			
			const result = {
				ticketsClosed: [],
				staffActions: [],
				timestamp: new Date().toISOString()
			};
			
			// Process tickets closed metrics
			if (ticketsClosedData && ticketsClosedData.values) {
				for (const value of ticketsClosedData.values) {
					result.ticketsClosed.push({
						type: value.labels.type,
						closed_by: value.labels.closed_by,
						closed_by_name: value.labels.closed_by_name,
						value: value.value
					});
				}
			}
			
			// Process staff actions metrics
			if (staffActionsData && staffActionsData.values) {
				for (const value of staffActionsData.values) {
					result.staffActions.push({
						action: value.labels.action,
						type: value.labels.type,
						staff_id: value.labels.staff_id,
						staff_name: value.labels.staff_name,
						value: value.value
					});
				}
			}
			
			return result;
		} catch (error) {
			console.error('[Metrics] Error getting current metrics:', error);
			return { error: error.message };
		}
	},
	
	// Initialize Prometheus counters on startup
	// Note: Metrics no longer persisted to kv_store - Grafana queries MySQL tickets table directly
	// This function now just initializes counters to 0 for proper label initialization
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
				let serverSelectionEnabled = false;
				try {
					const questionFile = require(`../content/questions/${handlerRaw.options[ticketType].question_file}`);
					serverSelectionEnabled = !!(questionFile && questionFile.server_selection && questionFile.server_selection.enabled);
				} catch (_) {}
				const serversToInit = serverSelectionEnabled ? allServers : ['none'];
				for (const server of serversToInit) {
					// Initialize counters with 0 to ensure labels exist
					ticketsOpenedCounter.inc({ type: ticketType, server: server }, 0);
					ticketDurationSumCounter.inc({ type: ticketType, server: server }, 0);
					ticketDurationCountCounter.inc({ type: ticketType, server: server }, 0);
					ticketMessagesTotalCounter.inc({ type: ticketType, server: server }, 0);
					ticketUserMessagesTotalCounter.inc({ type: ticketType, server: server }, 0);
					ticketStaffMessagesTotalCounter.inc({ type: ticketType, server: server }, 0);
				}
				// Initialize tickets claimed counter for this ticket type
				ticketsClaimedCounter.inc({ type: ticketType }, 0);
			}
			
			// Metrics no longer persisted - counters start at 0 on each restart
			// Grafana queries MySQL tickets table directly for historical metrics
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
					console.log('[Metrics] This usually means the bot lacks the "Server Members Intent" permission in Discord Developer Portal');
				}
			}
			
			// Check if we still have very few members (just the bot)
			if (staffGuild.members.cache.size <= 1) {
				console.log('[Metrics] Warning: Guild member cache still very small. This indicates:');
				console.log('[Metrics] 1. The bot lacks "Server Members Intent" in Discord Developer Portal, OR');
				console.log('[Metrics] 2. The bot lacks permission to view members in this guild');
				console.log('[Metrics] 3. The guild is still loading (try increasing the delay)');
				
				// Try one more fetch with a longer timeout
				try {
					console.log('[Metrics] Attempting one more fetch with longer timeout...');
					await Promise.race([
						staffGuild.members.fetch(),
						new Promise(resolve => setTimeout(resolve, 10000)) // 10 second timeout
					]);
					console.log(`[Metrics] After second fetch: Guild now has ${staffGuild.members.cache.size} members`);
				} catch (secondError) {
					console.error('[Metrics] Second fetch also failed:', secondError);
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
								
								// Get members with this role from the guild member cache
								const membersWithRole = staffGuild.members.cache.filter(member => member.roles.cache.has(roleId));
								console.log(`[Metrics] Role ${role.name} has ${membersWithRole.size} members (from guild cache)`);
								
								if (membersWithRole.size > 0) {
									// Add all user IDs from this role
									for (const [userId, member] of membersWithRole) {
										allStaffUserIds.add(userId);
										console.log(`[Metrics] Added staff member: ${member.user?.tag || userId} (${userId})`);
									}
								} else {
									console.log(`[Metrics] Warning: Role ${role.name} has no members in guild cache`);
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
					const member = staffGuild.members.cache.get(staffId);
					const username = member?.user?.username || member?.user?.tag || 'unknown';
					ticketsClosedCounter.inc({ type: ticketType, closed_by: staffId, closed_by_name: username }, 0);
				}
				
				// Initialize staff actions counter for all staff members
				for (const staffId of allStaffUserIds) {
					const member = staffGuild.members.cache.get(staffId);
					const username = member?.user?.username || member?.user?.tag || 'unknown';
					staffActionsCounter.inc({ action: 'openticket', type: ticketType, staff_id: staffId, staff_name: username }, 0);
					staffActionsCounter.inc({ action: 'closeticket', type: ticketType, staff_id: staffId, staff_name: username }, 0);
					staffActionsCounter.inc({ action: 'moveticket', type: ticketType, staff_id: staffId, staff_name: username }, 0);
					staffActionsCounter.inc({ action: 'claimticket', type: ticketType, staff_id: staffId, staff_name: username }, 0);
				}
				
				// Initialize tickets claimed counter for this ticket type
				ticketsClaimedCounter.inc({ type: ticketType }, 0);
			}
			
			// Usernames are now stored in tickets table - no need to store separately
			console.log('[Metrics] Staff usernames will be updated from tickets table as needed');
			
			console.log(`[Metrics] Staff metrics initialization complete`);
		} catch (error) {
			console.error(`[Metrics] Error initializing staff metrics:`, error);
		}
	},
	
	// Clean up incorrect role IDs from metrics database and replace with actual user IDs
	// Note: This function is deprecated since metrics are no longer stored in kv_store
	// Metrics now come directly from MySQL tickets table
	cleanupRoleIds: async (client) => {
		console.log('[Metrics] cleanupRoleIds() is deprecated - metrics come from MySQL tickets table');
		// All metrics now come from MySQL tickets table which doesn't have role ID issues
	},
};


