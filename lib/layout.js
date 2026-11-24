// Pure layout helpers for the dock. No gi:// imports, so they can be unit
// tested with Node as well as used inside GNOME Shell.

export const POSITIONS = ['bottom', 'left', 'right'];

// Extra distance a hidden dock is pushed past the screen edge, so its
// shadow does not peek in.
const HIDDEN_OVERSHOOT = 12;

/**
 * @param {string} position - 'bottom' | 'left' | 'right'
 * @returns {boolean} true when the dock lays its icons out in a row.
 */
export function isHorizontal(position) {
    return position === 'bottom';
}

/**
 * Where the dock should sit on a monitor: centred along its edge.
 *
 * @param {object} p
 * @param {string} p.position
 * @param {number} p.margin - gap from the screen edge
 * @param {{x: number, y: number, width: number, height: number}} p.monitor
 * @param {number} p.width - the dock's natural width
 * @param {number} p.height - the dock's natural height
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function dockRect({position, margin, monitor, width, height}) {
    if (isHorizontal(position)) {
        return {
            x: monitor.x + Math.round((monitor.width - width) / 2),
            y: monitor.y + monitor.height - height - margin,
            width,
            height,
        };
    }

    const y = monitor.y + Math.round((monitor.height - height) / 2);
    const x = position === 'left'
        ? monitor.x + margin
        : monitor.x + monitor.width - width - margin;
    return {x, y, width, height};
}

/**
 * Translation that moves a dock fully off its screen edge.
 *
 * @param {string} position
 * @param {number} width
 * @param {number} height
 * @param {number} margin
 * @returns {{x: number, y: number}}
 */
export function hiddenOffset(position, width, height, margin) {
    if (position === 'bottom')
        return {x: 0, y: height + margin + HIDDEN_OVERSHOOT};
    if (position === 'left')
        return {x: -(width + margin + HIDDEN_OVERSHOOT), y: 0};
    return {x: width + margin + HIDDEN_OVERSHOOT, y: 0};
}

/**
 * The thin strip along the screen edge that reveals a hidden dock.
 *
 * @param {string} position
 * @param {{x: number, y: number, width: number, height: number}} monitor
 * @param {number} thickness
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function edgeStrip(position, monitor, thickness) {
    if (position === 'bottom') {
        return {
            x: monitor.x,
            y: monitor.y + monitor.height - thickness,
            width: monitor.width,
            height: thickness,
        };
    }
    if (position === 'left')
        return {x: monitor.x, y: monitor.y, width: thickness, height: monitor.height};
    return {
        x: monitor.x + monitor.width - thickness,
        y: monitor.y,
        width: thickness,
        height: monitor.height,
    };
}

/**
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @param {number} px
 * @param {number} py
 * @returns {boolean}
 */
export function containsPoint(rect, px, py) {
    return px >= rect.x && px < rect.x + rect.width &&
        py >= rect.y && py < rect.y + rect.height;
}

/**
 * Index a dragged item should take, given the centres of the other items
 * (along the dock axis) and the pointer coordinate on that axis.
 *
 * @param {number[]} otherCentres
 * @param {number} pointer
 * @returns {number}
 */
export function dropIndex(otherCentres, pointer) {
    return otherCentres.filter(centre => centre < pointer).length;
}

/**
 * Target index for "move left/right" on a pinned app, or -1 when the app
 * is already at that end of the list (or is not pinned at all).
 *
 * @param {string[]} ids - favourite app ids in dock order
 * @param {string} id
 * @param {number} delta - -1 or +1
 * @returns {number}
 */
export function shiftedIndex(ids, id, delta) {
    const index = ids.indexOf(id);
    if (index < 0)
        return -1;
    const target = index + delta;
    return target >= 0 && target < ids.length ? target : -1;
}

/**
 * Menu wording for moving an app, which depends on the dock's orientation.
 *
 * @param {string} position
 * @returns {{back: string, forward: string}}
 */
export function moveLabels(position) {
    return isHorizontal(position)
        ? {back: 'Move Left', forward: 'Move Right'}
        : {back: 'Move Up', forward: 'Move Down'};
}
