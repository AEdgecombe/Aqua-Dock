import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AquaDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(540, 720);

        // --- Layout ---------------------------------------------------------
        const layoutPage = new Adw.PreferencesPage({
            title: 'Layout',
            icon_name: 'view-grid-symbolic',
        });
        window.add(layoutPage);

        const placement = new Adw.PreferencesGroup({title: 'Placement'});
        layoutPage.add(placement);

        const positions = ['bottom', 'left', 'right'];
        const positionRow = new Adw.ComboRow({
            title: 'Position',
            subtitle: 'Screen edge the dock sits on',
            model: Gtk.StringList.new(['Bottom', 'Left', 'Right']),
            selected: Math.max(0, positions.indexOf(settings.get_string('position'))),
        });
        positionRow.connect('notify::selected', row => {
            settings.set_string('position', positions[row.selected]);
        });
        placement.add(positionRow);

        placement.add(this._spin(settings, 'edge-margin', 'Edge margin', 'Gap from the screen edge (px)', 0, 80));

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        layoutPage.add(behaviour);

        behaviour.add(this._switch(settings, 'autohide', 'Auto-hide',
            'Hide the dock and reveal it when the pointer touches the edge'));
        behaviour.add(this._switch(settings, 'show-running-indicators', 'Running indicators',
            'Show a dot under apps with open windows'));
        behaviour.add(this._switch(settings, 'hover-zoom', 'Hover zoom',
            'Magnify icons on mouse-over, like macOS'));

        // --- Appearance -----------------------------------------------------
        const lookPage = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(lookPage);

        const sizing = new Adw.PreferencesGroup({title: 'Sizing'});
        lookPage.add(sizing);
        sizing.add(this._spin(settings, 'icon-size', 'Icon size', 'Size of each app icon (px)', 24, 128));
        sizing.add(this._spin(settings, 'item-spacing', 'Icon spacing', 'Gap between icons (px)', 0, 30));
        sizing.add(this._spin(settings, 'dock-padding', 'Dock padding', 'Inner padding around the icons (px)', 0, 30));

        const surface = new Adw.PreferencesGroup({title: 'Surface'});
        lookPage.add(surface);
        surface.add(this._spin(settings, 'dock-opacity', 'Background opacity', 'Panel opacity (%)', 0, 100));
        surface.add(this._spin(settings, 'corner-radius', 'Corner radius', 'Rounding of the dock corners (px)', 0, 48));
        surface.add(this._switch(settings, 'dark-background', 'Dark background',
            'Use a dark translucent panel instead of a light one'));
    }

    _spin(settings, key, title, subtitle, min, max) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _switch(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
