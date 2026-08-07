// Custom emoji shown next to player names, per class.
//
// Emoji IDs are specific to one Discord server, so there is nothing sensible
// to ship here. Upload your own class icons, then either fill in the map
// below or set CLASS_ICONS in .env to a JSON object of the same shape:
//
//   CLASS_ICONS={"WARRIOR":"<:warrior:123456789012345678>", ...}
//
// Leave it empty and the bot simply prints names without icons.
let icons = {
    WARRIOR: "",
    PALADIN: "",
    HUNTER: "",
    ROGUE: "",
    PRIEST: "",
    DEATHKNIGHT: "",
    SHAMAN: "",
    MAGE: "",
    WARLOCK: "",
    DRUID: ""
};

if (process.env.CLASS_ICONS) {
    try {
        icons = Object.assign(icons, JSON.parse(process.env.CLASS_ICONS));
    } catch (e) {
        console.error("CLASS_ICONS is not valid JSON, icons will be omitted:", e.message);
    }
}

module.exports = icons;
