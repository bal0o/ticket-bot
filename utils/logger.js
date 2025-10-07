const fs = require('fs');
const path = require('path');
const os = require('os');
const { monitorEventLoopDelay, performance } = require('perf_hooks');

/**
 * Lightweight structured logger with console + file output, optional resource monitor,
 * and helpers to attach process/Discord.js event logging.
 */
class Logger {
    constructor() {
        this.logDir = path.join(process.cwd(), 'logs');
        this.level = 'info';
        this.consoleEnabled = true;
        this.captureConsoleEnabled = false;
        this._origConsole = {};
        this.fileStream = null;
        this.currentDateKey = null; // YYYY-MM-DD
        this.levelPriority = { error: 0, warn: 1, info: 2, debug: 3 };
        this.eventLoopHistogram = null;
        this.resourceTimer = null;
        this.prevCpu = null; // process.cpuUsage()
        this.prevTime = null; // performance.now()
        this.lastSample = null;
    }

    init(options = {}) {
        this.logDir = options.dir || this.logDir;
        this.level = options.level || this.level;
        this.consoleEnabled = options.console !== undefined ? !!options.console : this.consoleEnabled;
        try { if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true }); } catch (_) {}
        this.#rollFileIfNeeded();
        this.info('logger', { msg: 'Logger initialized', level: this.level, dir: this.logDir });
        return this;
    }

    setLevel(level) { if (level && this.levelPriority[level] !== undefined) this.level = level; }

    #formatNow() {
        const d = new Date();
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const dateKey = `${yyyy}-${mm}-${dd}`;
        const ts = d.toISOString();
        return { ts, dateKey };
    }

    #rollFileIfNeeded() {
        const { dateKey } = this.#formatNow();
        if (this.currentDateKey === dateKey && this.fileStream) return;
        this.currentDateKey = dateKey;
        const filePath = path.join(this.logDir, `bot-${dateKey}.log`);
        try {
            if (this.fileStream) {
                try { this.fileStream.end(); } catch (_) {}
            }
            this.fileStream = fs.createWriteStream(filePath, { flags: 'a' });
        } catch (_) {
            this.fileStream = null;
        }
    }

    #shouldLog(level) {
        return this.levelPriority[level] <= this.levelPriority[this.level];
    }

    #serialize(obj) {
        if (obj instanceof Error) {
            return { name: obj.name, message: obj.message, stack: obj.stack, code: obj.code };
        }
        if (obj && typeof obj === 'object') {
            try { return JSON.parse(JSON.stringify(obj)); } catch (_) { return String(obj); }
        }
        return obj;
    }

    #write(level, scope, argsArray) {
        if (!this.#shouldLog(level)) return;
        this.#rollFileIfNeeded();
        const { ts } = this.#formatNow();
        const payload = [];
        for (const a of argsArray) payload.push(this.#serialize(a));
        const lineObj = { ts, level, scope, host: os.hostname(), pid: process.pid, msg: payload };
        const line = JSON.stringify(lineObj);
        if (this.consoleEnabled) {
            const method = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'log');
            try { console[method](`[${ts}] [${level.toUpperCase()}] [${scope}]`, ...payload); } catch (_) {}
        }
        try { if (this.fileStream) this.fileStream.write(line + os.EOL); } catch (_) {}
    }

    debug(scope, ...args) { this.#write('debug', scope, args); }
    info(scope, ...args) { this.#write('info', scope, args); }
    warn(scope, ...args) { this.#write('warn', scope, args); }
    error(scope, ...args) { this.#write('error', scope, args); }

    captureConsole() {
        if (this.captureConsoleEnabled) return;
        this.captureConsoleEnabled = true;
        try {
            this._origConsole.log = console.log.bind(console);
            this._origConsole.warn = console.warn.bind(console);
            this._origConsole.error = console.error.bind(console);
            this._origConsole.debug = console.debug ? console.debug.bind(console) : console.log.bind(console);
            console.log = (...args) => { try { this.info('console', ...args); } catch (_) {} try { this._origConsole.log(...args); } catch (_) {} };
            console.warn = (...args) => { try { this.warn('console', ...args); } catch (_) {} try { this._origConsole.warn(...args); } catch (_) {} };
            console.error = (...args) => { try { this.error('console', ...args); } catch (_) {} try { this._origConsole.error(...args); } catch (_) {} };
            console.debug = (...args) => { try { this.debug('console', ...args); } catch (_) {} try { this._origConsole.debug(...args); } catch (_) {} };
            this.info('logger', { msg: 'Console capture enabled' });
        } catch (e) {
            this.warn('logger', { msg: 'Failed to enable console capture', error: this.#serialize(e) });
        }
    }

    attachProcessHandlers() {
        process.on('uncaughtException', (err) => this.error('process', { event: 'uncaughtException', error: this.#serialize(err) }));
        process.on('unhandledRejection', (reason, p) => this.error('process', { event: 'unhandledRejection', reason: this.#serialize(reason) }));
        process.on('warning', (w) => this.warn('process', { event: 'warning', warning: this.#serialize(w) }));
        try { process.on('SIGTERM', () => this.warn('process', { event: 'SIGTERM' })); } catch (_) {}
        try { process.on('SIGINT', () => this.warn('process', { event: 'SIGINT' })); } catch (_) {}
    }

    attachDiscordClient(client) {
        if (!client || !client.on) return;
        client.on('error', (e) => this.error('discord', { event: 'error', error: this.#serialize(e) }));
        client.on('warn', (m) => this.warn('discord', { event: 'warn', msg: m }));
        client.on('debug', (m) => this.debug('discord', { event: 'debug', msg: m }));
        client.on('shardDisconnect', (e, id) => this.warn('discord', { event: 'shardDisconnect', shardId: id, code: e?.code, reason: e?.reason }));
        client.on('shardReconnecting', (id) => this.warn('discord', { event: 'shardReconnecting', shardId: id }));
        client.on('shardResume', (id, replayed) => this.info('discord', { event: 'shardResume', shardId: id, replayed }));
        client.on('rateLimit', (info) => this.warn('discord', { event: 'rateLimit', info }));
        try {
            if (client.rest && typeof client.rest.on === 'function') {
                client.rest.on('rateLimited', (info) => this.warn('discord', { event: 'rest.rateLimited', info }));
                client.rest.on('invalidRequestWarning', (info) => this.warn('discord', { event: 'rest.invalidRequestWarning', info }));
            }
        } catch (_) {}
    }

    startEventLoopMonitor(options = {}) {
        const resolution = Number.isFinite(options.resolutionMs) ? options.resolutionMs : 20;
        if (!this.eventLoopHistogram) {
            try {
                this.eventLoopHistogram = monitorEventLoopDelay({ resolution });
                this.eventLoopHistogram.enable();
                this.info('monitor', { msg: 'Event loop delay monitor enabled', resolutionMs: resolution });
            } catch (e) {
                this.warn('monitor', { msg: 'Failed to enable event loop monitor', error: this.#serialize(e) });
            }
        }
        return this.eventLoopHistogram;
    }

    startResourceMonitor(options = {}) {
        const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 15000;
        const logOnChangeOnly = options.logOnChangeOnly !== undefined ? !!options.logOnChangeOnly : true;
        const lagWarnMs = Number.isFinite(options.lagWarnMs) ? options.lagWarnMs : 200;
        const memWarnMb = Number.isFinite(options.memWarnMb) ? options.memWarnMb : 1024;
        const cpuWarnPct = Number.isFinite(options.cpuWarnPct) ? options.cpuWarnPct : 80;
        this.startEventLoopMonitor({ resolutionMs: 20 });
        this.prevCpu = process.cpuUsage();
        this.prevTime = performance.now();
        if (this.resourceTimer) clearInterval(this.resourceTimer);
        this.resourceTimer = setInterval(() => {
            try {
                const now = performance.now();
                const dtMs = Math.max(1, now - this.prevTime);
                const cpu = process.cpuUsage(this.prevCpu);
                this.prevCpu = process.cpuUsage();
                this.prevTime = now;
                const cpuTotalUs = (cpu.user + cpu.system);
                const cpuPct = Math.min(100, Math.round((cpuTotalUs / (dtMs * 1000)) * 100));
                const mem = process.memoryUsage();
                const rssMb = Math.round(mem.rss / (1024 * 1024));
                const heapMb = Math.round(mem.heapUsed / (1024 * 1024));
                const extMb = Math.round(mem.external / (1024 * 1024));
                const el = this.eventLoopHistogram;
                const lagMean = el ? Math.round(el.mean / 1e6) : null; // ns -> ms
                const lagP95 = el ? Math.round(el.percentile(95) / 1e6) : null;
                const sample = { cpuPct, rssMb, heapMb, extMb, lagMean, lagP95 };
                const changed = !this.lastSample || JSON.stringify(sample) !== JSON.stringify(this.lastSample);
                const level = (cpuPct >= cpuWarnPct || heapMb >= memWarnMb || (lagP95 !== null && lagP95 >= lagWarnMs)) ? 'warn' : 'info';
                if (!logOnChangeOnly || changed || level === 'warn') {
                    this[level]('resource', sample);
                }
                this.lastSample = sample;
                if (el) el.reset();
            } catch (e) {
                this.warn('resource', { msg: 'Resource monitor error', error: this.#serialize(e) });
            }
        }, intervalMs);
        try { this.resourceTimer.unref && this.resourceTimer.unref(); } catch (_) {}
    }
}

module.exports = new Logger();


