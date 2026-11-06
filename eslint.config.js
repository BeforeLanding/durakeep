import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".dependency-cruiser.cjs", "node_modules/**", "docs/**", "tests/fixtures/**", "data/**", ".tmp/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // ADR-01 的第二道防线（主规则在 dependency-cruiser）
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["packages/**/*.ts", "apps/**/*.ts"],
    ignores: ["packages/runtime-pi/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["@earendil-works/*"], message: "ADR-01：只有 packages/runtime-pi 可以 import @earendil-works/*" }] }],
    },
  },
);
