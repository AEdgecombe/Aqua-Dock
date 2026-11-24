import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PRESETS, applyPreset, findMatchingPreset} from './lib/presets.js';

// Sample icons used only to populate the live preview.
const PREVIEW_ICONS = [
    'web-browser',
    'system-file-manager',
    'utilities-terminal',
    'text-editor',
    'preferences-desktop',
];

export default class AquaDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(560, 820);

        // A single CSS provider drives the preview's dynamic styling.
        this._css = new Gtk.CssProvider();
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            this._css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        // Each preview registers a refresh callback; one settings signal
        // fans out to all of them so both pages stay in sync live.
        this._refreshers = [];
        const changedId = settings.connect('changed', () => this._refreshAll());
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            Gtk.StyleContext.remove_provider_for_display(
                Gdk.Display.get_default(), this._css);
        });

        // --- Presets --------------------------------------------------------
        const presetPage = new Adw.PreferencesPage({
            title: 'Presets',
            icon_name: 'starred-symbolic',
        });
        window.add(presetPage);

        presetPage.add(this._makePreview(settings));
        presetPage.add(this._makePresetGroup(settings));

        // --- Layout ---------------------------------------------------------
        const layoutPage = new Adw.PreferencesPage({
            title: 'Layout',
            icon_name: 'view-grid-symbolic',
        });
        window.add(layoutPage);

        layoutPage.add(this._makePreview(settings));

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
        placement.add(this._switch(settings, 'panel-mode', 'Panel mode',
            'Stretch the dock along the whole edge, like a taskbar'));

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

        lookPage.add(this._makePreview(settings));

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

        this._refreshAll();
    }

    // --- presets ------------------------------------------------------------

    _makePresetGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Style presets',
            description: 'Apply a ready-made look, then fine-tune it on the other pages',
        });

        const rows = PRESETS.map(preset => {
            const row = new Adw.ActionRow({
                title: preset.name,
                subtitle: preset.description,
                activatable: true,
            });
            const check = new Gtk.Image({
                icon_name: 'object-select-symbolic',
                tooltip_text: 'Current style',
            });
            row.add_suffix(check);
            // A dedicated Gio.Settings: applyPreset() leaves it in delay mode.
            row.connect('activated', () => applyPreset(this.getSettings(), preset.id));
            group.add(row);
            return {preset, check};
        });

        const custom = new Adw.ActionRow({
            title: 'Custom',
            subtitle: 'Your own settings, not matching any preset',
            sensitive: false,
        });
        custom.add_suffix(new Gtk.Image({icon_name: 'object-select-symbolic'}));
        group.add(custom);

        this._refreshers.push(() => {
            const active = findMatchingPreset(settings);
            for (const {preset, check} of rows)
                check.visible = preset === active;
            custom.visible = active === null;
        });
        return group;
    }

    // --- live preview -------------------------------------------------------

    _makePreview(settings) {
        const group = new Adw.PreferencesGroup({title: 'Preview'});

        // A colourful backdrop so translucency actually reads.
        const stage = new Gtk.Box({
            css_classes: ['aqua-preview-stage'],
            hexpand: true,
            vexpand: true,
        });

        // Keep the stage a sensible size even when icons get large.
        const scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            min_content_height: 150,
            max_content_height: 240,
            child: stage,
        });

        const dock = new Gtk.Box({
            css_classes: ['aqua-preview-dock'],
        });
        stage.append(dock);

        // Icons sit in their own row so panel mode can centre them.
        const row = new Gtk.Box({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            vexpand: true,
        });
        dock.append(row);

        const items = [];
        for (const name of PREVIEW_ICONS) {
            const item = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
            });
            const image = new Gtk.Image({icon_name: name});
            const dot = new Gtk.Box({css_classes: ['aqua-preview-dot']});

            item.append(image);
            item.append(dot);
            row.append(item);

            // Interactive hover zoom, mirroring the real dock.
            const motion = new Gtk.EventControllerMotion();
            motion.connect('enter', () => {
                if (settings.get_boolean('hover-zoom'))
                    image.set_pixel_size(Math.round(settings.get_int('icon-size') * 1.35));
            });
            motion.connect('leave', () => {
                image.set_pixel_size(settings.get_int('icon-size'));
            });
            item.add_controller(motion);

            items.push({image, dot});
        }

        const wrap = new Gtk.Box();
        wrap.append(scroller);
        group.add(wrap);

        this._refreshers.push(() => this._refreshPreview(settings, dock, row, items));
        return group;
    }

    _refreshPreview(settings, dock, row, items) {
        const position = settings.get_string('position');
        const panelMode = settings.get_boolean('panel-mode');
        const iconSize = settings.get_int('icon-size');
        const spacing = settings.get_int('item-spacing');
        const showDots = settings.get_boolean('show-running-indicators');

        const vertical = position !== 'bottom';
        row.orientation = vertical
            ? Gtk.Orientation.VERTICAL
            : Gtk.Orientation.HORIZONTAL;
        row.spacing = spacing;

        // Anchor the dock inside the stage the way it sits on screen; in
        // panel mode it stretches along its edge.
        const along = panelMode ? Gtk.Align.FILL : Gtk.Align.CENTER;
        dock.hexpand = panelMode && !vertical;
        dock.vexpand = panelMode && vertical;
        if (position === 'bottom') {
            dock.halign = along;
            dock.valign = Gtk.Align.END;
        } else if (position === 'left') {
            dock.halign = Gtk.Align.START;
            dock.valign = along;
        } else {
            dock.halign = Gtk.Align.END;
            dock.valign = along;
        }

        // Only the first three icons are "running" in the mock.
        items.forEach(({image, dot}, i) => {
            image.set_pixel_size(iconSize);
            dot.visible = showDots && i < 3;
        });

        this._refreshCss(settings);
    }

    _refreshCss(settings) {
        const alpha = settings.get_int('dock-opacity') / 100;
        const radius = settings.get_int('corner-radius');
        const padding = settings.get_int('dock-padding');
        const dark = settings.get_boolean('dark-background');
        const rgb = dark ? '30, 30, 32' : '245, 245, 247';
        const border = dark ? '255, 255, 255' : '0, 0, 0';
        const dotColour = dark ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.7)';
        const borderAlpha = Math.min(0.12, alpha * 0.2).toFixed(3);
        const shadowAlpha = (0.45 * alpha).toFixed(3);

        this._css.load_from_data(`
            .aqua-preview-stage {
                background-image: linear-gradient(135deg, #3a6ea5, #b06ab3);
                border-radius: 12px;
                padding: 20px;
            }
            .aqua-preview-dock {
                background-color: rgba(${rgb}, ${alpha});
                border: 1px solid rgba(${border}, ${borderAlpha});
                border-radius: ${radius}px;
                padding: ${padding}px;
                box-shadow: 0 6px 24px 2px rgba(0, 0, 0, ${shadowAlpha});
            }
            .aqua-preview-dot {
                background-color: ${dotColour};
                border-radius: 3px;
                min-width: 5px;
                min-height: 5px;
                margin-top: 3px;
            }
        `, -1);
    }

    _refreshAll() {
        for (const refresh of this._refreshers)
            refresh();
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
