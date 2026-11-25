/* !
 * (c) Copyright 2026 Palantir Technologies Inc. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Run the same docs-theme tests on a public documentation host and on blueprintjs.com.
 * Hash routing treats those hosts differently only in an analytics call that happens
 * before the route is accepted.
 */
const sharedTest = {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["@blueprintjs/test-commons/vitest-setup-no-enzyme"],
};

// Workspace packages publish both "main" (CJS) and "module" (ESM). This test run loads the ESM build.
const sharedResolve = {
    mainFields: ["module", "main"],
};

export default defineConfig({
    plugins: [react()],
    test: {
        projects: [
            {
                plugins: [react()],
                resolve: sharedResolve,
                test: {
                    ...sharedTest,
                    environmentOptions: {
                        jsdom: { url: "https://docs.example.com/guide" },
                    },
                    name: "docs-theme-public-host",
                },
            },
            {
                plugins: [react()],
                resolve: sharedResolve,
                test: {
                    ...sharedTest,
                    environmentOptions: {
                        jsdom: { url: "https://blueprintjs.com/docs/" },
                    },
                    name: "docs-theme-blueprint-host",
                },
            },
        ],
    },
});
