# mangos-statusbot

A Discord bot for vanilla WoW servers running a mangos-family core
(cmangos, mangos-zero, Turtle WoW / tortoise-wow). It does two things:

- **Status embed** — one self-updating message showing whether realmd and the
  world server answer on TCP, how long the server has been up, how many
  characters are online, and who they are with class icon, level and zone.
  Posts a notice when the server drops and another when it comes back.
- **Chat bridge (game to Discord)** — tails the core's `chat.log` and mirrors
  public channels into a Discord channel as colour-coded embeds.

The other direction (Discord to game) is deliberately **not** included. Use
[WoWChat](https://github.com/fjaros/wowchat) for that; this bot detects and
skips the echo so the two can run side by side.

## What it reads

Nothing is written to your databases. The bot only issues `SELECT`s:

| Source | Used for |
|---|---|
| `characters.characters` | online count, player list, class lookup |
| `realmd.uptime` | server start time |
| TCP connect to realmd and world port | reachability |
| the core's `chat.log` | chat bridge |

Table and database names are configurable — the defaults match cmangos.

## Requirements

- Node.js 18 or newer
- read access to the core's MySQL and to `chat.log`
- a Discord bot token with the **Message Content** intent enabled

## Setup

```bash
git clone https://github.com/<you>/mangos-statusbot.git
cd mangos-statusbot
npm install
cp .env.example .env
$EDITOR .env
node index.js
```

Every setting lives in `.env`; see `.env.example` for the full list with
comments. The bot refuses to start if the Discord token or the channel IDs
are missing.

To run it permanently, adapt `statusbot.service.example` and drop it into
`/etc/systemd/system/`.

### Which channels get bridged

Only public ones: Say, Yell, Guild, Emote, and the custom `World` channel.
Party, raid and addon-sync channels are skipped on purpose — on a server with
playerbots those carry a constant stream of internal coordination that has no
business in Discord.

## Notes

- Give the bot's MySQL user read-only access. It never needs to write.
- The bridge listens on `127.0.0.1` only.

## Licence

MIT
