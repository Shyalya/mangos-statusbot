// Shared between wowbridge.js (Discord -> game) and chat_watcher.js
// (game -> Discord) within the same Node process, through the CommonJS
// module cache. Without it, a message we just typed into the game comes
// straight back to Discord as if it were new - an echo loop.
const recent = new Map(); // normalised text -> timestamp
const TTL_MS = 15000;

function normalize(text) {
  return (text || "").trim().toLowerCase();
}

function markInjected(text) {
  recent.set(normalize(text), Date.now());
}

function wasRecentlyInjected(text) {
  const key = normalize(text);
  const ts = recent.get(key);
  if (!ts) return false;
  recent.delete(key); // consume once, so a later genuine repeat is not swallowed
  return Date.now() - ts <= TTL_MS;
}

module.exports = { markInjected, wasRecentlyInjected };
