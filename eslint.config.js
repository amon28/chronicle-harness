import globals from 'globals';

// Catches the mistakes that matter most in a big vanilla-JS app split across modules:
// names that aren't defined/imported, imports that don't exist, and assignments to imports.
export default [
  { ignores: ['dist/**', 'android/**', 'node_modules/**', 'public/**', 'proxy/**'] },
  {
    files: ['src/**/*.js', 'tests/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-import-assign': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
];
