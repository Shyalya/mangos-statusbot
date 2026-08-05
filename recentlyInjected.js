// Wird von wowbridge.js (Discord -> WoW) UND chat_watcher.js (WoW -> Discord)
// im selben Node-Prozess geteilt (CommonJS-Modul-Cache), damit Nachrichten,
// die wir selbst gerade ins Spiel getippt haben, nicht als "neue" WoW-Chat-
// Nachricht zurueck nach Discord gebrueckt werden (Echo-Schleife).
const recent = new Map(); // normalisierter Text -> Zeitstempel
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
  recent.delete(key); // einmal konsumieren, damit spaetere echte Wiederholungen nicht blockiert werden
  return Date.now() - ts <= TTL_MS;
}

module.exports = { markInjected, wasRecentlyInjected };
