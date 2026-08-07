const express = require("express");
const fetch = require('node-fetch');
const fs = require('fs');
const classIcons = require('./classIcons');
const { markInjected } = require('./recentlyInjected');
const app = express();

const LOG_FILE = __dirname + "/wowbridge.log";

function logBridge(line) {
    const ts = new Date().toISOString();
    try {
        fs.appendFileSync(LOG_FILE, `[${ts}] ${line}\n`);
    } catch (e) {
        console.error('Failed to write wowbridge log:', e);
    }
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// -----------------------------
// HÜBSCHE EMBED FORMATIERUNG
// -----------------------------
const recentMessages = new Map();

function shouldSendPayload(payload) {
    const key = `${payload.sender}|${payload.channel}|${payload.msg}|${payload.event}|${payload.className || ''}`;
    const now = Date.now();
    const last = recentMessages.get(key);
    if (last && now - last < 2000) {
        return false;
    }
    recentMessages.set(key, now);
    for (const [k, timestamp] of recentMessages.entries()) {
        if (now - timestamp > 60_000) {
            recentMessages.delete(k);
        }
    }
    return true;
}

function buildChatEmbed(data) {
    const { sender = 'Unknown', msg = '', event, className, faction, channel, gm } = data;

    const channelKey = (channel || event || 'Chat').toString();
    const normalizedChannel = channelKey.trim();

    const channelMap = [
        { matcher: /^Say/i, name: '💬 Say', color: 0x99aab5 },
        { matcher: /^Yell/i, name: '📢 Yell', color: 0xff8c00 },
        { matcher: /^Guild/i, name: '🛡 Guild', color: 0x43b581 },
        { matcher: /^Party/i, name: '👥 Party', color: 0x56a1d6 },
        { matcher: /^Raid/i, name: '⚔ Raid', color: 0xb97c2a },
        { matcher: /^Emote/i, name: '🎭 Emote', color: 0xf1c40f },
        { matcher: /^World/i, name: '🌍 World', color: 0x1abc9c },
        { matcher: /^Chan/i, name: '💬 Channel', color: 0x7f8c8d }
    ];

    const channelEntry = channelMap.find(entry => entry.matcher.test(normalizedChannel)) || { name: normalizedChannel || 'Chat', color: 0xcccccc };

    const eventNames = {
        CHAT_MSG_SAY: 'Say',
        CHAT_MSG_YELL: 'Yell',
        CHAT_MSG_GUILD: 'Guild',
        CHAT_MSG_PARTY: 'Party',
        CHAT_MSG_RAID: 'Raid',
        CHAT_MSG_EMOTE: 'Emote',
        CHAT_LOG: 'Chat'
    };
    const eventName = eventNames[event] || event || 'Chat';

    const normalizedClassName = className ? String(className).toUpperCase() : null;
    const classColors = {
        WARRIOR: 0xC79C6E,
        PALADIN: 0xF58CBA,
        HUNTER: 0xABD473,
        ROGUE: 0xFFF569,
        PRIEST: 0xFFFFFF,
        DEATHKNIGHT: 0xC41F3B,
        SHAMAN: 0x0070DE,
        MAGE: 0x69CCF0,
        WARLOCK: 0x9482C9,
        DRUID: 0xFF7D0A
    };
    const embedColor = gm ? 0xFFD700 : (normalizedClassName ? classColors[normalizedClassName] || channelEntry.color : channelEntry.color);
    const icon = normalizedClassName ? classIcons[normalizedClassName] || '' : '';
    const gmBadge = gm ? "🛡️ [GM] " : "";
    const title = `${gmBadge}${icon ? icon + " " : ""}${sender}`;


    const fields = [];
    if (faction) fields.push({ name: 'Faction', value: faction, inline: true });

    return {
        embeds: [
            {
                color: embedColor,
                title: title,
                description: channelEntry.name + ': ' + (msg || '_(empty)_'),
                fields,
                timestamp: new Date().toISOString()
            }
        ]
    };
}

// -----------------------------
// API ENDPOINT
// -----------------------------
app.post("/wowchat", (req, res) => {
    const data = {
        event: req.body.event,
        sender: req.body.sender,
        msg: req.body.msg,
        className: req.body.class,
        faction: req.body.faction,
        channel: req.body.channel,
        gm: req.body.gm
    };

    console.log("[WoW → Discord]", data);
    logBridge(`RECV ${JSON.stringify(data)}`);

    const payload = {
        sender: data.sender,
        channel: data.channel,
        msg: data.msg,
        event: data.event,
        className: data.className
    };
    if (!shouldSendPayload(payload)) {
        console.log('Duplicate WoW message skipped:', payload);
        logBridge(`SKIP_DUPLICATE ${JSON.stringify(payload)}`);
        return res.send('OK');
    }

    const embed = buildChatEmbed(data);
    if (global.discordChannel) {
        try {
            global.discordChannel.send(embed).then(() => {
                console.log('Sent message to Discord channel');
                logBridge(`SENT ${JSON.stringify({sender: data.sender, channel: data.channel, msg: data.msg})}`);
            }).catch(err => {
                console.error('Error sending to Discord channel (promise):', err);
                logBridge(`ERR send ${err && err.toString()}`);
            });
        } catch (err) {
            console.error("Error invoking send to Discord channel:", err);
        }
    } else {
        if (!global._wowBridgeQueue) global._wowBridgeQueue = [];
        global._wowBridgeQueue.push(embed.embeds[0]);
        console.log("Discord channel not ready — queued message (queue length:", global._wowBridgeQueue.length + ")");
        logBridge(`QUEUED ${JSON.stringify({sender: data.sender, msg: data.msg})} (len=${global._wowBridgeQueue.length})`);
    }

    res.send("OK");
});

// -----------------------------
// DISCORD → WoW endpoint
// -----------------------------
app.post("/discordToWow", (req, res) => {
    try {
        const channel = req.body.channel || req.query.channel;
        const text = req.body.text || req.query.text;
        if (!channel || !text) return res.status(400).send('missing channel or text');

        const outFile = __dirname + "/discord_to_wow.txt";
        const line = `${channel}|${text.replace(/\r?\n/g, ' ')}\n`;
        fs.appendFileSync(outFile, line);
        markInjected(text);
        console.log(`Queued Discord→WoW: ${channel} | ${text}`);
        logBridge(`DISCORD2WOW ${channel} ${text}`);
        return res.send('OK');
    } catch (err) {
        console.error('Error in /discordToWow:', err);
        logBridge(`ERR discordToWow ${err && err.toString()}`);
        return res.status(500).send('error');
    }
});

// -----------------------------
// SERVER START
// -----------------------------
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 3001);
app.listen(BRIDGE_PORT, "127.0.0.1", () => {
    console.log(`WoW bridge API listening on port ${BRIDGE_PORT}`);
});

// Periodically try to flush queued messages if the bot becomes available
setInterval(() => {
    try {
        if (global._wowBridgeQueue && global._wowBridgeQueue.length > 0 && global.discordChannel) {
            const q = global._wowBridgeQueue.splice(0);
            console.log(`Flushing ${q.length} queued WoW messages to Discord`);
            logBridge(`FLUSH ${q.length} messages`);
            q.forEach(payload => {
                try {
                    global.discordChannel.send({ embeds: [payload] }).then(() => {
                        console.log('Flushed queued message to Discord');
                    }).catch(e => {
                        console.error('Failed to send queued message (promise):', e);
                    });
                } catch (e) {
                    console.error('Failed to send queued message:', e);
                }
            });
        }
    } catch (err) {
        console.error('Error flushing wowbridge queue:', err);
    }
}, 5000);

