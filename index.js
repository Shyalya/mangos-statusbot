require("dotenv").config();

const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const mysql = require('mysql2/promise');
const fetch = require('node-fetch');
const net = require("net");
const classIcons = require('./classIcons');
const zones = require('./zones');
const CLASS_BY_ID = { 1: 'WARRIOR', 2: 'PALADIN', 3: 'HUNTER', 4: 'ROGUE', 5: 'PRIEST', 6: 'DEATHKNIGHT', 7: 'SHAMAN', 8: 'MAGE', 9: 'WARLOCK', 11: 'DRUID' };

// =========================
// CONFIG
// =========================

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const CHAT_CHANNEL_ID = process.env.CHAT_CHANNEL_ID;

// Database and server, all configurable through the environment.
const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_CHARACTERS = process.env.DB_CHARACTERS || "characters";
const DB_LOGON = process.env.DB_LOGON || "realmd";
const REALMD_HOST = process.env.REALMD_HOST || "127.0.0.1";
const REALMD_PORT = Number(process.env.REALMD_PORT || 3724);
const WORLD_HOST = process.env.WORLD_HOST || "127.0.0.1";
const WORLD_PORT = Number(process.env.WORLD_PORT || 8085);

// The bridge character speaks Discord messages out in game. It is not a
// player and does not belong in the count or the list.
const BRIDGE_CHARACTER = process.env.BRIDGE_CHARACTER || "Discord";

// Account name prefix that marks a bot, so real players can be listed
// first. Leave empty to treat every account as a player.
const BOT_ACCOUNT_PREFIX = process.env.BOT_ACCOUNT_PREFIX || "";

const PFLICHTFELDER = {
    DISCORD_TOKEN: TOKEN,
    STATUS_CHANNEL_ID: CHANNEL_ID,
    CHAT_CHANNEL_ID: CHAT_CHANNEL_ID,
    CHAT_LOG_PATH: process.env.CHAT_LOG_PATH
};

const fehlend = Object.entries(PFLICHTFELDER).filter(([, wert]) => !wert).map(([name]) => name);
if (fehlend.length) {
    console.error("Fehlende Angaben in .env: " + fehlend.join(", "));
    console.error("Vorlage siehe .env.example");
    process.exit(1);
}

// Require only now - both modules read their settings on load.
require("./wowbridge.js");
require("./chat_watcher.js");
const STATUS_FILE = "status_message_id.txt";
const ALERT_FILE = "alert_message_id.txt";
const CHECK_INTERVAL_MS = 20 * 1000;

// =========================
// DISCORD CLIENT
// =========================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let lastStatusMessageId = null;
let lastAlertMessageId = null;
let lastOnlineState = null;
let onlineSince = null;
global.discordChannel = null;

// =========================
// TCP CHECK (very fast)
// =========================

function checkServer(host, port, timeout = 500) {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let status = "offline";

        socket.setTimeout(timeout);

        socket.on("connect", () => {
            status = "online";
            socket.destroy();
        });

        socket.on("timeout", () => {
            status = "offline";
            socket.destroy();
        });

        socket.on("error", () => {
            status = "offline";
        });

        socket.on("close", () => {
            resolve(status);
        });

        socket.connect(port, host);
    });
}

// =========================
// DB MODULES
// =========================

async function getPlayerCount() {
    try {
        const conn = await mysql.createConnection({
            host: DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: DB_CHARACTERS
        });

        const [rows] = await conn.execute(
            "SELECT COUNT(*) AS count FROM characters WHERE online = 1 AND name != ?",
            [BRIDGE_CHARACTER]);
        await conn.end();

        return rows[0].count;
    } catch (err) {
        console.log("Failed to fetch the player count:", err);
        return 0;
    }
}

async function getPlayerList() {
    try {
        const conn = await mysql.createConnection({
            host: DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: DB_CHARACTERS
        });

        // Real players first, whatever their level. Bots sit on their own
        // accounts, recognised by BOT_ACCOUNT_PREFIX; leave that empty and
        // everyone is treated as a player.
        const [rows] = await conn.execute(`
            SELECT c.name, c.level, c.class, c.zone,
                   CASE WHEN ? = '' THEN 0
                        WHEN a.username LIKE CONCAT(?, '%') THEN 1
                        ELSE 0 END AS isBot
            FROM characters c
            JOIN ${DB_LOGON}.account a ON a.id = c.account
            WHERE c.online = 1 AND c.name != ?
            ORDER BY isBot ASC, c.level DESC, c.name ASC
            LIMIT 20
        `, [BOT_ACCOUNT_PREFIX, BOT_ACCOUNT_PREFIX, BRIDGE_CHARACTER]);

        await conn.end();
        return rows;
    } catch (err) {
        console.log("Failed to fetch the player list:", err);
        return [];
    }
}

// =========================
// UPTIME MODULE (read from the database, independent of any log format)
// =========================

