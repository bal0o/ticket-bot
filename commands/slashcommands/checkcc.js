const Discord = require("discord.js");
const { SlashCommandBuilder } = require("@discordjs/builders");
const config = require("../../config/config.json");
const func = require("../../utils/functions.js");

function parseCheetosResponse(text) {
    const raw = String(text || "").trim();
    // Try JSON first
    try {
        if (raw.startsWith('[') || raw.startsWith('{')) {
            const json = JSON.parse(raw);
            const arr = Array.isArray(json) ? json : [json];
            return arr.map(x => ({
                ID: x.ID ?? x.id ?? x.Id ?? '',
                Username: x.Username ?? x.username ?? '',
                FirstSeen: x.FirstSeen ?? x.firstSeen ?? x.first_seen ?? '',
                TimestampAdded: x.TimestampAdded ?? x.timestampAdded ?? x.timestamp_added ?? '',
                LastGuildScan: x.LastGuildScan ?? x.lastGuildScan ?? x.last_guild_scan ?? '',
                Name: x.Name ?? x.name ?? '',
                Roles: x.Roles ?? x.roles ?? '',
                Notes: x.Notes ?? x.notes ?? ''
            }));
        }
    } catch (_) {}
    // Plaintext fallback
    const lines = raw.split(/\r?\n/);
    const records = [];
    let current = null;
    for (const ln of lines) {
        const line = (ln || '').trimEnd();
        if (!line) continue;
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key.toLowerCase() === 'id') {
            if (current && Object.keys(current).length) records.push(current);
            current = {};
        }
        if (!current) current = {};
        current[key] = value;
    }
    if (current && Object.keys(current).length) records.push(current);
    return records;
}

