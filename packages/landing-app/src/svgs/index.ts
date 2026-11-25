/*
 * Copyright 2016 Palantir Technologies, Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

const HERO_SVGS: Record<string, string> = {
    alert: require("raw-loader!./alert.svg").default,
    buttons: require("raw-loader!./buttons.svg").default,
    calendar: require("raw-loader!./calendar.svg").default,
    checkboxes: require("raw-loader!./checkboxes.svg").default,
    "file-upload": require("raw-loader!./file-upload.svg").default,
    "input-groups": require("raw-loader!./input-groups.svg").default,
    inputs: require("raw-loader!./inputs.svg").default,
    labels: require("raw-loader!./labels.svg").default,
    radios: require("raw-loader!./radios.svg").default,
    "select-menus": require("raw-loader!./select-menus.svg").default,
    sliders: require("raw-loader!./sliders.svg").default,
    switches: require("raw-loader!./switches.svg").default,
    "time-selections": require("raw-loader!./time-selections.svg").default,
    toggles: require("raw-loader!./toggles.svg").default,
};

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

// Only static shape and structure elements; anything that can run script, embed HTML,
// load external resources, or animate attributes (e.g. into a javascript: URL) is dropped.
const ALLOWED_ELEMENTS = new Set([
    "circle",
    "clipPath",
    "defs",
    "desc",
    "ellipse",
    "g",
    "line",
    "linearGradient",
    "mask",
    "path",
    "polygon",
    "polyline",
    "radialGradient",
    "rect",
    "stop",
    "svg",
    "symbol",
    "title",
    "use",
]);

const ALLOWED_ATTRIBUTES = new Set([
    "clip-path",
    "clip-rule",
    "clipPathUnits",
    "cx",
    "cy",
    "d",
    "fill",
    "fill-opacity",
    "fill-rule",
    "fx",
    "fy",
    "gradientTransform",
    "gradientUnits",
    "height",
    "id",
    "mask",
    "maskContentUnits",
    "maskUnits",
    "offset",
    "opacity",
    "points",
    "preserveAspectRatio",
    "r",
    "rx",
    "ry",
    "stop-color",
    "stop-opacity",
    "stroke",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-opacity",
    "stroke-width",
    "transform",
    "viewBox",
    "width",
    "x",
    "x1",
    "x2",
    "y",
    "y1",
    "y2",
]);

const LOCAL_REFERENCE = /^#[\w.-]+$/;
const URL_FUNCTION = /url\s*\(/i;
const LOCAL_URL_FUNCTION = /^url\(\s*#[\w.-]+\s*\)$/;

function isSafeAttributeValue(value: string) {
    return !URL_FUNCTION.test(value) || LOCAL_URL_FUNCTION.test(value.trim());
}

/**
 * Rebuilds a parsed SVG node in the target document from the allowlists above, so the
 * result never contains markup that the browser would interpret as HTML or script.
 */
function cloneSafeSVGNode(source: Element): SVGElement | null {
    if (source.namespaceURI !== SVG_NS || !ALLOWED_ELEMENTS.has(source.localName)) {
        return null;
    }
    const target = document.createElementNS(SVG_NS, source.localName);

    for (const attr of Array.from(source.attributes)) {
        if (attr.localName === "href" && (attr.namespaceURI === XLINK_NS || attr.namespaceURI === null)) {
            if (LOCAL_REFERENCE.test(attr.value.trim())) {
                target.setAttributeNS(XLINK_NS, "xlink:href", attr.value.trim());
            }
        } else if (
            attr.namespaceURI === null &&
            ALLOWED_ATTRIBUTES.has(attr.localName) &&
            isSafeAttributeValue(attr.value)
        ) {
            target.setAttribute(attr.localName, attr.value);
        }
    }

    for (const child of Array.from(source.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE) {
            const safeChild = cloneSafeSVGNode(child as Element);
            if (safeChild != null) {
                target.appendChild(safeChild);
            }
        } else if (child.nodeType === Node.TEXT_NODE && (source.localName === "title" || source.localName === "desc")) {
            target.appendChild(document.createTextNode(child.textContent ?? ""));
        }
    }
    return target;
}

function parseSafeSVG(markup: string): SVGElement | null {
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
    const root = parsed.documentElement;
    if (root.getElementsByTagNameNS("*", "parsererror").length > 0 || root.localName !== "svg") {
        return null;
    }
    return cloneSafeSVGNode(root);
}

function injectSVG(elem: HTMLElement, id: string) {
    const wrapper = document.createElement("div");
    wrapper.classList.add("landing-wireframe", `landing-logo-wireframe-${id}`);
    const svg = parseSafeSVG(HERO_SVGS[id]);
    if (svg != null) {
        wrapper.appendChild(svg);
    }
    elem.appendChild(wrapper);
}

export function initializeSVGs(elem: HTMLElement) {
    for (const id of Object.keys(HERO_SVGS)) {
        injectSVG(elem, id);
    }
}
