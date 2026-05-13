// ESLint v10 flat config.
// Type-aware rules: requires `parserOptions.projectService: true` (TS 5+).

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import promise from "eslint-plugin-promise";
import importX from "eslint-plugin-import-x";
import unicorn from "eslint-plugin-unicorn";
import jsonc from "eslint-plugin-jsonc";
import prettier from "eslint-config-prettier";

const __dirname = import.meta.dirname;

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "coverage/",
      "node_modules/",
      "test/",
      "scripts/",
      "*.mjs",
      "*.config.*",
      // package-lock.json is npm-managed; linting it would just churn
      // on every dependency update for no practical benefit.
      "package-lock.json",
    ],
  },
  // Type-aware rules + JS recommended only fire on TS/JS source — the
  // type-checked tseslint configs require `parserOptions.projectService`
  // and the TS parser, neither of which can handle `.json` / `.jsonc`.
  // Keeping this block scoped lets the JSON files fall through to the
  // jsonc preset below.
  {
    files: ["**/*.{ts,mts,cts,tsx,js,mjs,cjs}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      promise.configs["flat/recommended"],
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
      unicorn.configs["flat/recommended"],
    ],
    rules: {
      // eslint-plugin-unicorn adoption pass 1. Three rules disabled per
      // the klodr/* policy (see klodr/eslint-plugin-security-mcp#41):
      //
      //   - `prevent-abbreviations` deferred to pass 3 of the plan.
      //     Combined ~285 findings across the klodr/* MCP family before
      //     an allowList is sized; would force eslint-disable on every
      //     `req` / `res` / `args` / `opts` / `ctx` / `err`.
      //   - `no-null` — third-party APIs (MCP SDK, Zod, Sentry) hand
      //     `null` through unchanged; switching to `undefined` would
      //     force casts at every boundary. Also off in unicorn's
      //     unopinionated preset.
      //   - `no-array-reduce` — `reduce()` is idiomatic functional JS,
      //     intentionally used in tool aggregation. Stylistic, not
      //     correctness.
      "unicorn/prevent-abbreviations": [
        "error",
        {
          replacements: {
            args: false,
            arg: false,
            opts: false,
            msg: false,
            err: false,
            res: false,
            val: false,
            tmp: false,
            env: false,
            pkg: false,
            obj: false,
            params: false,
            ext: false,
          },
          // ITU-T E.164 is the phone-numbering standard; the rule
          // proposes "error164" / "event164" which are nonsensical
          // here. allowList exempts specific full identifier names
          // (replacements operate on abbreviation prefixes, which is
          // why setting `e164: false` would not have helped).
          allowList: {
            e164: true,
            E164: true,
            isValidE164: true,
          },
        },
      ],
      "unicorn/no-null": "off",
      "unicorn/no-array-reduce": "off",
      // CLI / entry-point rules — this package SHIPS a CLI:
      // `src/index.ts` boots the stdio server and `process.exit(1)`
      // is the correct signal to a parent process. The rule's own
      // docs scope it to libraries, not bin scripts.
      "unicorn/no-process-exit": "off",
      // Named imports from node:* are explicit, tree-shakable, and
      // consistent with the rest of the SDK style we follow
      // (@modelcontextprotocol/sdk and friends). The default-import
      // form `import path from "node:path"` is a personal preference,
      // not a correctness issue.
      "unicorn/import-style": "off",
      // The `main()` wrapper + `.catch()` is the idiomatic
      // top-level error-trap pattern in stdio MCP entry points
      // (mirrors @modelcontextprotocol/sdk samples). Refactoring
      // to top-level await + try/catch is a separate sweep.
      "unicorn/prefer-top-level-await": "off",
    },
  },
  // JSON / JSONC / JSON5 linting via eslint-plugin-jsonc — `recommended-with-jsonc`
  // applies the JSONC parser to plain `.json` too, so trailing commas in tsconfig
  // and similar tooling files don't trip the strict JSON parser.
  ...jsonc.configs["flat/recommended-with-jsonc"],
  prettier,
  {
    // Scope the type-aware project options + project rules to TS source
    // only — these settings only make sense for files the TS compiler
    // actually owns. The block above already restricts the rule set
    // itself; this block scopes the language options accordingly.
    files: ["**/*.{ts,mts,cts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // High-value additions over `recommendedTypeChecked`:
      eqeqeq: ["error", "always"],
      "no-console": ["warn", { allow: ["error", "warn"] }],

      // TS already resolves imports via the compiler — if a path is
      // wrong, `tsc --noEmit` and vitest both fail. `import-x` cannot
      // follow `exports` maps with `./*` wildcards (the MCP SDK uses
      // them for `./server/mcp.js`), so disable to avoid false reports.
      "import-x/no-unresolved": "off",
      // The recommendedTypeChecked preset already enables:
      // - @typescript-eslint/no-floating-promises
      // - @typescript-eslint/await-thenable
      // - @typescript-eslint/no-misused-promises
      // - @typescript-eslint/no-unsafe-* (relaxed below where needed)

      // Relax for our codebase:
      "@typescript-eslint/no-unsafe-assignment": "off", // too noisy with JSON.parse outputs
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",

      // Honour the conventional `_`-prefix to mark intentionally
      // unused destructured fields (e.g. when stripping read-only
      // keys from a Mercury response before re-POSTing it).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
