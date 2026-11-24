/* !
 * (c) Copyright 2026 Palantir Technologies Inc. All rights reserved.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(packageDir, "..");

/**
 * Runs the documentation XSS tests without the package's default setup file,
 * which imports a built copy of @blueprintjs/test-commons.
 * Workspace packages are loaded from source because lib/ is produced by compile.
 */
export default defineConfig({
    resolve: {
        alias: {
            "@blueprintjs/colors": path.join(packagesDir, "colors/src/index.ts"),
            "@blueprintjs/core": path.join(packageDir, "xss-test-aliases/core.ts"),
            "@blueprintjs/docs-theme": path.join(packagesDir, "docs-theme/src/common/index.ts"),
            "@blueprintjs/icons": path.join(packageDir, "xss-test-aliases/icons.tsx"),
        },
    },
    test: {
        name: "docs-data-xss",
        root: packageDir,
        environment: "jsdom",
        include: ["markdownXss.test.tsx"],
        exclude: ["lib/**", "node_modules/**"],
    },
});
