import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    containsPoint,
    dockRect,
    dropIndex,
    edgeStrip,
    hiddenOffset,
    isHorizontal,
    moveLabels,
    shiftedIndex,
} from '../lib/layout.js';

const monitor = {x: 100, y: 0, width: 1920, height: 1080};

test('only the bottom dock is horizontal', () => {
    assert.equal(isHorizontal('bottom'), true);
    assert.equal(isHorizontal('left'), false);
    assert.equal(isHorizontal('right'), false);
});

test('floating bottom dock is centred above the margin', () => {
    const r = dockRect({position: 'bottom', panelMode: false, margin: 8, monitor, width: 400, height: 64});
    assert.deepEqual(r, {x: 100 + 760, y: 1080 - 64 - 8, width: 400, height: 64});
});

test('floating left and right docks are vertically centred', () => {
    const left = dockRect({position: 'left', panelMode: false, margin: 8, monitor, width: 64, height: 400});
    assert.deepEqual(left, {x: 108, y: 340, width: 64, height: 400});
    const right = dockRect({position: 'right', panelMode: false, margin: 8, monitor, width: 64, height: 400});
    assert.deepEqual(right, {x: 100 + 1920 - 64 - 8, y: 340, width: 64, height: 400});
});

test('bottom panel mode spans the full monitor width', () => {
    const r = dockRect({position: 'bottom', panelMode: true, margin: 0, monitor, width: 400, height: 48});
    assert.deepEqual(r, {x: 100, y: 1032, width: 1920, height: 48});
});

test('vertical panel mode spans the height below the top bar', () => {
    const r = dockRect({
        position: 'left', panelMode: true, margin: 0, monitor, width: 60, height: 400, topInset: 32,
    });
    assert.deepEqual(r, {x: 100, y: 32, width: 60, height: 1048});
});

test('top inset is ignored by floating docks', () => {
    const a = dockRect({position: 'left', panelMode: false, margin: 0, monitor, width: 60, height: 400, topInset: 32});
    const b = dockRect({position: 'left', panelMode: false, margin: 0, monitor, width: 60, height: 400});
    assert.deepEqual(a, b);
});

test('hidden offset pushes the dock past its edge', () => {
    assert.deepEqual(hiddenOffset('bottom', 400, 64, 8), {x: 0, y: 84});
    assert.deepEqual(hiddenOffset('left', 64, 400, 8), {x: -84, y: 0});
    assert.deepEqual(hiddenOffset('right', 64, 400, 8), {x: 84, y: 0});
});

test('edge strip hugs the dock edge', () => {
    assert.deepEqual(edgeStrip('bottom', monitor, 3), {x: 100, y: 1077, width: 1920, height: 3});
    assert.deepEqual(edgeStrip('left', monitor, 3), {x: 100, y: 0, width: 3, height: 1080});
    assert.deepEqual(edgeStrip('right', monitor, 3), {x: 2017, y: 0, width: 3, height: 1080});
});

test('containsPoint uses a half-open rect', () => {
    const r = {x: 10, y: 10, width: 5, height: 5};
    assert.equal(containsPoint(r, 10, 10), true);
    assert.equal(containsPoint(r, 14, 14), true);
    assert.equal(containsPoint(r, 15, 12), false);
    assert.equal(containsPoint(r, 9, 12), false);
});

test('dropIndex counts items before the pointer', () => {
    assert.equal(dropIndex([10, 50, 90], 0), 0);
    assert.equal(dropIndex([10, 50, 90], 60), 2);
    assert.equal(dropIndex([10, 50, 90], 100), 3);
    assert.equal(dropIndex([], 100), 0);
});

test('shiftedIndex moves within bounds only', () => {
    const ids = ['a', 'b', 'c'];
    assert.equal(shiftedIndex(ids, 'b', -1), 0);
    assert.equal(shiftedIndex(ids, 'b', 1), 2);
    assert.equal(shiftedIndex(ids, 'a', -1), -1);
    assert.equal(shiftedIndex(ids, 'c', 1), -1);
    assert.equal(shiftedIndex(ids, 'zzz', 1), -1);
});

test('move labels follow the dock orientation', () => {
    assert.deepEqual(moveLabels('bottom'), {back: 'Move Left', forward: 'Move Right'});
    assert.deepEqual(moveLabels('left'), {back: 'Move Up', forward: 'Move Down'});
});
