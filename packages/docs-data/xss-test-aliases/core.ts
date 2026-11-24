/*
 * Copyright 2026 Palantir Technologies, Inc. All rights reserved.
 *
 * Test-only entry for @blueprintjs/core. The package build is not produced in this
 * job, and the public barrel pulls generated icon sources. These re-exports are the
 * real components the documentation theme renders on the XSS paths.
 */

export * as Classes from "../../core/src/common/classes";
export { Intent } from "../../core/src/common/intent";
export type { Props } from "../../core/src/common/props";
export { Checkbox } from "../../core/src/components/forms/controls";
export { Code, H3 } from "../../core/src/components/html/html";
export { Tag } from "../../core/src/components/tag/tag";
