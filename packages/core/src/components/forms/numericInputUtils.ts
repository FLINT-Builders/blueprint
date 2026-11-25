/*
 * Copyright 2018 Palantir Technologies, Inc. All rights reserved.
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

import { clamp } from "../../common/utils";

const FALLBACK_LOCALE = "en-US";

/**
 * Returns the locale tag that `Intl.NumberFormat` resolves for `locale`, or `FALLBACK_LOCALE` if the
 * locale is rejected. Formatting with a malformed tag (e.g. "en_US") throws a `RangeError`, so only the
 * resolved tag may be passed on to `toLocaleString` and the other locale-dependent helpers below.
 */
function resolveLocale(locale: string): string;
function resolveLocale(locale: string | undefined): string | undefined;
function resolveLocale(locale: string | undefined) {
    if (locale === undefined) {
        return undefined;
    }
    try {
        return new Intl.NumberFormat(locale).resolvedOptions().locale;
    } catch {
        return FALLBACK_LOCALE;
    }
}

function escapeRegExp(value: string) {
    return value.replace(/[\\^$.*+?()[\]{}|\-/]/g, "\\$&");
}

/** Returns the `decimal` number separator based on a locale returned by `resolveLocale` */
function getDecimalSeparator(resolvedLocale: string) {
    const testNumber = 1.9;
    const testText = testNumber.toLocaleString(resolvedLocale);
    const one = (1).toLocaleString(resolvedLocale);
    const nine = (9).toLocaleString(resolvedLocale);
    const pattern = `${escapeRegExp(one)}(.+)${escapeRegExp(nine)}`;

    const result = new RegExp(pattern).exec(testText);

    return (result && result[1]) || ".";
}

export function toLocaleString(num: number, locale: string = FALLBACK_LOCALE) {
    const resolvedLocale = resolveLocale(locale);
    // HACKHACK: roundingPriority is not supported yet in TypeScript https://github.com/microsoft/TypeScript/issues/43336
    return sanitizeResolvedNumericInput(
        num.toLocaleString(resolvedLocale, { roundingPriority: "morePrecision" } as any),
        resolvedLocale,
    );
}

export function clampValue(value: number, min?: number, max?: number) {
    // defaultProps won't work if the user passes in null, so just default
    // to +/- infinity here instead, as a catch-all.
    const adjustedMin = min != null ? min : -Infinity;
    const adjustedMax = max != null ? max : Infinity;
    return clamp(value, adjustedMin, adjustedMax);
}

export function getValueOrEmptyValue(value: number | string = "") {
    return value.toString();
}

/** Transform the localized character (ex. "") to a javascript recognizable string number (ex. "10.99")  */
function transformLocalizedNumberToStringNumber(character: string, resolvedLocale: string) {
    const charactersMap = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(value => value.toLocaleString(resolvedLocale));
    const jsNumber = charactersMap.indexOf(character);

    if (jsNumber !== -1) {
        return jsNumber;
    } else {
        return character;
    }
}

/** Transforms the localized number (ex. "10,99") to a javascript recognizable string number (ex. "10.99")  */
export function parseStringToStringNumber(value: number | string, locale: string | undefined): string {
    const valueAsString = "" + value;
    if (parseFloat(valueAsString).toString() === value.toString()) {
        return value.toString();
    }

    if (locale !== undefined) {
        const resolvedLocale = resolveLocale(locale);
        const decimalSeparator = getDecimalSeparator(resolvedLocale);
        const sanitizedString = sanitizeResolvedNumericInput(valueAsString, resolvedLocale);

        return sanitizedString
            .split("")
            .map(character => transformLocalizedNumberToStringNumber(character, resolvedLocale))
            .join("")
            .replace(decimalSeparator, ".");
    }

    return value.toString();
}

/** Returns `true` if the string represents a valid numeric value, like "1e6". */
export function isValueNumeric(value: string, locale: string | undefined) {
    // checking if a string is numeric in Typescript is a big pain, because
    // we can't simply toss a string parameter to isFinite. below is the
    // essential approach that jQuery uses, which involves subtracting a
    // parsed numeric value from the string representation of the value. we
    // need to cast the value to the `any` type to allow this operation
    // between dissimilar types.
    const stringToStringNumber = parseStringToStringNumber(value, locale);
    return value != null && (stringToStringNumber as any) - parseFloat(stringToStringNumber) + 1 >= 0;
}

