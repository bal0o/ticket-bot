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
};