function summarizeRecords(records) {
    const count = records.length;
    let lastEpoch = null;
    for (const r of records) {
        const tsRaw = r['TimestampAdded'] ?? r.TimestampAdded;
        const ts = tsRaw !== undefined && tsRaw !== null ? parseInt(String(tsRaw), 10) : null;
        if (Number.isFinite(ts) && ts > 0 && (!lastEpoch || ts > lastEpoch)) lastEpoch = ts;
    }
    // Format LTS as h/d/w/m/y
    const toShortAge = (sec) => {
        const s = Math.max(0, sec|0);
        const h = Math.floor(s / 3600);
        if (h < 24) return `${h}h`;
        const d = Math.floor(h / 24);
        if (d < 7) return `${d}d`;
        const w = Math.floor(d / 7);
        if (w < 4) return `${w}w`;
        const m = Math.floor(d / 30);
        if (m < 12) return `${m}m`;
        const y = Math.floor(d / 365);
        return `${y}y`;
    };
    let ltsStr = 'N/A';
    if (lastEpoch && Number.isFinite(lastEpoch)) {
        const nowSec = Math.floor(Date.now() / 1000);
        const diffSec = Math.max(0, nowSec - lastEpoch);
        ltsStr = toShortAge(diffSec);
    }
    let wr = 0;
    for (const r of records) {
        const rolesVal = (r['Roles'] || '').trim();
        if (rolesVal && rolesVal.length > 0) wr++;
    }
    return { count, ltsStr, wr };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('checkcc')
        .setDescription('Run a Cheetos.gg scan for a Discord user ID')
        .addStringOption(option => option.setName('userid').setDescription('Discord User ID').setRequired(true)),

    async execute(interaction, client) {
        try {
            await interaction.deferReply();

            // Channel restriction
            const allowedChannelId = client.config?.channel_ids?.checkcc_channel_id;
            if (allowedChannelId && interaction.channelId !== allowedChannelId) {
                await interaction.editReply({ content: 'This command can only be used in the designated channel.' });
                return;
            }

            // Role restriction
            let access = 0;
            const rolesAllowed = Array.isArray(client.config?.role_ids?.role_ids_checkcc_cmd) ? client.config.role_ids.role_ids_checkcc_cmd : [];
            for (const rid of rolesAllowed) {
                if (interaction.member.roles.cache.has(rid)) { access++; break; }
            }
            if (!access && client.config?.role_ids?.default_admin_role_id && interaction.member.roles.cache.has(client.config.role_ids.default_admin_role_id)) {
                access++;
            }
            if (access === 0) {
                await interaction.editReply({ content: 'You do not have permission to use this command.' });
                return;
            }

            const targetId = (interaction.options.getString('userid') || '').trim();
            if (!/^\d{17,19}$/.test(targetId)) {
                await interaction.editReply({ content: 'Please provide a valid Discord user ID.' });
                return;
            }

            // Require API token
            if (!client.config?.tokens?.cheetosToken) {
                await interaction.editReply({ content: 'Cheetos API token not configured.' });
                return;
            }

            const unirest = require('unirest');
            const url = `https://Cheetos.gg/api.php?action=search&id=${encodeURIComponent(targetId)}`;
            if (client.config && client.config.debug) {
                console.log(`[Cheetos:/checkcc] Requesting: ${url} with DiscordID=${String(client.config?.misc?.cheetos_requestor_id || interaction.user.id)}`);
            }
            const resp = await unirest.get(url).headers({
                'Auth-Key': client.config.tokens.cheetosToken,
                'DiscordID': String(client.config?.misc?.cheetos_requestor_id || interaction.user.id),
                'Accept': 'text/plain',
                'User-Agent': 'ticket-bot (Discord.js)'
            });
            const raw = (resp && (resp.raw_body || resp.body)) || '';
            let text = '';
            if (typeof raw === 'string') text = raw;
            else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
            else if (raw && raw.toString) text = raw.toString();
            if (client.config && client.config.debug) {
                console.log(`[Cheetos:/checkcc] Response status=${resp?.status || resp?.code || 'n/a'} length=${(text||'').length} preview=\n${String(text).slice(0, 300)}`);
            }
            const records = parseCheetosResponse(text);
            const { count, ltsStr, wr } = summarizeRecords(records);

            // Compose summary (same format as ticket)
            const summary = count > 0 ? `Result: ${count} CC LTS ${ltsStr} ${wr} WR` : 'Cheetos Check: Clean';

            // Helpers for human-readable time
            const toUnixSeconds = (v) => {
                if (v === undefined || v === null) return null;
                const n = Number(String(v));
                if (!Number.isFinite(n)) return null;
                if (n > 10_000_000_000) return Math.floor(n / 1000);
                if (n > 0) return Math.floor(n);
                return null;
            };
            const humanTimePair = (n) => n ? `<t:${n}:F> / <t:${n}:R>` : 'N/A';

            // Build embed field table per record (limit to first 10 to respect embed limits)
            const maxFields = 10;
            const shown = records.slice(0, maxFields);
            const overflow = records.length > maxFields;

            // Also construct a full pretty text fallback for attachment if needed
            let detail = '';
            if (records.length) {
                const chunks = records.map((r, idx) => {
                    const fsUnix = toUnixSeconds(r.FirstSeen ?? r['FirstSeen']);
                    const taUnix = toUnixSeconds(r.TimestampAdded ?? r['TimestampAdded']);
                    const lgUnix = toUnixSeconds(r.LastGuildScan ?? r['LastGuildScan']);
                    const pretty = [
                        `ID: ${r.ID ?? ''}`,
                        `Username: ${r.Username ?? ''}`,
                        `FirstSeen: ${fsUnix ? new Date(fsUnix * 1000).toISOString() : (r.FirstSeen ?? '')}`,
                        `TimestampAdded: ${taUnix ? new Date(taUnix * 1000).toISOString() : (r.TimestampAdded ?? '')}`,
                        `LastGuildScan: ${lgUnix ? new Date(lgUnix * 1000).toISOString() : (r.LastGuildScan ?? '')}`,
                        `Name: ${r.Name ?? ''}`,
                        `Roles: ${r.Roles ?? ''}`,
                        `Notes: ${Array.isArray(r.Notes) ? (r.Notes.length ? JSON.stringify(r.Notes) : '{}') : (r.Notes || '{}')}`
                    ];
                    return `#${idx + 1}\n` + pretty.join('\n');
                });
                detail = chunks.join('\n\n');
            } else {
                detail = 'No records found.';
            }

            const embed = new Discord.MessageEmbed()
                .setColor(client.config.bot_settings.main_color)
                .setTitle('Cheetos Scan')
                .setDescription(summary)
                .addFields({ name: 'Target', value: `UserID: ${targetId}` });

            // Add per-record fields (formatted per requirements)
            for (let i = 0; i < shown.length; i++) {
                const r = shown[i];
                const joinedUnix = toUnixSeconds(r.FirstSeen ?? r['FirstSeen']);
                const lastSeenUnix = toUnixSeconds(r.TimestampAdded ?? r['TimestampAdded']);
                const scannedUnix = toUnixSeconds(r.LastGuildScan ?? r['LastGuildScan']);
                const roles = String(r.Roles ?? '').slice(0, 500);
                const notesText = Array.isArray(r.Notes) ? (r.Notes.length ? JSON.stringify(r.Notes) : '{}') : (r.Notes || '{}');
                const name = `${r.Name || r.Username || 'Record'}`.slice(0, 256);
                const value = [
                    `Roles: ${roles || 'N/A'}`,
                    `Username: ${r.Username ?? ''}`,
                    `Joined Discord Server: ${humanTimePair(joinedUnix)}`,
                    `Last Time Seen In Guild: ${humanTimePair(lastSeenUnix)}`,
                    `Last Time Guild Scanned: ${humanTimePair(scannedUnix)}`
                ].join('\n').slice(0, 1024);
                embed.addFields({ name, value, inline: false });
            }

            // Attach full details if overflow or embed too long
            const payload = { embeds: [embed] };
            if (overflow || detail.length > 4000) {
                const { Readable } = require('stream');
                const stream = Readable.from([detail]);
                payload.files = [new Discord.MessageAttachment(stream, `checkcc_${targetId}.txt`)];
            }
            await interaction.editReply(payload);
        } catch (e) {
            func.handle_errors(e, interaction.client || client, 'checkcc.js', 'Error running /checkcc');
            try { await interaction.editReply({ content: 'Error running check. Please try again later.' }); } catch (_) {}
        }
    }
}