export function isValidNumericKeyboardEvent(e: React.KeyboardEvent, locale: string | undefined) {
    // unit tests may not include e.key. don't bother disabling those events.
    if (e.key == null) {
        return true;
    }

    // allow modified key strokes that may involve letters and other
    // non-numeric/invalid characters (Cmd + A, Cmd + C, Cmd + V, Cmd + X).
    if (e.ctrlKey || e.altKey || e.metaKey) {
        return true;
    }

    // keys that print a single character when pressed have a `key` name of
    // length 1. every other key has a longer `key` name (e.g. "Backspace",
    // "ArrowUp", "Shift"). since none of those keys can print a character
    // to the field--and since they may have important native behaviors
    // beyond printing a character--we don't want to disable their effects.
    const isSingleCharKey = e.key.length === 1;
    if (!isSingleCharKey) {
        return true;
    }

    // now we can simply check that the single character that wants to be printed
    // is a floating-point number character that we're allowed to print.
    return getFloatingPointNumericCharacterRegex(resolveLocale(locale)).test(e.key);
}

/**
 * A regex that matches a string of length 1 (i.e. a standalone character)
 * if and only if it is a floating-point number character as defined by W3C:
 * https://www.w3.org/TR/2012/WD-html-markup-20120329/datatypes.html#common.data.float
 *
 * Floating-point number characters are the only characters that can be
 * printed within a default input[type="number"]. This component should
 * behave the same way when this.props.allowNumericCharactersOnly = true.
 * See here for the input[type="number"].value spec:
 * https://www.w3.org/TR/2012/WD-html-markup-20120329/input.number.html#input.number.attrs.value
 */
function getFloatingPointNumericCharacterRegex(resolvedLocale: string | undefined) {
    if (resolvedLocale === undefined) {
        return /^[Ee0-9\+\-\.]$/;
    }
    const decimalSeparator = escapeRegExp(getDecimalSeparator(resolvedLocale));
    const numbers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map(value => escapeRegExp(value.toLocaleString(resolvedLocale)))
        .join("");
    return new RegExp("^[Ee" + numbers + "\\+\\-" + decimalSeparator + "]$");
}

/**
 * Round the value to have _up to_ the specified maximum precision.
 *
 * This differs from `toFixed(5)` in that trailing zeroes are not added on
 * more precise values, resulting in shorter strings.
 */
export function toMaxPrecision(value: number, maxPrecision: number) {
    // round the value to have the specified maximum precision (toFixed is the wrong choice,
    // because it would show trailing zeros in the decimal part out to the specified precision)
    // source: http://stackoverflow.com/a/18358056/5199574
    const scaleFactor = Math.pow(10, maxPrecision);
    return Math.round(value * scaleFactor) / scaleFactor;
}

/**
 * Convert Japanese full-width numbers, e.g. '５', to ASCII, e.g. '5'
 * This should be called before performing any other numeric string input validation.
 */
function convertFullWidthNumbersToAscii(value: string) {
    return value.replace(/[\uFF10-\uFF19]/g, m => String.fromCharCode(m.charCodeAt(0) - 0xfee0));
}

/**
 * Convert full-width (Japanese) numbers to ASCII, and strip all characters that are not valid floating-point numeric characters
 */
export function sanitizeNumericInput(value: string, locale: string | undefined) {
    return sanitizeResolvedNumericInput(value, resolveLocale(locale));
}

function sanitizeResolvedNumericInput(value: string, resolvedLocale: string | undefined) {
    const valueChars = convertFullWidthNumbersToAscii(value).split("");
    const numericCharacterRegex = getFloatingPointNumericCharacterRegex(resolvedLocale);
    const sanitizedValueChars = valueChars.filter(valueChar => numericCharacterRegex.test(valueChar));

    return sanitizedValueChars.join("");
}
