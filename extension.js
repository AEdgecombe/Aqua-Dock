import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const HIDE_DELAY = 350;      // ms before an unhovered dock slides away
const REVEAL_MS = 200;       // slide-in duration
const HIDE_MS = 250;         // slide-out duration
const ZOOM_MS = 140;         // hover magnify duration
const ZOOM_SCALE = 1.35;

export default class AquaDockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // External signals we own and must disconnect on disable().
        this._settingsChangedId = this._settings.connect('changed', () => this._queueRebuild());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._updatePosition());
        this._favoritesId = AppFavorites.getAppFavorites().connect('changed', () => this._queueRebuild());
        this._appStateId = Shell.AppSystem.get_default().connect('app-state-changed', () => this._queueRebuild());

        this._dock = null;
        this._edge = null;
        this._tooltip = null;
        this._hidden = false;
        this._hideTimeout = 0;
        this._rebuildId = 0;

        this._buildDock();
    }

    disable() {
        this._clearHideTimeout();

        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._favoritesId) {
            AppFavorites.getAppFavorites().disconnect(this._favoritesId);
            this._favoritesId = 0;
        }
        if (this._appStateId) {
            Shell.AppSystem.get_default().disconnect(this._appStateId);
            this._appStateId = 0;
        }

        this._destroyDock();
        this._settings = null;
    }

    // --- rebuild plumbing ---------------------------------------------------

    _queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            this._buildDock();
            return GLib.SOURCE_REMOVE;
        });
    }

    _destroyDock() {
        this._clearHideTimeout();
        if (this._dock) {
            Main.layoutManager.removeChrome(this._dock);
            this._dock.destroy();
            this._dock = null;
        }
        if (this._edge) {
            Main.layoutManager.removeChrome(this._edge);
            this._edge.destroy();
            this._edge = null;
        }
        if (this._tooltip) {
            Main.layoutManager.removeChrome(this._tooltip);
            this._tooltip.destroy();
            this._tooltip = null;
        }
    }

    _buildDock() {
        this._destroyDock();

        const s = this._settings;
        const position = s.get_string('position');
        const autohide = s.get_boolean('autohide');
        const vertical = position !== 'bottom';

        this._dock = new St.BoxLayout({
            style_class: 'aqua-dock',
            vertical,
            reactive: true,
            track_hover: true,
        });
        this._applyStyle();

        this._dock.connect('notify::hover', () => this._onHoverChanged());
        this._dock.connect('notify::width', () => this._updatePosition());
        this._dock.connect('notify::height', () => this._updatePosition());

        this._populate();

        Main.layoutManager.addChrome(this._dock, {
            affectsStruts: !autohide,
            affectsInputRegion: true,
            trackFullscreen: true,
        });

        // Shared tooltip actor.
        this._tooltip = new St.Label({
            style_class: 'aqua-dock-tooltip',
            opacity: 0,
        });
        this._tooltip.hide();
        Main.layoutManager.addChrome(this._tooltip, {
            affectsStruts: false,
            affectsInputRegion: false,
        });

        if (autohide)
            this._setupAutohide();

        this._updatePosition();
    }

    // --- content ------------------------------------------------------------

    _population() {
        // Favorites first (in order), then running apps that aren't pinned.
        const apps = [];
        const seen = new Set();

        for (const app of AppFavorites.getAppFavorites().getFavorites()) {
            if (app && !seen.has(app.get_id())) {
                seen.add(app.get_id());
                apps.push(app);
            }
        }
        for (const app of Shell.AppSystem.get_default().get_running()) {
            if (app && !seen.has(app.get_id())) {
                seen.add(app.get_id());
                apps.push(app);
            }
        }
        return apps;
    }

    _populate() {
        const s = this._settings;
        const iconSize = s.get_int('icon-size');
        const spacing = s.get_int('item-spacing');
        const showIndicators = s.get_boolean('show-running-indicators');
        const hoverZoom = s.get_boolean('hover-zoom');
        const position = s.get_string('position');

        for (const app of this._population()) {
            const item = this._createItem(app, iconSize, showIndicators, hoverZoom, position);
            item.set_style(`margin: ${position === 'bottom' ? `0 ${spacing / 2}px` : `${spacing / 2}px 0`};`);
            this._dock.add_child(item);
        }
    }

    _createItem(app, iconSize, showIndicators, hoverZoom, position) {
        const item = new St.Button({
            style_class: 'aqua-dock-item',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });

        const box = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        const icon = app.create_icon_texture(iconSize);
        box.add_child(icon);

        const running = app.state === Shell.AppState.RUNNING && app.get_n_windows() > 0;
        const dot = new St.Widget({
            style_class: 'aqua-dock-indicator',
            x_align: Clutter.ActorAlign.CENTER,
            visible: showIndicators && running,
        });
        box.add_child(dot);

        item.set_child(box);

        // Zoom up from the edge the dock sits on.
        if (position === 'bottom')
            item.set_pivot_point(0.5, 1.0);
        else if (position === 'left')
            item.set_pivot_point(0.0, 0.5);
        else
            item.set_pivot_point(1.0, 0.5);

        item.connect('notify::hover', () => {
            const hovered = item.hover;
            if (hoverZoom) {
                item.ease({
                    scale_x: hovered ? ZOOM_SCALE : 1.0,
                    scale_y: hovered ? ZOOM_SCALE : 1.0,
                    duration: ZOOM_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            if (hovered)
                this._showTooltip(item, app.get_name());
            else
                this._hideTooltip();
        });

        item.connect('clicked', () => {
            this._hideTooltip();
            this._activate(app);
        });

        item.connect('destroy', () => this._hideTooltip());

        return item;
    }

    _activate(app) {
        const windows = app.get_windows();
        if (app.state === Shell.AppState.RUNNING && windows.length > 0) {
            const focused = global.display.focus_window;
            if (focused && windows.includes(focused) && windows.length > 1) {
                // Cycle to the next window of this app.
                const next = windows[(windows.indexOf(focused) + 1) % windows.length];
                Main.activateWindow(next);
            } else {
                Main.activateWindow(windows[0]);
            }
        } else {
            app.activate();
        }
    }

    // --- tooltip ------------------------------------------------------------

    _showTooltip(item, text) {
        if (!this._tooltip)
            return;
        this._tooltip.text = text;
        this._tooltip.show();
        this._tooltip.opacity = 0;

        const [ix, iy] = item.get_transformed_position();
        const iw = item.width;
        const ih = item.height;
        const tw = this._tooltip.width;
        const th = this._tooltip.height;
        const position = this._settings.get_string('position');

        let x, y;
        if (position === 'bottom') {
            x = ix + (iw - tw) / 2;
            y = iy - th - 8;
        } else if (position === 'left') {
            x = ix + iw + 8;
            y = iy + (ih - th) / 2;
        } else {
            x = ix - tw - 8;
            y = iy + (ih - th) / 2;
        }
        this._tooltip.set_position(Math.round(x), Math.round(y));
        this._tooltip.ease({opacity: 255, duration: 120});
    }

    _hideTooltip() {
        if (!this._tooltip)
            return;
        this._tooltip.ease({
            opacity: 0,
            duration: 100,
            onComplete: () => this._tooltip && this._tooltip.hide(),
        });
    }

    // --- styling & placement ------------------------------------------------

    _applyStyle() {
        if (!this._dock)
            return;
        const s = this._settings;
        const alpha = s.get_int('dock-opacity') / 100;
        const radius = s.get_int('corner-radius');
        const padding = s.get_int('dock-padding');
        const dark = s.get_boolean('dark-background');
        const rgb = dark ? '30, 30, 32' : '245, 245, 247';
        const border = dark ? '255, 255, 255' : '0, 0, 0';

        this._dock.set_style(
            `background-color: rgba(${rgb}, ${alpha});` +
            `border-radius: ${radius}px;` +
            `padding: ${padding}px;` +
            `border: 1px solid rgba(${border}, 0.12);`
        );
    }

    _updatePosition() {
        if (!this._dock)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const s = this._settings;
        const position = s.get_string('position');
        const margin = s.get_int('edge-margin');
        const w = this._dock.width;
        const h = this._dock.height;

        let x, y;
        if (position === 'bottom') {
            x = monitor.x + Math.round((monitor.width - w) / 2);
            y = monitor.y + monitor.height - h - margin;
        } else if (position === 'left') {
            x = monitor.x + margin;
            y = monitor.y + Math.round((monitor.height - h) / 2);
        } else { // right
            x = monitor.x + monitor.width - w - margin;
            y = monitor.y + Math.round((monitor.height - h) / 2);
        }
        this._dock.set_position(x, y);

        // Keep a hidden dock parked off-screen after any size change.
        if (this._hidden)
            this._applyHiddenOffset();
    }

    // --- auto-hide ----------------------------------------------------------

    _setupAutohide() {
        const monitor = Main.layoutManager.primaryMonitor;
        const position = this._settings.get_string('position');

        // A thin reactive strip along the screen edge that reveals the dock.
        let ex, ey, ew, eh;
        const thickness = 3;
        if (position === 'bottom') {
            ex = monitor.x; ey = monitor.y + monitor.height - thickness;
            ew = monitor.width; eh = thickness;
        } else if (position === 'left') {
            ex = monitor.x; ey = monitor.y;
            ew = thickness; eh = monitor.height;
        } else {
            ex = monitor.x + monitor.width - thickness; ey = monitor.y;
            ew = thickness; eh = monitor.height;
        }

        this._edge = new St.Widget({reactive: true, track_hover: true});
        this._edge.set_position(ex, ey);
        this._edge.set_size(ew, eh);
        this._edge.connect('notify::hover', () => {
            if (this._edge.hover)
                this._reveal();
        });
        Main.layoutManager.addChrome(this._edge, {
            affectsStruts: false,
            affectsInputRegion: true,
        });

        // Start hidden.
        this._hidden = true;
        this._applyHiddenOffset();
    }

    _hiddenOffset() {
        const position = this._settings.get_string('position');
        const margin = this._settings.get_int('edge-margin');
        if (position === 'bottom')
            return {x: 0, y: this._dock.height + margin + 12};
        if (position === 'left')
            return {x: -(this._dock.width + margin + 12), y: 0};
        return {x: this._dock.width + margin + 12, y: 0}; // right
    }

    _applyHiddenOffset() {
        const off = this._hiddenOffset();
        this._dock.translation_x = off.x;
        this._dock.translation_y = off.y;
    }

    _reveal() {
        if (!this._dock || !this._hidden)
            return;
        this._clearHideTimeout();
        this._hidden = false;
        this._dock.ease({
            translation_x: 0,
            translation_y: 0,
            duration: REVEAL_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hide() {
        if (!this._dock || this._hidden)
            return;
        this._hidden = true;
        const off = this._hiddenOffset();
        this._dock.ease({
            translation_x: off.x,
            translation_y: off.y,
            duration: HIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    _onHoverChanged() {
        if (!this._settings.get_boolean('autohide'))
            return;
        if (this._dock.hover) {
            this._reveal();
        } else {
            this._clearHideTimeout();
            this._hideTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
                this._hideTimeout = 0;
                if (this._dock && !this._dock.hover && !(this._edge && this._edge.hover))
                    this._hide();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _clearHideTimeout() {
        if (this._hideTimeout) {
            GLib.source_remove(this._hideTimeout);
            this._hideTimeout = 0;
        }
    }
}
