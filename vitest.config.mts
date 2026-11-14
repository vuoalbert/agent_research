import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = resolve(fileURLToPath(new URL(".", import.meta.url)), "src");

// no @vitejs/plugin-react: it pulls Babel 8, which conflicts with the Babel 7
// the shadcn CLI pins. Vitest 5's oxc transform handles the JSX runtime itself.
export default defineConfig({
  resolve: { alias: { "@": src } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    globals: true,
    setupFiles: ["src/test/setup.ts"],
  },
});
