import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The layering: the sign-in, security and shared modules never import the
// Console, so the Console sits on top of them and they stay reusable. Each
// pattern matches any path segment, alias or relative.
const CONSOLE = ["**/console", "**/console/**"];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/lib/{shared,security,signin}/**", "src/components/shared/**", "src/config/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: CONSOLE, message: "Shared code must not import the Console." }] },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local agent session state inside the checkout.
    ".agent/**",
    ".claude/**",
    ".codex/**",
  ]),
]);

export default eslintConfig;
