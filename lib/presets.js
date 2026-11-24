// Style presets: named bundles of settings that make the dock look like a
// familiar desktop. No gi:// imports, so this is shared by extension.js,
// prefs.js and the Node unit tests.
//
// A preset is never stored: the "current preset" is whichever one matches
// the live settings exactly, and any manual tweak turns it into "Custom".

// GSettings type of every key a preset may set.
export const PRESET_KEY_TYPES = {
    'position': 's',
    'edge-margin': 'i',
    'panel-mode': 'b',
    'autohide': 'b',
    'hover-zoom': 'b',
    'show-running-indicators': 'b',
    'icon-size': 'i',
    'item-spacing': 'i',
    'dock-padding': 'i',
    'dock-opacity': 'i',
    'corner-radius': 'i',
    'dark-background': 'b',
};

export const PRESETS = [
    {
        id: 'aqua',
        name: 'Aqua',
        description: 'The default floating dark glass dock',
        settings: {
            'position': 'bottom', 'edge-margin': 8, 'panel-mode': false,
            'autohide': false, 'hover-zoom': true, 'show-running-indicators': true,
            'icon-size': 48, 'item-spacing': 6, 'dock-padding': 8,
            'dock-opacity': 80, 'corner-radius': 22, 'dark-background': true,
        },
    },
    {
        id: 'macos',
        name: 'macOS',
        description: 'Light frosted shelf with magnification',
        settings: {
            'position': 'bottom', 'edge-margin': 4, 'panel-mode': false,
            'autohide': false, 'hover-zoom': true, 'show-running-indicators': true,
            'icon-size': 52, 'item-spacing': 4, 'dock-padding': 5,
            'dock-opacity': 55, 'corner-radius': 18, 'dark-background': false,
        },
    },
    {
        id: 'macos-dark',
        name: 'macOS Dark',
        description: 'The macOS shelf in dark mode',
        settings: {
            'position': 'bottom', 'edge-margin': 4, 'panel-mode': false,
            'autohide': false, 'hover-zoom': true, 'show-running-indicators': true,
            'icon-size': 52, 'item-spacing': 4, 'dock-padding': 5,
            'dock-opacity': 45, 'corner-radius': 18, 'dark-background': true,
        },
    },
    {
        id: 'windows',
        name: 'Windows 11',
        description: 'Full-width taskbar with centred icons',
        settings: {
            'position': 'bottom', 'edge-margin': 0, 'panel-mode': true,
            'autohide': false, 'hover-zoom': false, 'show-running-indicators': true,
            'icon-size': 32, 'item-spacing': 6, 'dock-padding': 6,
            'dock-opacity': 88, 'corner-radius': 0, 'dark-background': true,
        },
    },
    {
        id: 'ubuntu',
        name: 'Ubuntu',
        description: 'Full-height launcher on the left',
        settings: {
            'position': 'left', 'edge-margin': 0, 'panel-mode': true,
            'autohide': false, 'hover-zoom': false, 'show-running-indicators': true,
            'icon-size': 44, 'item-spacing': 4, 'dock-padding': 6,
            'dock-opacity': 75, 'corner-radius': 0, 'dark-background': true,
        },
    },
    {
        id: 'chromeos',
        name: 'ChromeOS',
        description: 'Floating pill-shaped shelf',
        settings: {
            'position': 'bottom', 'edge-margin': 8, 'panel-mode': false,
            'autohide': false, 'hover-zoom': false, 'show-running-indicators': true,
            'icon-size': 40, 'item-spacing': 10, 'dock-padding': 8,
            'dock-opacity': 60, 'corner-radius': 32, 'dark-background': true,
        },
    },
    {
        id: 'minimal',
        name: 'Minimal',
        description: 'Auto-hiding icons with no panel behind them',
        settings: {
            'position': 'bottom', 'edge-margin': 4, 'panel-mode': false,
            'autohide': true, 'hover-zoom': true, 'show-running-indicators': false,
            'icon-size': 40, 'item-spacing': 6, 'dock-padding': 4,
            'dock-opacity': 0, 'corner-radius': 16, 'dark-background': true,
        },
    },
];

/**
 * @param {string} id
 * @returns {object|undefined}
 */
export function getPreset(id) {
    return PRESETS.find(preset => preset.id === id);
}

/**
 * Read one key from a Gio.Settings-like object using its declared type.
 *
 * @param {object} settings - Gio.Settings or a test double
 * @param {string} key
 * @returns {string|number|boolean}
 */
function readKey(settings, key) {
    switch (PRESET_KEY_TYPES[key]) {
        case 'b': return settings.get_boolean(key);
        case 'i': return settings.get_int(key);
        default: return settings.get_string(key);
    }
}

/**
 * @param {object} settings - Gio.Settings or a test double
 * @returns {object|null} the preset whose every value matches, or null.
 */
export function findMatchingPreset(settings) {
    return PRESETS.find(preset =>
        Object.entries(preset.settings).every(([key, value]) =>
            readKey(settings, key) === value)) ?? null;
}

/**
 * Write a preset in one batch, so listeners see a single change rather than
 * a dozen intermediate states.
 *
 * Gio.Settings.delay() can never be switched off again, so pass a
 * throwaway instance (e.g. a fresh `extension.getSettings()`), never one
 * that other code keeps writing through.
 *
 * @param {object} settings - a dedicated Gio.Settings, or a test double
 * @param {string} id
 * @returns {boolean} false if no preset has that id.
 */
export function applyPreset(settings, id) {
    const preset = getPreset(id);
    if (!preset)
        return false;

    settings.delay();
    try {
        for (const [key, value] of Object.entries(preset.settings)) {
            switch (PRESET_KEY_TYPES[key]) {
                case 'b': settings.set_boolean(key, value); break;
                case 'i': settings.set_int(key, value); break;
                default: settings.set_string(key, value);
            }
        }
        settings.apply();
    } catch (e) {
        settings.revert();
        throw e;
    }
    return true;
}
