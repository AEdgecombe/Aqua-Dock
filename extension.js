import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Layout from './lib/layout.js';

const HIDE_DELAY = 350;      // ms before an unhovered dock slides away
const REVEAL_MS = 200;       // slide-in duration
const HIDE_MS = 250;         // slide-out duration
const ZOOM_MS = 140;         // hover magnify duration
const ZOOM_SCALE = 1.35;
const EDGE_THICKNESS = 3;    // px strip that reveals a hidden dock
const DRAG_PLACEHOLDER_OPACITY = 90;

// Settings that change the dock's chrome (struts, orientation, menu side,
// reveal strip). Any other key only needs the icons and style refreshed.
const STRUCTURAL_KEYS = new Set(['position', 'autohide']);

const POSITION_LABELS = {bottom: 'Bottom', left: 'Left', right: 'Right'};

// NO_DOT (keeps unselected choices aligned) only exists from GNOME 46.
const UNSELECTED = PopupMenu.Ornament.NO_DOT ?? PopupMenu.Ornament.NONE;

function menuSide(position) {
    if (position === 'left')
        return St.Side.LEFT;
    if (position === 'right')
        return St.Side.RIGHT;
    return St.Side.BOTTOM;
}

/**
 * GNOME's own app menu (open windows, New Window, desktop actions, GPU
 * launch, App Details, Quit) plus dock-specific items: pinning wording,
 * moving a pinned app, and the dock options.
 */
class DockAppMenu extends AppMenu {
    constructor(sourceActor, dock) {
        super(sourceActor, menuSide(dock.position), {
            favoritesSection: true,
            showSingleWindows: true,
        });
        this._dock = dock;
        this.actor.add_style_class_name('aqua-dock-menu');

        // "Move Left/Right" sits directly under Pin/Unpin.
        this._moveSection = new PopupMenu.PopupMenuSection();
        const pinIndex = this._getMenuItems().indexOf(this._toggleFavoriteItem);
        this.addMenuItem(this._moveSection, pinIndex + 1);

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._dockItem = new PopupMenu.PopupSubMenuMenuItem('Dock');
        this.addMenuItem(this._dockItem);
    }

    _updateFavoriteItem() {
        super._updateFavoriteItem();
        if (this._app && this._toggleFavoriteItem.visible) {
            this._toggleFavoriteItem.label.text =
                this._appFavorites.isFavorite(this._app.get_id())
                    ? 'Unpin from Dock'
                    : 'Pin to Dock';
        }
    }

    /** Refresh the items whose state can change between openings. */
    prepare() {
        this._moveSection.removeAll();
        if (this._app && this._appFavorites.isFavorite(this._app.get_id())) {
            const id = this._app.get_id();
            const ids = this._appFavorites.getFavorites().map(app => app.get_id());
            const labels = Layout.moveLabels(this._dock.position);
            for (const [label, delta] of [[labels.back, -1], [labels.forward, 1]]) {
                const target = Layout.shiftedIndex(ids, id, delta);
                if (target >= 0) {
                    this._moveSection.addAction(label,
                        () => this._appFavorites.moveFavoriteToPos(id, target));
                }
            }
        }

        this._dockItem.menu.removeAll();
        this._dock.fillDockOptions(this._dockItem.menu, false);
    }
}