// Reads the real server start time from the uptime table of the logon
// database. More robust than tracking it in the bot, which resets on
// every short blip.
async function getUptime() {
    try {
        const conn = await mysql.createConnection({
            host: DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: DB_LOGON
        });
        const [rows] = await conn.execute("SELECT starttime FROM uptime ORDER BY starttime DESC LIMIT 1");
        await conn.end();
        if (!rows.length) return null;
        const diffSec = Math.floor(Date.now() / 1000) - Number(rows[0].starttime);
        if (diffSec < 0) return null;
        const days = Math.floor(diffSec / 86400);
        const hours = Math.floor((diffSec % 86400) / 3600);
        const minutes = Math.floor((diffSec % 3600) / 60);
        return days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m`;
    } catch (err) {
        console.log("Failed to fetch the uptime:", err);
        return null;
    }
}

// =========================
// DETERMINE STATUS
// =========================

async function getStatus() {

    const realmd = await checkServer(REALMD_HOST, REALMD_PORT);
    const world = await checkServer(WORLD_HOST, WORLD_PORT);
    const isOnline = realmd === "online" && world === "online";

    if (isOnline && !onlineSince) {
        onlineSince = Date.now();
    }
    if (!isOnline) {
        onlineSince = null;
    }

    if (!isOnline) {
        return {
            isOnline: false,
            embed: {
                color: 0xff0000,
                title: "🔴 Server offline",
                fields: [
                    { name: "Status", value: "Server unreachable (TCP check)", inline: false }
                ]
            }
        };
    }

    const players = await getPlayerCount();
    const uptime = await getUptime();
    const playerList = await getPlayerList();

    let playerText = "No players online.";
    if (playerList.length > 0) {
        const lines = playerList.map(p => {
            const cname = CLASS_BY_ID[p.class];
            const icon = (cname && classIcons[cname]) ? classIcons[cname] + " " : "";
            const zoneName = zones[p.zone] || `Zone ${p.zone}`;
            return `${icon}**${p.name}** (Lvl ${p.level}) — ${zoneName}`;
        });
        // A Discord embed field holds at most 1024 characters. Fit as many
        // lines as possible, then hint at the rest with "+N more".
        let out = "", shown = 0;
        for (const line of lines) {
            if (out.length + line.length + 1 > 950) break;
            out += (out ? "\n" : "") + line;
            shown++;
        }
        playerText = out;
    }

    return {
        isOnline: true,
        embed: {
            color: 0x00ff00,
            title: "🟢 World server online",
            fields: [
                { name: "👥 Players online", value: `${players}`, inline: true },
                { name: "⏱ Uptime", value: uptime || "unknown", inline: true },
                { name: "📜 Player list", value: playerText }
            ]
        }
    };
}


// =========================
// STATUS MESSAGE UPDATER
// =========================

// Sends a crash/online notice and deletes the previous one, so the channel
// does not fill up with stale notices - only the most recent one stands.
async function sendAlert(channel, text) {
    if (lastAlertMessageId) {
        try {
            const oldMsg = await channel.messages.fetch(lastAlertMessageId);
            await oldMsg.delete();
        } catch (e) {
            // Message was already gone (deleted by hand, say) - no problem.
        }
    }
    const newMsg = await channel.send(text);
    lastAlertMessageId = newMsg.id;
    fs.writeFileSync(ALERT_FILE, lastAlertMessageId);
}

async function updateStatusMessage() {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
    console.log("❌ Error: invalid CHANNEL_ID, or the bot lacks permission.");
    return;
    }
    const status = await getStatus();

    if (lastOnlineState === true && status.isOnline === false) {
        await sendAlert(channel, "⚠️ **Server crash detected.**");
    }

    if (lastOnlineState === false && status.isOnline === true) {
        await sendAlert(channel, "✅ **Server is back online.**");
    }

    lastOnlineState = status.isOnline;

    if (lastStatusMessageId) {
        try {
            const msg = await channel.messages.fetch(lastStatusMessageId);
            await msg.edit({ embeds: [status.embed] });
        } catch (e) {
            // Only post a replacement when the old message is genuinely gone.
            // Discord code 10008 is "Unknown Message". Anything else - a 503,
            // a rate limit, a network blip - is transient: keep the id and try
            // again next tick. Posting on every error leaves orphaned embeds
            // behind that nothing updates any more.
            if (e?.code !== 10008) {
                console.log("Could not edit the status message, will retry:", e?.message || e);
                return;
            }
            const newMsg = await channel.send({ embeds: [status.embed] });
            lastStatusMessageId = newMsg.id;
            fs.writeFileSync(STATUS_FILE, lastStatusMessageId);
        }
    } else {
        const newMsg = await channel.send({ embeds: [status.embed] });
        lastStatusMessageId = newMsg.id;
        fs.writeFileSync(STATUS_FILE, lastStatusMessageId);
    }
}

// =========================
// DISCORD → WoW CHAT BRIDGE
// =========================
// WoWChat (a separate headless service) handles the Discord -> game
// direction. This bot only does status plus game -> Discord, through
// chat_watcher.

// =========================
// BOT START
// =========================

client.once('ready', async () => {
    console.log(`Status bot online as ${client.user.tag}`);

    try {
        global.discordChannel = await client.channels.fetch(CHAT_CHANNEL_ID);
        console.log("Discord chat bridge active.");
    } catch (err) {
        console.log("Error: could not load the Discord channel:", err);
    }

    if (fs.existsSync(STATUS_FILE)) {
        lastStatusMessageId = fs.readFileSync(STATUS_FILE, "utf8");
    }
    if (fs.existsSync(ALERT_FILE)) {
        lastAlertMessageId = fs.readFileSync(ALERT_FILE, "utf8");
    }

    await updateStatusMessage();
    setInterval(updateStatusMessage, CHECK_INTERVAL_MS);
});

// Discord answers /gateway/bot with 503 often enough that dying on it is not
// acceptable: systemd restarts the process, and every run that cannot reach
// its old status message posts a new one. Retry with a growing delay instead.
async function login() {
    for (let attempt = 1; ; attempt++) {
        try {
            await client.login(TOKEN);
            return;
        } catch (e) {
            const wait = Math.min(60, 5 * attempt);
            console.log(`Login failed (attempt ${attempt}): ${e?.message || e} - retrying in ${wait}s`);
            await new Promise(r => setTimeout(r, wait * 1000));
        }
    }
}

login();
