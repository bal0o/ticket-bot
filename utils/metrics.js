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

const ticketsClosedCounter = new client.Counter({
	name: 'ticketbot_tickets_closed_total',
	help: 'Total tickets closed',
	labelNames: ['type', 'close_type']
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

registry.registerMetric(openTicketsGauge);
registry.registerMetric(ticketsOpenedCounter);
registry.registerMetric(ticketsClosedCounter);
registry.registerMetric(staffActionsCounter);
registry.registerMetric(ticketsClaimedCounter);

module.exports = {
	registry,
	setOpenTickets: (count) => openTicketsGauge.set(count || 0),
	// Increment and persist totals
	ticketOpened: (type, server) => {
		const t = type || 'unknown';
		const s = server || 'unknown';
		ticketsOpenedCounter.inc({ type: t, server: s });
		kv.add(`Metrics.total.ticketsOpened.${t}.${s}`, 1).catch(()=>{});
	},
	ticketClosed: (type, closeType) => {
		const t = type || 'unknown';
		const c = closeType || 'unknown';
		ticketsClosedCounter.inc({ type: t, close_type: c });
		kv.add(`Metrics.total.ticketsClosed.${t}.${c}`, 1).catch(()=>{});
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
			let closed = await kv.get('Metrics.total.ticketsClosed') || {};
			for (const t of Object.keys(closed)) {
				const byClose = closed[t] || {};
				for (const c of Object.keys(byClose)) {
					const v = byClose[c] || 0;
					if (v > 0) ticketsClosedCounter.inc({ type: t, close_type: c }, v);
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
			// If totals are empty (first run), rebuild from existing DB so counters are not zeroed on restart
			const needRebuild = (Object.keys(opened).length === 0) && (Object.keys(closed).length === 0) && (Object.keys(actions).length === 0) && (Object.keys(claimed).length === 0);
			if (needRebuild) {
				const ps = await kv.get('PlayerStats');
				const openedAgg = {};
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
							if (t.closeType) {
								const ct = t.closeType || 'closed';
								closedAgg[type] = closedAgg[type] || {};
								closedAgg[type][ct] = (closedAgg[type][ct] || 0) + 1;
							}
						}
					}
				}
				await kv.set('Metrics.total.ticketsOpened', openedAgg).catch(()=>{});
				await kv.set('Metrics.total.ticketsClosed', closedAgg).catch(()=>{});
				// hydrate the counters
				for (const t of Object.keys(openedAgg)) {
					for (const s of Object.keys(openedAgg[t])) {
						const v = openedAgg[t][s];
						if (v > 0) ticketsOpenedCounter.inc({ type: t, server: s }, v);
					}
				}
				for (const t of Object.keys(closedAgg)) {
					for (const c of Object.keys(closedAgg[t])) {
						const v = closedAgg[t][c];
						if (v > 0) ticketsClosedCounter.inc({ type: t, close_type: c }, v);
					}
				}
				// Staff actions/claims are optional to rebuild; skip to avoid heavy scans
			}
		} catch (_) {}
	},
};