export default class AquaDockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._dock = null;          // St.Bin: the visible panel
        this._box = null;           // St.BoxLayout of app items inside it
        this._edge = null;
        this._tooltip = null;
        this._dockMenu = null;
        this._menuManager = null;
        this._openMenus = new Set();
        this._itemApps = new Map();
        this._favoriteIds = new Set();
        this._dragMonitor = null;
        this._dragging = false;
        this._hidden = false;
        this._hideTimeout = 0;
        this._updateId = 0;
        this._pendingFull = false;
        this._pendingItems = false;

        this._settings.connectObject('changed',
            (_s, key) => this._queueUpdate(STRUCTURAL_KEYS.has(key)), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._queueUpdate(true), this);
        AppFavorites.getAppFavorites().connectObject('changed',
            () => this._queueUpdate(false), this);
        Shell.AppSystem.get_default().connectObject('app-state-changed',
            () => this._queueUpdate(false), this);

        this._buildDock(false);
    }

    disable() {
        if (this._updateId) {
            GLib.source_remove(this._updateId);
            this._updateId = 0;
        }
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);

        this._destroyDock();
        this._settings = null;
    }

    get position() {
        return this._settings.get_string('position');
    }

    // --- update plumbing ----------------------------------------------------

    /**
     * Coalesce changes into one idle update. `full` rebuilds the chrome;
     * otherwise only the icons and style are refreshed.
     */
    _queueUpdate(full) {
        this._pendingFull ||= full;
        this._pendingItems = true;
        if (this._updateId)
            return;
        this._updateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._updateId = 0;
            this._flushUpdates();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushUpdates() {
        // Never pull the dock, or the icon a menu points at, out from under
        // an open menu or an in-flight drag. _afterInteraction() comes back
        // here once they finish.
        if (this._openMenus.size > 0 || this._dragging)
            return;
        if (!this._pendingFull && !this._pendingItems)
            return;

        const full = this._pendingFull;
        this._pendingFull = false;
        this._pendingItems = false;

        if (full || !this._dock) {
            this._buildDock(true);
        } else {
            this._applyStyle();
            this._refreshItems();
            this._updatePosition();
        }
    }

    /** Called when a menu closes or a drag ends. */
    _afterInteraction() {
        if (!this._dock)
            return;
        if (this._pendingFull || this._pendingItems)
            this._queueUpdate(false);
        this._onHoverChanged();
    }

    // --- build / teardown ---------------------------------------------------

    _destroyDock() {
        this._clearHideTimeout();
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._dragging = false;

        // Null the dock first so signal handlers fired during teardown
        // (menus closing, hover changing) become no-ops.
        const dock = this._dock;
        this._dock = null;
        this._box = null;
        this._openMenus.clear();

        if (this._dockMenu) {
            this._dockMenu.destroy();
            this._dockMenu = null;
        }
        this._menuManager = null;
        this._itemApps.clear();
        this._favoriteIds.clear();

        if (dock) {
            Main.layoutManager.removeChrome(dock);
            dock.destroy(); // also destroys each item's menu
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

    /**
     * @param {boolean} preserveReveal - keep an auto-hiding dock on screen
     *   if it was showing (or the pointer is over it) before the rebuild.
     */
    _buildDock(preserveReveal) {
        const wasRevealed = preserveReveal && this._dock !== null && !this._hidden;
        this._destroyDock();

        const autohide = this._settings.get_boolean('autohide');
        const horizontal = Layout.isHorizontal(this.position);

        this._dock = new St.Bin({
            style_class: 'aqua-dock',
            reactive: true,
            track_hover: true,
        });
        this._box = new St.BoxLayout({
            vertical: !horizontal,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dock.set_child(this._box);
        this._hidden = false;
        this._applyStyle();

        this._dock.connect('notify::hover', () => this._onHoverChanged());
        this._dock.connect('notify::width', () => this._updatePosition());
        this._dock.connect('notify::height', () => this._updatePosition());
        this._dock.connect('button-press-event', (_a, event) => this._onDockButtonPress(event));

        this._menuManager = new PopupMenu.PopupMenuManager(this._dock);

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

        this._refreshItems();
        this._updatePosition();

        if (autohide)
            this._setupAutohide(wasRevealed || this._pointerOverDock());
    }

    // --- menus --------------------------------------------------------------

    _trackMenu(menu) {
        Main.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        menu.connect('open-state-changed', (m, open) => {
            if (!this._dock)
                return;
            if (open) {
                this._openMenus.add(m);
                this._clearHideTimeout();
                this._hideTooltip();
                this._reveal();
            } else {
                this._openMenus.delete(m);
                this._afterInteraction();
            }
        });
    }

    _onDockButtonPress(event) {
        // Clicks on app items are handled (and stopped) by the items, so
        // anything reaching here landed on the dock's empty area.
        if (event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        this._openDockMenu(x, y);
        return Clutter.EVENT_STOP;
    }

    _openDockMenu(x, y) {
        if (!this._dockMenu) {
            // Anchor at the click point via the shell's dummy cursor, so the
            // menu appears where the user clicked rather than mid-dock.
            this._dockMenu = new PopupMenu.PopupMenu(
                Main.layoutManager.dummyCursor, 0.5, menuSide(this.position));
            this._dockMenu.actor.add_style_class_name('aqua-dock-menu');
            this._trackMenu(this._dockMenu);
        }
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        this._dockMenu.removeAll();
        this.fillDockOptions(this._dockMenu, true);
        this._dockMenu.open(BoxPointer.PopupAnimation.FULL);
    }

    _openAppMenu(item, app) {
        if (!item._menu) {
            item._menu = new DockAppMenu(item, this);
            item._menu.setApp(app);
            this._trackMenu(item._menu);
        }
        item._menu.prepare();
        item._menu.open(BoxPointer.PopupAnimation.FULL);
    }

    /**
     * Dock-wide options, shared by the empty-area menu and the "Dock"
     * submenu of each app menu.
     *
     * @param {PopupMenu.PopupMenuBase} menu - menu or submenu to fill
     * @param {boolean} nested - group choices in submenus (only allowed at
     *   the top level; otherwise they are listed under headings)
     */
    fillDockOptions(menu, nested) {
        const s = this._settings;

        const addSwitch = (label, key) => {
            const item = new PopupMenu.PopupSwitchMenuItem(label, s.get_boolean(key));
            item.connect('toggled', (_i, state) => s.set_boolean(key, state));
            menu.addMenuItem(item);
        };
        addSwitch('Auto-hide', 'autohide');
        addSwitch('Magnification', 'hover-zoom');

        const group = title => {
            if (nested) {
                const sub = new PopupMenu.PopupSubMenuMenuItem(title);
                menu.addMenuItem(sub);
                return sub.menu;
            }
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(title));
            return menu;
        };
        const addChoice = (target, label, selected, onActivate) => {
            const item = new PopupMenu.PopupMenuItem(label);
            item.setOrnament(selected ? PopupMenu.Ornament.DOT : UNSELECTED);
            if (onActivate)
                item.connect('activate', onActivate);
            else
                item.setSensitive(false);
            target.addMenuItem(item);
        };

        const positions = group('Position on Screen');
        const current = this.position;
        for (const pos of Layout.POSITIONS) {
            addChoice(positions, POSITION_LABELS[pos], pos === current,
                () => s.set_string('position', pos));
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefs = new PopupMenu.PopupMenuItem('Dock Settings…');
        prefs.connect('activate', () => this.openPreferences());
        menu.addMenuItem(prefs);
    }

    // --- content ------------------------------------------------------------

    _population() {
        // Favorites first (in order), then running apps that aren't pinned.
        const apps = [];
        const seen = new Set();

        const favorites = AppFavorites.getAppFavorites().getFavorites().filter(app => app);
        this._favoriteIds = new Set(favorites.map(app => app.get_id()));

        for (const app of [...favorites, ...Shell.AppSystem.get_default().get_running()]) {
            if (app && !seen.has(app.get_id())) {
                seen.add(app.get_id());
                apps.push(app);
            }
        }
        return apps;
    }

    _refreshItems() {
        if (!this._box)
            return;
        this._hideTooltip();
        this._box.destroy_all_children();
        this._itemApps.clear();

        const s = this._settings;
        const opts = {
            iconSize: s.get_int('icon-size'),
            showIndicators: s.get_boolean('show-running-indicators'),
            hoverZoom: s.get_boolean('hover-zoom'),
        };
        const half = s.get_int('item-spacing') / 2;
        const margin = Layout.isHorizontal(this.position) ? `0 ${half}px` : `${half}px 0`;

        for (const app of this._population()) {
            const item = this._createItem(app, opts);
            item.set_style(`margin: ${margin};`);
            this._box.add_child(item);
            this._itemApps.set(item, app);
        }
    }

    _createItem(app, {iconSize, showIndicators, hoverZoom}) {
        const item = new St.Button({
            style_class: 'aqua-dock-item',
            can_focus: true,
            reactive: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
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
        const position = this.position;
        if (position === 'bottom')
            item.set_pivot_point(0.5, 1.0);
        else if (position === 'left')
            item.set_pivot_point(0.0, 0.5);
        else
            item.set_pivot_point(1.0, 0.5);

        item.connect('notify::hover', () => {
            const hovered = item.hover && !this._dragging;
            if (hoverZoom) {
                item.ease({
                    scale_x: hovered ? ZOOM_SCALE : 1.0,
                    scale_y: hovered ? ZOOM_SCALE : 1.0,
                    duration: ZOOM_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            if (hovered && this._openMenus.size === 0)
                this._showTooltip(item, app.get_name());
            else
                this._hideTooltip();
        });

        item.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this._openAppMenu(item, app);
            return Clutter.EVENT_STOP;
        });
        // Menu key / Shift+F10 on a focused icon.
        item.connect('popup-menu', () => this._openAppMenu(item, app));

        item.connect('clicked', (_button, clickedButton) => {
            if (item._suppressClick)
                return;
            this._hideTooltip();
            if (clickedButton === Clutter.BUTTON_MIDDLE && app.can_open_new_window())
                app.open_new_window(-1);
            else
                this._activate(app);
        });

        item.connect('destroy', () => {
            item._menu?.destroy();
            item._menu = null;
            this._hideTooltip();
        });

        if (this._favoriteIds.has(app.get_id()))
            this._makeReorderable(item, icon, app, iconSize);

        return item;
    }

    /**
     * Drag a pinned icon along the dock to reorder it. A copy of the icon
     * follows the pointer while the real item slides between its
     * neighbours, so the item never leaves the dock.
     */
    _makeReorderable(item, icon, app, iconSize) {
        item._delegate = {
            getDragActor: () => app.create_icon_texture(iconSize),
            getDragActorSource: () => icon,
        };

        const draggable = DND.makeDraggable(item);
        let startIndex = -1;

        draggable.connect('drag-begin', () => {
            this._dragging = true;
            item._suppressClick = true;
            startIndex = this._box.get_children().indexOf(item);
            item.opacity = DRAG_PLACEHOLDER_OPACITY;
            this._hideTooltip();
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
            this._dragging = false;
            item.opacity = 255;

            // The release that ends a drag must not also launch the app.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                item._suppressClick = false;
                return GLib.SOURCE_REMOVE;
            });

            const index = this._box?.get_children().indexOf(item) ?? -1;
            if (index >= 0 && index !== startIndex)
                AppFavorites.getAppFavorites().moveFavoriteToPos(app.get_id(), index);

            this._afterInteraction();
        });
    }

    _onItemDragMotion(item, pointerX, pointerY) {
        if (!this._box || item.get_parent() !== this._box)
            return;

        // Pinned apps come first in the box, so their child index is also
        // their index in the favourites list.
        const horizontal = Layout.isHorizontal(this.position);
        const pinned = this._box.get_children().filter(child =>
            this._favoriteIds.has(this._itemApps.get(child)?.get_id()));
        const centres = pinned.filter(child => child !== item).map(child => {
            const [x, y] = child.get_transformed_position();
            const [width, height] = child.get_transformed_size();
            return horizontal ? x + width / 2 : y + height / 2;
        });
        const target = Layout.dropIndex(centres, horizontal ? pointerX : pointerY);

        if (target !== pinned.indexOf(item))
            this._box.set_child_at_index(item, target);
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

        let x, y;
        if (this.position === 'bottom') {
            x = ix + (iw - tw) / 2;
            y = iy - th - 8;
        } else if (this.position === 'left') {
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
            onComplete: () => this._tooltip?.hide(),
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

        if (dark)
            this._dock.remove_style_class_name('aqua-dock-light');
        else
            this._dock.add_style_class_name('aqua-dock-light');

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

        const rect = Layout.dockRect({
            position: this.position,
            margin: this._settings.get_int('edge-margin'),
            monitor,
            width: this._dock.width,
            height: this._dock.height,
        });
        this._dock.set_position(rect.x, rect.y);

        // Keep a hidden dock parked off-screen after any size change.
        if (this._hidden)
            this._applyHiddenOffset();
    }

    /** True when the pointer is inside the dock's on-screen (revealed) area. */
    _pointerOverDock() {
        if (!this._dock)
            return false;
        const [px, py] = global.get_pointer();
        return Layout.containsPoint({
            x: this._dock.x,
            y: this._dock.y,
            width: this._dock.width,
            height: this._dock.height,
        }, px, py);
    }

    // --- auto-hide ----------------------------------------------------------

    _setupAutohide(startRevealed) {
        const monitor = Main.layoutManager.primaryMonitor;
        const strip = Layout.edgeStrip(this.position, monitor, EDGE_THICKNESS);

        this._edge = new St.Widget({reactive: true, track_hover: true});
        this._edge.set_position(strip.x, strip.y);
        this._edge.set_size(strip.width, strip.height);
        this._edge.connect('notify::hover', () => {
            if (this._edge?.hover)
                this._reveal();
        });
        Main.layoutManager.addChrome(this._edge, {
            affectsStruts: false,
            affectsInputRegion: true,
            trackFullscreen: true,
        });

        if (startRevealed) {
            // Rebuilt while in use: stay put, then hide normally once the
            // pointer leaves.
            this._hidden = false;
            this._onHoverChanged();
        } else {
            this._hidden = true;
            this._applyHiddenOffset();
        }
    }

    _applyHiddenOffset() {
        const off = Layout.hiddenOffset(this.position, this._dock.width,
            this._dock.height, this._settings.get_int('edge-margin'));
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
        this._hideTooltip();
        const off = Layout.hiddenOffset(this.position, this._dock.width,
            this._dock.height, this._settings.get_int('edge-margin'));
        this._dock.ease({
            translation_x: off.x,
            translation_y: off.y,
            duration: HIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    /** Anything that must keep an auto-hiding dock on screen. */
    _inUse() {
        return this._openMenus.size > 0 ||
            this._dragging ||
            this._dock.hover ||
            Boolean(this._edge?.hover) ||
            this._pointerOverDock();
    }

    _onHoverChanged() {
        if (!this._dock || !this._settings.get_boolean('autohide'))
            return;

        this._clearHideTimeout();
        if (this._inUse()) {
            this._reveal();
            return;
        }
        this._hideTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
            this._hideTimeout = 0;
            if (this._dock && !this._inUse())
                this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearHideTimeout() {
        if (this._hideTimeout) {
            GLib.source_remove(this._hideTimeout);
            this._hideTimeout = 0;
        }
    }
}
