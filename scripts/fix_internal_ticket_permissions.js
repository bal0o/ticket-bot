/**
 * One-time script to add the ticket user to existing internal ticket channel permissions.
 * Run with: node scripts/fix_internal_ticket_permissions.js [--dry-run]
 *
 * For channels created before the internal-ticket-permissions update, the user was not
 * added to the channel. This script finds open internal ticket channels and adds the
 * user (from channel topic) to the permission overwrites so they can participate directly.
 */

const { Client, Intents } = require("discord.js");
const dryRun = process.argv.includes("--dry-run");
const path = require("path");
const config = require(path.join(__dirname, "../config/config.json"));

async function main() {
    const staffGuildId = config.channel_ids?.staff_guild_id;
    if (!staffGuildId) {
        console.error("[fix_internal] No staff_guild_id in config. Aborting.");
        process.exit(1);
    }

    // Load handler to find internal ticket types and their categories
    const handlerOptions = require(path.join(__dirname, "../content/handler/options.json")).options || {};
    const internalCategoryIds = new Set();
    const internalTypeNames = [];

    const internalNamePrefixes = [];
    for (const [displayName, opt] of Object.entries(handlerOptions)) {
        if (!opt?.question_file) continue;
        try {
            const qf = require(path.join(__dirname, "../content/questions", opt.question_file));
            if (qf && qf.internal) {
                internalTypeNames.push(displayName);
                const catId = qf["ticket-category"];
                if (catId) internalCategoryIds.add(catId);
                const slug = displayName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
                if (slug) internalNamePrefixes.push(slug);
                internalNamePrefixes.push(displayName.toLowerCase().replace(/\s+/g, " "));
            }
        } catch (_) {}
    }

    const isInternalChannel = (ch) => {
        const parentId = ch.parentId || ch.parent?.id;
        if (parentId && internalCategoryIds.has(parentId)) return true;
        const name = (ch.name || "").toLowerCase();
        const withoutNumber = name.replace(/-?\d+$/, "").replace(/-$/, "");
        return internalNamePrefixes.some((p) => withoutNumber === p || withoutNumber.endsWith("-" + p));
    };

    console.log(`[fix_internal] Internal ticket types: ${internalTypeNames.join(", ")}`);
    console.log(`[fix_internal] Internal ticket categories: ${[...internalCategoryIds].join(", ") || "(none)"}`);

    const client = new Client({
        intents: [Intents.FLAGS.GUILDS],
    });

    await client.login(config.tokens?.bot_token);
    if (!client.user) {
        console.error("[fix_internal] Failed to login.");
        process.exit(1);
    }

    const guild = await client.guilds.fetch(staffGuildId).catch(() => null);
    if (!guild) {
        console.error("[fix_internal] Could not fetch staff guild.");
        client.destroy();
        process.exit(1);
    }

    await guild.channels.fetch();
    const textChannels = guild.channels.cache.filter(
        (ch) => ch.type === "GUILD_TEXT" && /^\d{17,19}$/.test(String(ch.topic || "").trim())
    );

    let fixed = 0;
    let skipped = 0;
    let errors = 0;

    for (const channel of textChannels.values()) {
        const userId = String(channel.topic || "").trim();

        if (!isInternalChannel(channel)) continue;

        const overwrites = channel.permissionOverwrites?.cache;
        const hasUser = overwrites?.some((o) => o.id === userId);
        if (hasUser) {
            skipped++;
            continue;
        }

        try {
            if (dryRun) {
                console.log(`[fix_internal] Would add user ${userId} to #${channel.name} (${channel.id})`);
                fixed++;
            } else {
                await channel.permissionOverwrites.edit(userId, {
                    VIEW_CHANNEL: true,
                    SEND_MESSAGES: true,
                    READ_MESSAGE_HISTORY: true,
                });
                console.log(`[fix_internal] Added user ${userId} to #${channel.name} (${channel.id})`);
                fixed++;
            }
        } catch (e) {
            console.error(`[fix_internal] Failed #${channel.name}:`, e?.message || e);
            errors++;
        }
    }

    console.log(`[fix_internal] Done. ${dryRun ? "Would fix" : "Fixed"}: ${fixed}, skipped (already had user): ${skipped}, errors: ${errors}`);
    client.destroy();
    process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error("[fix_internal]", e);
    process.exit(1);
});
