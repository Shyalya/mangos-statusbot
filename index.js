require("dotenv").config();

const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const mysql = require('mysql2/promise');
const fetch = require('node-fetch');
const net = require("net");
require("./wowbridge.js");
require("./chat_watcher.js");
const classIcons = require('./classIcons');
const zones = require('./zones');
const CLASS_BY_ID = { 1: 'WARRIOR', 2: 'PALADIN', 3: 'HUNTER', 4: 'ROGUE', 5: 'PRIEST', 6: 'DEATHKNIGHT', 7: 'SHAMAN', 8: 'MAGE', 9: 'WARLOCK', 11: 'DRUID' };

// =========================
// CONFIG
// =========================

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const CHAT_CHANNEL_ID = process.env.CHAT_CHANNEL_ID;

// Datenbank und Server, alles ueber die Umgebung einstellbar.
const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_CHARACTERS = process.env.DB_CHARACTERS || "characters";
const DB_LOGON = process.env.DB_LOGON || "realmd";
const REALMD_HOST = process.env.REALMD_HOST || "127.0.0.1";
const REALMD_PORT = Number(process.env.REALMD_PORT || 3724);
const WORLD_HOST = process.env.WORLD_HOST || "127.0.0.1";
const WORLD_PORT = Number(process.env.WORLD_PORT || 8085);

// Der Brueckencharakter spricht Discord-Nachrichten im Spiel aus. Er ist
// kein Spieler und gehoert nicht in Zaehlung und Liste.
const BRIDGE_CHARACTER = process.env.BRIDGE_CHARACTER || "Discord";

for (const [name, wert] of Object.entries({ DISCORD_TOKEN: TOKEN, STATUS_CHANNEL_ID: CHANNEL_ID, CHAT_CHANNEL_ID })) {
    if (!wert) {
        console.error(`Fehlende Angabe in .env: ${name}`);
        process.exit(1);
    }
}
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
// TCP CHECK (ultraschnell)
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
        console.log("Fehler beim Abrufen der Spieleranzahl:", err);
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

        const [rows] = await conn.execute(`
            SELECT name, level, class, zone
            FROM characters
            WHERE online = 1 AND name != ?
            ORDER BY level DESC, name ASC
            LIMIT 20
        `, [BRIDGE_CHARACTER]);

        await conn.end();
        return rows;
    } catch (err) {
        console.log("Fehler beim Abrufen der Spielerliste:", err);
        return [];
    }
}

// =========================
// UPTIME MODULE (im Bot selbst getrackt, unabhaengig vom crash.log-Format)
// =========================

// Liest die echte Server-Startzeit aus der uptime-Tabelle der Logon-
// Datenbank (robuster als
// bot-seitiges Tracking, das bei jedem kurzen Blip zuruecksetzt).
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
        console.log("Fehler beim Abrufen der Uptime:", err);
        return null;
    }
}

// =========================
// STATUS ERMITTELN
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
                title: "🔴 Server Offline",
                fields: [
                    { name: "Status", value: "Server nicht erreichbar (TCP-Check)", inline: false }
                ]
            }
        };
    }

    const players = await getPlayerCount();
    const uptime = await getUptime();
    const playerList = await getPlayerList();

    let playerText = "Keine Spieler online.";
    if (playerList.length > 0) {
        const lines = playerList.map(p => {
            const cname = CLASS_BY_ID[p.class];
            const icon = (cname && classIcons[cname]) ? classIcons[cname] + " " : "";
            const zoneName = zones[p.zone] || `Zone ${p.zone}`;
            return `${icon}**${p.name}** (Lvl ${p.level}) — ${zoneName}`;
        });
        // Discord-Embed-Feld: max 1024 Zeichen. So viele Zeilen wie passen,
        // Rest als "+N weitere" andeuten.
        let out = "", shown = 0;
        for (const line of lines) {
            if (out.length + line.length + 1 > 950) break;
            out += (out ? "\n" : "") + line;
            shown++;
        }
        if (shown < lines.length) out += `\n… +${lines.length - shown} weitere`;
        playerText = out;
    }

    return {
        isOnline: true,
        embed: {
            color: 0x00ff00,
            title: "🟢 Worldserver Online",
            fields: [
                { name: "👥 Spieler Online", value: `${players}`, inline: true },
                { name: "⏱ Uptime", value: uptime || "Unbekannt", inline: true },
                { name: "📜 Spielerliste", value: playerText }
            ]
        }
    };
}


// =========================
// STATUS MESSAGE UPDATER
// =========================

// Schickt eine Crash/Online-Meldung und loescht dabei die vorherige, damit
// der Kanal nicht mit alten Meldungen vollmuellt - es steht immer nur die
// aktuellste da.
async function sendAlert(channel, text) {
    if (lastAlertMessageId) {
        try {
            const oldMsg = await channel.messages.fetch(lastAlertMessageId);
            await oldMsg.delete();
        } catch (e) {
            // Nachricht war schon weg (z.B. manuell geloescht) - kein Problem.
        }
    }
    const newMsg = await channel.send(text);
    lastAlertMessageId = newMsg.id;
    fs.writeFileSync(ALERT_FILE, lastAlertMessageId);
}

async function updateStatusMessage() {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
    console.log("❌ Fehler: CHANNEL_ID ungültig oder Bot hat keine Rechte!");
    return;
    }
    const status = await getStatus();

    if (lastOnlineState === true && status.isOnline === false) {
        await sendAlert(channel, "⚠️ **Server Crash erkannt!**");
    }

    if (lastOnlineState === false && status.isOnline === true) {
        await sendAlert(channel, "✅ **Server ist wieder online!**");
    }

    lastOnlineState = status.isOnline;

    if (lastStatusMessageId) {
        try {
            const msg = await channel.messages.fetch(lastStatusMessageId);
            await msg.edit({ embeds: [status.embed] });
        } catch (e) {
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
// Seit dem Linux-Umzug uebernimmt WoWChat (eigener Dienst, headless) die
// Richtung Discord -> WoW direkt - kein AHK-Injector/WoW-Client mehr noetig.
// Dieser Bot macht nur noch Status + WoW -> Discord (via chat_watcher).

// =========================
// BOT START
// =========================

client.once('ready', async () => {
    console.log(`Status-Bot online als ${client.user.tag}`);

    try {
        global.discordChannel = await client.channels.fetch(CHAT_CHANNEL_ID);
        console.log("Discord-Chat-Bridge aktiv.");
    } catch (err) {
        console.log("Fehler: Konnte Discord-Channel nicht laden:", err);
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

client.login(TOKEN);
