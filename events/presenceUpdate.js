const presenceMonitor = require('../utils/presenceMonitor');

module.exports = async function (client, oldPresence, newPresence) {
    try {
        await presenceMonitor.handlePresenceUpdate(client, oldPresence, newPresence);
    } catch (e) {
        const func = require('../utils/functions');
        func.handle_errors(e, client, 'presenceUpdate.js', 'Presence update handler failed');
    }
};
