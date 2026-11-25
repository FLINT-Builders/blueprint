/*
 * Copyright 2026 Palantir Technologies, Inc. All rights reserved.
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

import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { createElement } from "react";

import { NumericInput } from "../../../components/forms/numericInput";
import { MultiSlider } from "../../../components/slider/multiSlider";
import { RangeSlider } from "../../../components/slider/rangeSlider";
import { Slider } from "../../../components/slider/slider";
import { countDecimalPlaces } from "../jsUtils";

/**
 * Runs one decimal-precision operation in a thread the parent can kill.
 * The parent supplies a step that is already a JavaScript number; this file does not
 * reinterpret it. Each op calls the production function React hits for that prop.
 */
export interface DecimalPlacesProbeRequest {
    op: "count" | "slider-derived" | "numeric-derived" | "render" | "update";
    component?: "Slider" | "RangeSlider" | "MultiSlider" | "NumericInput";
    /** First stepSize, or the only value for `count`. */
    step?: number;
    /** Second step used by `update` after a safe first render. */
    nextStep?: number;
    /** When true, `minorStepSize` is passed through, including null. */
    includeMinorStepSize?: boolean;
    minorStepSize?: number | null;
    includeNextMinorStepSize?: boolean;
    nextMinorStepSize?: number | null;
    labelPrecision?: number;
    /** When set, NumericInput is controlled and validateProps reads the step. */
    value?: number;
}

type SliderProps = { labelPrecision?: number; max: number; min: number; stepSize: number };

function sliderElementProps(step: number, labelPrecision: number | undefined): SliderProps {
    return labelPrecision === undefined
        ? { max: 10, min: 0, stepSize: step }
        : { labelPrecision, max: 10, min: 0, stepSize: step };
}

function numericProps(
    step: number,
    includeMinor: boolean | undefined,
    minor: number | null | undefined,
    value: number | undefined,
) {
    const props: { minorStepSize?: number | null; stepSize: number; value?: number } = { stepSize: step };
    if (includeMinor) {
        props.minorStepSize = minor ?? null;
    }
    if (value !== undefined) {
        props.value = value;
    }
    return props;
}

function sliderDerived(step: number, labelPrecision: number | undefined) {
    const props = labelPrecision === undefined ? { stepSize: step } : { labelPrecision, stepSize: step };
    return MultiSlider.getDerivedStateFromProps(props);
}

function numericDerived(request: DecimalPlacesProbeRequest) {
    return NumericInput.getDerivedStateFromProps(
        numericProps(request.step ?? 1, request.includeMinorStepSize, request.minorStepSize, request.value),
        {
            currentImeInputInvalid: false,
            shouldSelectAfterUpdate: false,
            stepMaxPrecision: 0,
            value: "",
        },
    );
}

async function renderElement(request: DecimalPlacesProbeRequest) {
    const { renderToString } = await import("react-dom/server");
    const step = request.step ?? 1;
    let element;
    if (request.component === "Slider") {
        element = createElement(Slider, sliderElementProps(step, request.labelPrecision));
    } else if (request.component === "RangeSlider") {
        element = createElement(RangeSlider, sliderElementProps(step, request.labelPrecision));
    } else if (request.component === "MultiSlider") {
        element = createElement(MultiSlider, sliderElementProps(step, request.labelPrecision));
    } else if (request.component === "NumericInput") {
        element = createElement(
            NumericInput,
            numericProps(step, request.includeMinorStepSize, request.minorStepSize, request.value),
        );
    } else {
        throw new Error(`Unknown render component ${String(request.component)}`);
    }
    const html = renderToString(element);
    return { htmlLength: html.length };
}

async function installDom() {
    // jsdom ships without types in this workspace. Load it as a value only.
    const require = createRequire(import.meta.url);
    const { JSDOM } = require("jsdom") as {
        JSDOM: new (
            html: string,
            options: { pretendToBeVisual: boolean; url: string },
        ) => { window: Window & typeof globalThis };
    };
    const dom = new JSDOM("<!DOCTYPE html><html><body><div id='root'></div></body></html>", {
        pretendToBeVisual: true,
        url: "http://localhost/",
    });
    const window = dom.window;
    const assignments: Record<string, unknown> = {
        DocumentFragment: window.DocumentFragment,
        Element: window.Element,
        HTMLElement: window.HTMLElement,
        HTMLInputElement: window.HTMLInputElement,
        IS_REACT_ACT_ENVIRONMENT: true,
        MutationObserver: window.MutationObserver,
        Node: window.Node,
        SVGElement: window.SVGElement,
        cancelAnimationFrame: (handle: number) => clearTimeout(handle),
        document: window.document,
        getComputedStyle: window.getComputedStyle.bind(window),
        navigator: window.navigator,
        requestAnimationFrame: (callback: FrameRequestCallback) =>
            setTimeout(() => callback(Date.now()), 16) as unknown as number,
        window,
    };
    for (const [key, value] of Object.entries(assignments)) {
        try {
            Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
        } catch {
            // Node already exposes a few of these (notably navigator) as non-configurable.
        }
    }
}

async function updateElement(request: DecimalPlacesProbeRequest) {
    await installDom();
    const { render } = await import("@testing-library/react");
    const step = request.step ?? 1;
    const nextStep = request.nextStep ?? step;
    let first;
    let second;
    if (request.component === "Slider") {
        first = createElement(Slider, sliderElementProps(step, request.labelPrecision));
        second = createElement(Slider, sliderElementProps(nextStep, request.labelPrecision));
    } else if (request.component === "RangeSlider") {
        first = createElement(RangeSlider, sliderElementProps(step, request.labelPrecision));
        second = createElement(RangeSlider, sliderElementProps(nextStep, request.labelPrecision));
    } else if (request.component === "MultiSlider") {
        first = createElement(MultiSlider, sliderElementProps(step, request.labelPrecision));
        second = createElement(MultiSlider, sliderElementProps(nextStep, request.labelPrecision));
    } else if (request.component === "NumericInput") {
        const initial = numericProps(step, request.includeMinorStepSize, request.minorStepSize, request.value);
        const nextMinor = request.includeNextMinorStepSize ? request.nextMinorStepSize : request.minorStepSize;
        const includeNextMinor = request.includeNextMinorStepSize || request.includeMinorStepSize;
        const next = numericProps(nextStep, includeNextMinor, nextMinor, request.value);
        first = createElement(NumericInput, initial);
        second = createElement(NumericInput, next);
    } else {
        throw new Error(`Unknown update component ${String(request.component)}`);
    }
    const view = render(first);
    view.rerender(second);
    return { htmlLength: view.container.innerHTML.length };
}

async function run(request: DecimalPlacesProbeRequest) {
    switch (request.op) {
        case "count":
            return countDecimalPlaces(request.step ?? Number.NaN);
        case "slider-derived":
            return sliderDerived(request.step ?? Number.NaN, request.labelPrecision);
        case "numeric-derived":
            return numericDerived(request);
        case "render":
            return renderElement(request);
        case "update":
            return updateElement(request);
        default:
            throw new Error(`Unknown op ${String(request.op)}`);
    }
}

const probeRequest = workerData as DecimalPlacesProbeRequest;

void run(probeRequest).then(
    value => {
        parentPort?.postMessage({ status: "ok", value });
    },
    (error: unknown) => {
        parentPort?.postMessage({
            message: error instanceof Error ? error.message : String(error),
            status: "threw",
        });
    },
);
