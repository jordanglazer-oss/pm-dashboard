import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The agents key (ANTHROPIC_AGENTS_API_KEY) is read ONLY by the agents
  // gateway, so no existing feature can drift onto the watchers' budget and
  // no watcher can bypass the spend stop.
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["app/lib/agents/gateway.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='ANTHROPIC_AGENTS_API_KEY'], Literal[value='ANTHROPIC_AGENTS_API_KEY']",
          message: "Only app/lib/agents/gateway.ts may read the agents key — call agentCall() instead.",
        },
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
    // Design canvas working files (not app code).
    "design-pro/**",
    "design-streamline/**",
  ]),
]);

export default eslintConfig;
