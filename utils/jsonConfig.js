const fs = require('fs');
const path = require('path');

const warned = new Set();

function resolvePath(filePath) {
	if (path.isAbsolute(filePath)) return filePath;
	return path.join(__dirname, '..', filePath);
}

function flag(fullPath, detail) {
	if (warned.has(fullPath)) return;
	warned.add(fullPath);
	const suffix = detail ? ` (${detail})` : '';
	console.warn(`[config] Missing or invalid JSON: ${fullPath}${suffix} — using defaults`);
}

function clone(value) {
	if (value === null || typeof value !== 'object') return value;
	return JSON.parse(JSON.stringify(value));
}

function loadJson(filePath, fallback = {}) {
	const fullPath = resolvePath(filePath);
	try {
		if (!fs.existsSync(fullPath)) {
			flag(fullPath, 'not found');
			return clone(fallback);
		}
		const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
		if (parsed == null || typeof parsed !== 'object') {
			flag(fullPath, 'not an object');
			return clone(fallback);
		}
		return parsed;
	} catch (e) {
		flag(fullPath, e.message);
		return clone(fallback);
	}
}

module.exports = { loadJson };
