import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// typescript-eslint's recommended rules, with unused variables and expressions as warnings (what the project used before).
export default defineConfig([
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
    },
  },
  globalIgnores(["dist/**", "work/**", "output/**", "outputs/**"]),
]);
