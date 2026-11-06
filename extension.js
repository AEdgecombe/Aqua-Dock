import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
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
        this._menu = null;
        this._menuManager = null;
        this._itemApps = new Map();
        this._favoriteIds = new Set();
        this._dragMonitor = null;
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
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        if (this._menu) {
            this._menu.destroy();
            this._menu = null;
        }
        this._menuManager = null;
        this._itemApps.clear();
        this._favoriteIds.clear();
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
        this._dock.connect('button-press-event', (a, event) => this._onButtonPress(event));

        this._buildMenu();
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

    // --- context menu -------------------------------------------------------

    _buildMenu() {
        const position = this._settings.get_string('position');
        const side = position === 'left' ? St.Side.LEFT
            : position === 'right' ? St.Side.RIGHT
            : St.Side.BOTTOM;

        this._menu = new PopupMenu.PopupMenu(this._dock, 0.5, side);
        this._menu.actor.add_style_class_name('aqua-dock-menu');
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.close();

        this._menuManager = new PopupMenu.PopupMenuManager(this._dock);
        this._menuManager.addMenu(this._menu);

        // Re-run the auto-hide check once the menu closes.
        this._menu.connect('open-state-changed', (menu, open) => {
            if (!open && this._dock)
                this._onHoverChanged();
        });

        this._populateMenu();
    }

    _onButtonPress(event) {
        if (event.get_button() === 3) { // right-click
            let source = event.get_source();
            while (source && source !== this._dock) {
                if (this._itemApps.has(source))
                    return Clutter.EVENT_PROPAGATE;
                source = source.get_parent();
            }
            this._populateMenu();
            this._toggleMenu();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _populateMenu(app = null) {
        this._menu.removeAll();

        if (app) {
            const favorites = AppFavorites.getAppFavorites();
            const isFavorite = favorites.getFavorites().some(favorite =>
                favorite.get_id() === app.get_id());

            const newWindowItem = new PopupMenu.PopupMenuItem('New Window');
            newWindowItem.connect('activate', () => {
                try {
                    app.open_new_window(-1);
                } catch (e) {
                    logError(e, 'Aqua Dock: failed to open new window');
                }
            });
            this._menu.addMenuItem(newWindowItem);

            const appInfo = app.get_app_info();
            if (appInfo) {
                for (const action of appInfo.list_actions()) {
                    const label = appInfo.get_action_name(action) || '';
                    if (!/private|incognito/i.test(`${action} ${label}`))
                        continue;

                    const privateWindowItem = new PopupMenu.PopupMenuItem(label || 'Open Private Window');
                    privateWindowItem.connect('activate', () => {
                        // Shell.App.launch_action needs (name, timestamp, workspace);
                        // omitting the workspace throws and nothing launches.
                        try {
                            app.launch_action(action, global.get_current_time(), -1);
                        } catch (e) {
                            logError(e, `Aqua Dock: failed to launch action "${action}"`);
                        }
                    });
                    this._menu.addMenuItem(privateWindowItem);
                }
            }

            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const favoriteItem = new PopupMenu.PopupMenuItem(
                isFavorite ? 'Remove from Dock' : 'Pin to Dock');
            favoriteItem.connect('activate', () => {
                if (isFavorite)
                    favorites.removeFavorite(app.get_id());
                else
                    favorites.addFavorite(app.get_id());
            });
            this._menu.addMenuItem(favoriteItem);
            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        const settingsItem = new PopupMenu.PopupMenuItem('Aqua Dock Settings…');
        settingsItem.connect('activate', () => this.openPreferences());
        this._menu.addMenuItem(settingsItem);

        const hideItem = new PopupMenu.PopupSwitchMenuItem('Auto-hide',
            this._settings.get_boolean('autohide'));
        hideItem.connect('toggled', (item, state) => {
            this._settings.set_boolean('autohide', state);
        });
        this._menu.addMenuItem(hideItem);
    }

    _toggleMenu() {
        if (this._menu)
            this._menu.toggle();
    }

    // --- content ------------------------------------------------------------

    _population() {
        // Favorites first (in order), then running apps that aren't pinned.
        const apps = [];
        const seen = new Set();

        const favorites = AppFavorites.getAppFavorites().getFavorites();
        this._favoriteIds = new Set(favorites.filter(app => app).map(app => app.get_id()));

        for (const app of favorites) {
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
            this._itemApps.set(item, app);
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

        item.connect('button-press-event', (a, event) => {
            item._pressedButton = event.get_button();
            if (item._pressedButton === 3) {
                this._populateMenu(app);
                this._menu.open();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        item.connect('clicked', () => {
            if (item._pressedButton !== undefined && item._pressedButton !== null &&
                item._pressedButton !== 1) {
                item._pressedButton = null;
                return;
            }
            item._pressedButton = null;
            if (item._dragMoved) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    item._dragMoved = false;
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            this._hideTooltip();
            this._activate(app);
        });

        item.connect('destroy', () => this._hideTooltip());

        if (this._favoriteIds.has(app.get_id())) {
            const draggable = DND.makeDraggable(item);
            draggable.connect('drag-begin', () => {
                item._dragMoved = false;
                this._dragMonitor = {
                    dragMotion: event => {
                        this._onItemDragMotion(item, event.x, event.y);
                        return DND.DragMotionResult.CONTINUE;
                    },
                };
                DND.addDragMonitor(this._dragMonitor);
            });
            draggable.connect('drag-end', () => {
                if (this._dragMonitor) {
                    DND.removeDragMonitor(this._dragMonitor);
                    this._dragMonitor = null;
                }
                this._onItemDragEnd(item);
            });
        }

        return item;
    }

    _onItemDragMotion(item, pointerX, pointerY) {
        if (!this._dock || !this._favoriteIds.has(this._itemApps.get(item)?.get_id()))
            return;

        const horizontal = this._settings.get_string('position') === 'bottom';
        const pointer = horizontal ? pointerX : pointerY;
        const favoriteItems = this._dock.get_children().filter(child =>
            this._favoriteIds.has(this._itemApps.get(child)?.get_id()));
        const targetIndex = favoriteItems
            .filter(child => child !== item)
            .filter(child => {
                const [x, y] = child.get_transformed_position();
                const [width, height] = child.get_transformed_size();
                const center = horizontal ? x + width / 2 : y + height / 2;
                return center < pointer;
            }).length;
        const currentIndex = favoriteItems.indexOf(item);
        const newIndex = targetIndex;

        if (newIndex === currentIndex)
            return;

        this._dock.remove_child(item);
        this._dock.insert_child_at_index(item, newIndex);
        item._dragMoved = true;
    }

    _onItemDragEnd(item) {
        if (!item._dragMoved)
            return;

        const app = this._itemApps.get(item);
        const index = this._dock.get_children()
            .filter(child => this._favoriteIds.has(this._itemApps.get(child)?.get_id()))
            .indexOf(item);
        if (app && index >= 0)
            AppFavorites.getAppFavorites().moveFavoriteToPos(app.get_id(), index);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            item._dragMoved = false;
            return GLib.SOURCE_REMOVE;
        });
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
                // Don't slide the dock away while its context menu is open.
                if (this._menu && this._menu.isOpen)
                    return GLib.SOURCE_REMOVE;
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