/*
 * Copyright 2026 Palantir Technologies, Inc. All rights reserved.
 *
 * Icon glyphs are not part of the markdown-to-HTML path. This stand-in only
 * satisfies imports from the real Tag and Icon components so those components
 * can render documentation text.
 */

import { createElement, type SVGProps } from "react";

export const IconSize = {
    LARGE: 20,
    SMALL: 12,
    STANDARD: 16,
} as const;

export const Icons = {
    load: () => Promise.resolve(),
    loadAll: () => Promise.resolve(),
};

export function SVGIconContainer(props: SVGProps<SVGSVGElement> & { children?: React.ReactNode }) {
    return createElement("svg", props);
}

export function SmallCrossIcon() {
    return null;
}
