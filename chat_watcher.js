const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const mysql = require('mysql2/promise');
const { wasRecentlyInjected } = require('./recentlyInjected');

// Path to the core's chat.log - on mangos it lives in build/src/logs/.
const LOG_PATH = process.env.CHAT_LOG_PATH;
const POLL_MS = Number(process.env.CHAT_POLL_MS || 1000);
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 3001);
const BRIDGE_CHARACTER = (process.env.BRIDGE_CHARACTER || 'Discord').toLowerCase();
const DB_CONFIG = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_CHARACTERS || 'characters'
};

if (!LOG_PATH) {
    console.error('Fehlende Angabe in .env: CHAT_LOG_PATH');
    process.exit(1);
}

const classIdMap = {
    '1': 'WARRIOR',
    '2': 'PALADIN',
    '3': 'HUNTER',
    '4': 'ROGUE',
    '5': 'PRIEST',
    '6': 'DEATHKNIGHT',
    '7': 'SHAMAN',
    '8': 'MAGE',
    '9': 'WARLOCK',
    '11': 'DRUID'
};

const classCache = {};

async function resolveClassFromDb(name) {
    if (!name) return null;
    if (name in classCache) return classCache[name];
    try {
        const conn = await mysql.createConnection(DB_CONFIG);
        const [rows] = await conn.execute('SELECT class FROM characters WHERE name = ? LIMIT 1', [name]);
        await conn.end();
        if (rows && rows.length && rows[0].class != null) {
            let cls = rows[0].class;
            if (typeof cls === 'number') cls = String(cls);
            if (typeof cls === 'string') {
                cls = cls.trim();
                if (classIdMap[cls]) {
                    cls = classIdMap[cls];
                } else {
                    cls = cls.toUpperCase();
                }
            }
            classCache[name] = cls || null;
            return classCache[name];
        }
    } catch (err) {
        log('DB lookup error: ' + (err && err.toString()));
    }
    classCache[name] = null;
    return null;
}

let lastSize = 0;

function log(msg) {
    const ts = new Date().toISOString();
    try { fs.appendFileSync(path.join(__dirname, 'chat_watcher.log'), `[${ts}] ${msg}\n`); } catch (e) { console.error('chat_watcher log error', e); }
}

async function sendToBridge(line) {
    let sender = 'server';
    let msg = line;
    let event = 'CHAT_LOG';
    let channel = 'SAY';

    const sep = line.lastIndexOf(' : ');
    if (sep !== -1) {
        const head = line.slice(0, sep);
        msg = line.slice(sep + 3).trim();
        const headMatch = head.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\[([^\]]+)\]\s+(.+)$/);
        if (headMatch) {
            const channelTag = headMatch[1];
            const remainder = headMatch[2];

            let senderParts = remainder.match(/^([^:]+):(\d+)(?::\d+)?$/);
            let classId = '';
            if (senderParts) {
                sender = senderParts[1] || 'server';
                classId = senderParts[2] || '';
            } else {
                senderParts = remainder.split(':');
                sender = senderParts[0] || 'server';
                classId = senderParts[1] || '';
            }

            // Anything said by the bridge character came from Discord in the
            // first place, spoken into the game by WoWChat. Do not bridge it
            // back or every message shows up twice.
            if (sender.toLowerCase() === BRIDGE_CHARACTER) {
                log(`skip bridge character echo: ${msg}`);
                return;
            }

            let className = sender.toLowerCase() !== BRIDGE_CHARACTER && sender !== 'server'
                ? await resolveClassFromDb(sender)
                : null;
            className = className ? String(className).toUpperCase() : null;

            channel = channelTag;
            if (/^Chan/i.test(channelTag)) {
                // Of the custom channels bridge ONLY "World". The channel name
                // follows the last ":", e.g. "Chan|GM:World" -> "World",
                // "Chan|GM:Lft" -> "Lft". Everything else is skipped: addon
                // sync like "ATW:1060:v", zone general, and so on.
                const chanName = channelTag.split(':').pop().trim();
                if (!/^World$/i.test(chanName)) {
                    log(`skip addon/custom channel "${channelTag}": ${remainder}`);
                    return;
                }
                event = 'CHAT_MSG_CHANNEL';
                channel = 'World';
            } else if (/^Say/i.test(channelTag)) {
                event = 'CHAT_MSG_SAY';
            } else if (/^Yell/i.test(channelTag)) {
                event = 'CHAT_MSG_YELL';
            } else if (/Guild/i.test(channelTag)) {
                event = 'CHAT_MSG_GUILD';
            } else if (/Emote/i.test(channelTag)) {
                event = 'CHAT_MSG_EMOTE';
            } else {
                // Allow list: bridge public channels only - say, yell, guild,
                // world, emote. Party, raid, lft and friends are internal
                // coordination, mostly between bots, and stay out of Discord.
                log(`skip non-public channel "${channelTag}": ${remainder}`);
                return;
            }
            // mangos marks GM messages in the channel tag with "|GM", e.g.
            // "[Say|GM]" - usable as is, no extra database lookup needed.
            const isGM = /\|GM\b/i.test(channelTag);

            // A message we just injected ourselves through Discord -> game
            // must not be bridged back as a "new" game message, or it loops.
            if (wasRecentlyInjected(msg)) {
                log(`skip echo of self-injected message: ${msg}`);
                return;
            }

            const payload = { event, sender, msg, class: className, faction: null, channel, gm: isGM };
            fetch(`http://127.0.0.1:${BRIDGE_PORT}/wowchat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(res => {
                if (!res.ok) log(`failed POST ${res.status}`);
            }).catch(err => {
                log('POST error: ' + (err && err.toString()));
            });
        }
    }
}

function pollFile() {
    fs.stat(LOG_PATH, (err, stat) => {
        if (err) return; // file may not exist yet
        const size = stat.size;
        if (size > lastSize) {
            const stream = fs.createReadStream(LOG_PATH, { start: lastSize, end: size - 1, encoding: 'utf8' });
            let buf = '';
            stream.on('data', chunk => { buf += chunk; });
            stream.on('end', async () => {
                const lines = buf.split(/\r?\n/);
                for (let l of lines) {
                    l = l.trim();
                    if (l.length === 0) continue;
                    await sendToBridge(l);
                }
            });
            stream.on('error', e => { log('read error: ' + (e && e.toString())); });
            lastSize = size;
        } else if (size < lastSize) {
            // rotated/truncated
            lastSize = size;
        }
    });
}

// initialize lastSize
try {
    const s = fs.statSync(LOG_PATH);
    lastSize = s.size;
} catch (e) {
    lastSize = 0;
}

setInterval(pollFile, POLL_MS);
log('chat_watcher started, watching ' + LOG_PATH);



