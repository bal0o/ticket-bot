// Environment variables are now loaded from config.json
const { loadJson } = require("./utils/jsonConfig");
const config = loadJson("config/config.json", {});
const bots = require("./utils/clients");
const isDebugEnabled = !!config.debug;
const debugLog = (...args) => { if (isDebugEnabled) console.log(...args); };
const logger = require('./utils/logger');

const publicToken = config.tokens && config.tokens.bot_token;
const staffToken = config.tokens && config.tokens.staff_bot_token;
if (!publicToken || !staffToken) {
	logger.error("[Startup] tokens.bot_token (public) and tokens.staff_bot_token are both required.");
	process.exit(1);
}

const { publicClient, staffClient } = bots.createClients(config);
const handlerManager = require("./utils/handler_manager");
handlerManager(publicClient);
handlerManager(staffClient);

try {
    if (process.env.RUN_MODE === 'all' && config.web && config.web.enabled) {
        require("./web/server");
    }
} catch (e) {
    console.log("[web] Failed to start web server:", e?.message || e);
}

let startTime = new Date().getTime();
Promise.all([
	publicClient.login(publicToken),
	staffClient.login(staffToken)
]).then(() => {
	handlerManager.registerSlash(staffClient);
	bots.warnWrongGuilds(publicClient, staffClient, config, logger);
	let endTime = new Date().getTime();
	let difference = Math.round(endTime - startTime);
    logger.info(`[Startup] Public bot ${publicClient.user.username} and staff bot ${staffClient.user.username} in ${difference}ms`);

	try {
		const { createDB } = require('./utils/mysql');
		const db = createDB();
		const applications = require('./utils/applications');
		const { startInterviewSchedulers } = require('./utils/interview_scheduler');
		startInterviewSchedulers({
			publicClient,
			config,
			db,
			applications,
			debugLog,
		});
	} catch (e) { console.log('scheduler init error', e?.message || e); }
});

if (isDebugEnabled) {
	publicClient.on("debug", console.log);
	staffClient.on("debug", console.log);
}
publicClient.on("warn", console.log);
staffClient.on("warn", console.log);

process.on('unhandledRejection', (reason, promise) => {
    try {
        logger.error('[Process] UnhandledRejection', { reason: (reason && (reason.stack || reason.message || String(reason))) || String(reason) });
    } catch (_) { console.error('[Process] UnhandledRejection', reason); }
});
process.on('uncaughtException', (err) => {
    try {
        logger.error('[Process] UncaughtException', { error: (err && (err.stack || err.message)) || String(err) });
    } catch (_) { console.error('[Process] UncaughtException', err); }
});
process.on('warning', (warning) => {
    try {
        logger.warn('[Process] Warning', { name: warning.name, message: warning.message, stack: warning.stack });
    } catch (_) { console.warn('[Process] Warning', warning); }
});

const HEALTH_INTERVAL_MS = 60 * 1000;
if (isDebugEnabled) {
	setInterval(() => {
		try {
			const mem = process.memoryUsage();
			const rssMb = Math.round((mem.rss || 0) / 1024 / 1024);
			const heapMb = Math.round((mem.heapUsed || 0) / 1024 / 1024);
			logger.info('[Health] Memory', { rssMb, heapMb });
		} catch (_) {}
	}, HEALTH_INTERVAL_MS).unref();
}
