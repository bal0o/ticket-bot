const Discord = require("discord.js");
const { SlashCommandBuilder } = require("@discordjs/builders");
const config = require("../../config/config.json");
const func = require("../../utils/functions.js");

function parseCheetosPlaintext(text) {
    const lines = String(text || "").split(/\r?\n/);
    const records = [];
    let current = null;
    for (const raw of lines) {
        const line = (raw || '').trimEnd();
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
        const lg = r['LastGuildScan'] ? parseInt(r['LastGuildScan'], 10) : null;
        if (Number.isFinite(lg) && lg > 0 && (!lastEpoch || lg > lastEpoch)) lastEpoch = lg;
    }
    let ltsStr = 'N/A';
    if (lastEpoch && Number.isFinite(lastEpoch)) {
        const nowSec = Math.floor(Date.now() / 1000);
        const diffSec = Math.max(0, nowSec - lastEpoch);
        const diffHours = Math.floor(diffSec / 3600);
        if (diffHours >= 24) {
            const d = Math.floor(diffHours / 24);
            ltsStr = `${d}d`;
        } else {
            ltsStr = `${diffHours}h`;
        }
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
            await interaction.deferReply({ ephemeral: true });

            // Channel restriction
            const allowedChannelId = client.config?.channel_ids?.checkcc_channel_id;
            if (allowedChannelId && interaction.channelId !== allowedChannelId) {
                await interaction.editReply({ content: 'This command can only be used in the designated channel.', ephemeral: true });
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
                await interaction.editReply({ content: 'You do not have permission to use this command.', ephemeral: true });
                return;
            }

            const targetId = (interaction.options.getString('userid') || '').trim();
            if (!/^\d{17,19}$/.test(targetId)) {
                await interaction.editReply({ content: 'Please provide a valid Discord user ID.', ephemeral: true });
                return;
            }

            // Require API token
            if (!client.config?.tokens?.cheetosToken) {
                await interaction.editReply({ content: 'Cheetos API token not configured.', ephemeral: true });
                return;
            }

            const unirest = require('unirest');
            const url = `https://Cheetos.gg/api.php?action=search&id=${encodeURIComponent(targetId)}`;
            const resp = await unirest.get(url).headers({
                'Auth-Key': client.config.tokens.cheetosToken,
                // Prefer configured requester ID; else the staff invoking the command
                'DiscordID': String(client.config?.misc?.cheetos_requestor_id || interaction.user.id)
            });
            const text = resp && resp.body ? (typeof resp.body === 'string' ? resp.body : (resp.body.toString ? resp.body.toString() : '')) : '';
            const records = parseCheetosPlaintext(text);
            const { count, ltsStr, wr } = summarizeRecords(records);

            // Compose summary (same format as ticket)
            const summary = count > 0 ? `Cheetos Check: ${count} CC • LTS: ${ltsStr} • ${wr} WR` : 'Cheetos Check: Clean';

            // Build detailed display for manual analysis
            let detail = '';
            if (records.length) {
                const chunks = records.map((r, idx) => {
                    const keys = Object.keys(r);
                    const lines = keys.map(k => `${k}: ${r[k]}`);
                    return `#${idx + 1}\n` + lines.join('\n');
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

            if (detail.length <= 4000) {
                embed.addFields({ name: 'Details', value: `\u200B\n\u200B\n\u200B\n\u200B\n${'```'}\n${detail}\n${'```'}` });
                await interaction.editReply({ embeds: [embed], ephemeral: true });
            } else {
                // Too long for embed; attach as a text file
                const { Readable } = require('stream');
                const stream = Readable.from([detail]);
                const attachment = new Discord.MessageAttachment(stream, `checkcc_${targetId}.txt`);
                await interaction.editReply({ embeds: [embed], files: [attachment], ephemeral: true });
            }
        } catch (e) {
            func.handle_errors(e, interaction.client || client, 'checkcc.js', 'Error running /checkcc');
            try { await interaction.editReply({ content: 'Error running check. Please try again later.', ephemeral: true }); } catch (_) {}
        }
    }
}


