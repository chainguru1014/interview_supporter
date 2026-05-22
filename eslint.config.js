/* eslint-env node */
const js = require("@eslint/js");
const globals = require("globals");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");
const importPlugin = require("eslint-plugin-import");
const prettier = require("eslint-config-prettier");

module.exports = [
  // Ignore build folders
  { ignores: ["dist", "out", "node_modules"] },

  // Global language options (Node + Browser for Electron)
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.es2023,
        ...globals.browser,
        ...globals.node,
      },
    },
  },

  // JS recommended rules
  js.configs.recommended,

  // TypeScript files
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      import: importPlugin,
    },
    // TS recommended rules
    rules: {
      ...tsPlugin.configs.recommended.rules,
    },
    // Resolve TS imports
    settings: {
      "import/resolver": {
        node: { extensions: [".js", ".ts"] },
        typescript: { alwaysTryTypes: true, project: true },
      },
    },
  },

  // Disable rules that conflict with Prettier
  prettier,
];
