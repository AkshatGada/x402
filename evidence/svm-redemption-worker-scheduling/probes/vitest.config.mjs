import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = process.env.X402_SOURCE_ROOT;
if (!sourceRoot) throw new Error("Set X402_SOURCE_ROOT to a prepared implementation checkout");
const packageRoot = resolve(sourceRoot, "typescript/packages/mechanisms/svm");
export default {
  root: dirname(fileURLToPath(import.meta.url)),
  resolve: {
    alias: {
      "@redemption-source": resolve(packageRoot, "src"),
      vitest: resolve(packageRoot, "node_modules/vitest/dist/index.js"),
    },
  },
  test: {
    include: ["second-audit.test.ts"],
    exclude: [],
    coverage: { enabled: false },
  },
};
