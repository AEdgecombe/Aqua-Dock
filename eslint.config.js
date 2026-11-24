import js from '@eslint/js';
import globals from 'globals';

// GJS globals available inside GNOME Shell and the prefs process.
const gjsGlobals = {
    global: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    imports: 'readonly',
    console: 'readonly',
};

export default [
    {ignores: ['node_modules/']},
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            'indent': ['error', 4, {SwitchCase: 1, offsetTernaryExpressions: true}],
            'quotes': ['error', 'single', {avoidEscape: true}],
            'semi': ['error', 'always'],
            'comma-dangle': ['error', {
                arrays: 'always-multiline',
                objects: 'always-multiline',
                imports: 'always-multiline',
                exports: 'always-multiline',
                functions: 'only-multiline',
            }],
            'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
            'prefer-const': 'error',
            'eqeqeq': ['error', 'always'],
            'no-trailing-spaces': 'error',
            'eol-last': 'error',
        },
    },
    {
        files: ['tests/**/*.js', 'eslint.config.js'],
        languageOptions: {globals: globals.node},
    },
];
