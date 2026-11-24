import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
    PRESETS,
    PRESET_KEY_TYPES,
    applyPreset,
    findMatchingPreset,
    getPreset,
} from '../lib/presets.js';

const SCHEMA_PATH = new URL(
    '../schemas/org.gnome.shell.extensions.aqua-dock.gschema.xml', import.meta.url);

// Minimal reader for the keys in our own schema: type, default, range, choices.
function loadSchema() {
    const xml = readFileSync(SCHEMA_PATH, 'utf8');
    const keys = {};
    for (const [, name, type, body] of xml.matchAll(
        /<key name="([^"]+)" type="([^"]+)">([\s\S]*?)<\/key>/g)) {
        const raw = body.match(/<default>([^<]*)<\/default>/)[1];
        const range = body.match(/<range min="(-?\d+)" max="(-?\d+)"\/>/);
        const choices = [...body.matchAll(/<choice value="([^"]+)"\/>/g)].map(m => m[1]);
        keys[name] = {
            type,
            default: type === 'b' ? raw === 'true'
                : type === 'i' ? Number(raw)
                    : raw.replace(/^"|"$/g, ''),
            range: range ? [Number(range[1]), Number(range[2])] : null,
            choices,
        };
    }
    return keys;
}

// In-memory stand-in for Gio.Settings, including delay/apply semantics.
class FakeSettings {
    constructor(values) {
        this.values = {...values};
        this.pending = null;
        this.applyCount = 0;
    }

    _get(key) {
        if (!(key in this.values))
            throw new Error(`unknown key ${key}`);
        return this.pending && key in this.pending ? this.pending[key] : this.values[key];
    }

    _set(key, value) {
        if (!(key in this.values))
            throw new Error(`unknown key ${key}`);
        if (this.pending)
            this.pending[key] = value;
        else
            this.values[key] = value;
    }

    get_boolean(key) { return this._get(key); }
    get_int(key) { return this._get(key); }
    get_string(key) { return this._get(key); }
    set_boolean(key, v) { this._set(key, v); }
    set_int(key, v) { this._set(key, v); }
    set_string(key, v) { this._set(key, v); }
    delay() { this.pending = {}; }
    revert() { this.pending = {}; }

    apply() {
        Object.assign(this.values, this.pending);
        this.pending = {};
        this.applyCount++;
    }
}

const schema = loadSchema();
const defaults = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.default]));

test('preset ids are unique', () => {
    const ids = PRESETS.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
});

test('every preset sets exactly the declared preset keys', () => {
    for (const preset of PRESETS)
        assert.deepEqual(Object.keys(preset.settings).sort(), Object.keys(PRESET_KEY_TYPES).sort(), preset.id);
});

test('preset key types agree with the schema', () => {
    for (const [key, type] of Object.entries(PRESET_KEY_TYPES)) {
        assert.ok(schema[key], `${key} missing from schema`);
        assert.equal(schema[key].type, type, key);
    }
});

test('every preset value is valid for the schema', () => {
    for (const preset of PRESETS) {
        for (const [key, value] of Object.entries(preset.settings)) {
            const spec = schema[key];
            const where = `${preset.id}.${key}`;
            if (spec.type === 'b')
                assert.equal(typeof value, 'boolean', where);
            if (spec.type === 'i') {
                assert.ok(Number.isInteger(value), where);
                if (spec.range)
                    assert.ok(value >= spec.range[0] && value <= spec.range[1], `${where} out of range`);
            }
            if (spec.type === 's' && spec.choices.length)
                assert.ok(spec.choices.includes(value), `${where} not a valid choice`);
        }
    }
});

test('no two presets are identical', () => {
    const seen = new Set();
    for (const preset of PRESETS) {
        const key = JSON.stringify(Object.entries(preset.settings).sort());
        assert.ok(!seen.has(key), `${preset.id} duplicates another preset`);
        seen.add(key);
    }
});

test('the Aqua preset matches the schema defaults', () => {
    assert.equal(findMatchingPreset(new FakeSettings(defaults))?.id, 'aqua');
});

test('a macOS preset is offered', () => {
    assert.ok(getPreset('macos'));
});

test('applyPreset writes every value in a single batch', () => {
    const settings = new FakeSettings(defaults);
    assert.equal(applyPreset(settings, 'windows'), true);
    assert.equal(settings.applyCount, 1);
    for (const [key, value] of Object.entries(getPreset('windows').settings))
        assert.equal(settings.values[key], value, key);
    assert.equal(findMatchingPreset(settings)?.id, 'windows');
});

test('applyPreset rejects an unknown id without touching settings', () => {
    const settings = new FakeSettings(defaults);
    assert.equal(applyPreset(settings, 'nope'), false);
    assert.deepEqual(settings.values, defaults);
    assert.equal(settings.applyCount, 0);
});

test('applyPreset reverts and rethrows when a write fails', () => {
    const settings = new FakeSettings(defaults);
    settings.set_int = () => {
        throw new Error('boom');
    };
    assert.throws(() => applyPreset(settings, 'macos'), /boom/);
    assert.deepEqual(settings.values, defaults);
});

test('a manual tweak after applying a preset reads as custom', () => {
    const settings = new FakeSettings(defaults);
    applyPreset(settings, 'macos');
    settings.set_int('icon-size', 64);
    assert.equal(findMatchingPreset(settings), null);
});
