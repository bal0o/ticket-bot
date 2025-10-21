const { QuickDB } = require('quick.db');

// Maintain a singleton per process to reduce file lock contention
let __dbInstance = null;

function createDB() {
	if (__dbInstance) return __dbInstance;
	// Persist under ./data/json.sqlite which is volume-mounted in docker-compose
	__dbInstance = new QuickDB({ filePath: './data/json.sqlite' });
	return __dbInstance;
}

module.exports = { createDB };
