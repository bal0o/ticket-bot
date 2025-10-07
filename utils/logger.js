// Simple, lightweight console logger with ISO timestamps
// Intended for basic visibility (not metrics)

function ts() {
	return new Date().toISOString();
}

module.exports = {
	info: function(...args) {
		console.log(ts(), ...args);
	},
	warn: function(...args) {
		console.warn(ts(), ...args);
	},
	error: function(...args) {
		console.error(ts(), ...args);
	},
	event: function(eventName, details) {
		try {
			const payload = details && typeof details === 'object' ? JSON.stringify(details) : (details == null ? '' : String(details));
			console.log(ts(), `[Event] ${eventName}`, payload);
		} catch (_) {
			console.log(ts(), `[Event] ${eventName}`);
		}
	}
};


