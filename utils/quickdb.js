const { QuickDB } = require('quick.db');

function createDB() {
	// Persist under ./data/json.sqlite which is volume-mounted in docker-compose
	return new QuickDB({ filePath: './data/json.sqlite' });
}

module.exports = { createDB };
