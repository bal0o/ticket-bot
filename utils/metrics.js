const client = require('prom-client');

// Create a singleton registry
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

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
	ticketOpened: (type, server) => ticketsOpenedCounter.inc({ type: type || 'unknown', server: server || 'unknown' }),
	ticketClosed: (type, closeType) => ticketsClosedCounter.inc({ type: type || 'unknown', close_type: closeType || 'unknown' }),
	staffAction: (action, type, staffId) => staffActionsCounter.inc({ action: action || 'unknown', type: type || 'unknown', staff_id: String(staffId || 'unknown') }),
	ticketClaimed: (type) => ticketsClaimedCounter.inc({ type: type || 'unknown' }),
};


