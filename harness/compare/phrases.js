"use strict";
// Seeded random phrase generator for the comparison harness.
//
// Phrases mix everyday English date/time expressions (casual words, weekdays, times, months,
// relative units, numeric formats) with filler text, punctuation, case changes and a little
// non-ASCII text (to exercise UTF-16 vs byte indexes). Reference dates are random in 2000-2040,
// biased towards month ends, year ends and Feb 28/29.

/** mulberry32: small, fast, deterministic 32-bit PRNG. */
function prng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)); // inclusive
    const pick = (arr) => arr[Math.floor(next() * arr.length)];
    const chance = (p) => next() < p;
    return { next, int, pick, chance };
}

const CASUAL = ["now", "today", "tonight", "tomorrow", "tmr", "tmrw", "overmorrow", "yesterday", "last night", "lastnight"];
const WEEKDAYS = [
    "sunday", "sun", "sun.", "monday", "mon", "mon.", "tuesday", "tue", "tue.", "wednesday", "wed", "wed.",
    "thursday", "thurs", "thur", "thu", "thu.", "friday", "fri", "fri.", "saturday", "sat", "sat.", "weekend", "weekday",
];
const MODIFIERS = ["this", "last", "past", "next"];
const MONTHS = [
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november",
    "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "Jan.", "Sept.",
];
const UNITS = ["second", "minute", "hour", "day", "week", "month", "year", "quarter", "sec", "min", "hr", "mo", "yr", "h", "m", "d", "w"];
const NUMBER_WORDS = ["one", "two", "three", "five", "ten", "twelve", "a", "an", "a few", "several", "half an", "a couple of"];
const ORDINALS = ["1st", "2nd", "3rd", "4th", "11th", "21st", "22nd", "31st", "first", "second", "twenty-first", "thirtieth"];
const RANGE = [" - ", "-", " to ", " until ", " through ", " till ", "~", " – "];
const AMPM = ["am", "pm", "AM", "PM", "a.m.", "p.m.", "a", "p", " am", " pm"];
const TIME_SUFFIX = [" o'clock", " oclock", " at night", " in the morning", " in the afternoon"];
const FILLERS = [
    ["", ""],
    ["Let's meet ", ""],
    ["See you ", "!"],
    ["Deadline: ", "."],
    ["The meeting is ", " and that is final"],
    ["(", ")"],
    ["Call me ", ", ok?"],
    ["I was there ", "."],
    ["café opens ", " 😀"],
    ["Rendez-vous ", " à Paris"],
    ["Ship it\u00a0", ""],
    ["Report due ", "\n thanks"],
];
const TIMEZONE_ABBRS = ["UTC", "GMT", "EST", "EDT", "CST", "CDT", "PST", "PDT", "JST", "CET", "ET", "PT", "MT", "CT", "IST", "BST"];

function pad2(n) {
    return String(n).padStart(2, "0");
}

function casePerturb(r, s) {
    if (r.chance(0.1)) return s.toUpperCase();
    if (r.chance(0.2)) return s.charAt(0).toUpperCase() + s.slice(1);
    return s;
}

function timeExpr(r) {
    let s = "";
    if (r.chance(0.3)) s += r.pick(["at ", "from ", "At ", "at"]);
    const style = r.int(0, 5);
    if (style === 0) s += String(r.int(0, 24));
    else if (style === 1) s += `${r.int(0, 24)}:${pad2(r.int(0, 59))}`;
    else if (style === 2) s += `${r.int(0, 23)}:${pad2(r.int(0, 59))}:${pad2(r.int(0, 59))}`;
    else if (style === 3) s += `${r.int(1, 12)}.${pad2(r.int(0, 59))}`;
    else if (style === 4) s += `${r.int(0, 23)}:${pad2(r.int(0, 59))}:${pad2(r.int(0, 59))}.${r.int(0, 999)}`;
    else s += String(r.int(100, 2400));
    if (r.chance(0.5)) s += r.pick(AMPM);
    if (r.chance(0.15)) s += r.pick(TIME_SUFFIX);
    if (r.chance(0.2)) {
        s += r.pick(RANGE) + String(r.int(0, 24));
        if (r.chance(0.5)) s += `:${pad2(r.int(0, 59))}`;
        if (r.chance(0.5)) s += r.pick(AMPM);
    }
    return s;
}

function weekdayExpr(r) {
    let s = "";
    if (r.chance(0.2)) s += r.pick(["on ", ", ", "(", "On "]);
    if (r.chance(0.4)) s += r.pick(MODIFIERS) + " ";
    s += casePerturb(r, r.pick(WEEKDAYS));
    if (r.chance(0.1)) s += r.pick([",", ")"]);
    if (r.chance(0.15)) s += ` ${r.chance(0.5) ? "of " : ""}${r.pick(MODIFIERS)} week`;
    return s;
}

function dateExpr(r) {
    const style = r.int(0, 7);
    const month = r.pick(MONTHS);
    const day = r.chance(0.5) ? String(r.int(1, 31)) : r.pick(ORDINALS);
    const year = r.chance(0.5) ? ` ${r.int(1990, 2035)}` : "";
    if (style === 0) return `${month} ${day}${year}`;
    if (style === 1) return `${day} ${month}${year}`;
    if (style === 2) return `${r.int(2000, 2040)}-${pad2(r.int(1, 12))}-${pad2(r.int(1, 31))}`;
    if (style === 3) return `${r.int(1, 12)}/${r.int(1, 31)}${r.chance(0.5) ? `/${r.int(0, 99)}` : ""}`;
    if (style === 4) return `${r.int(2000, 2040)}-${pad2(r.int(1, 12))}-${pad2(r.int(1, 28))}T${pad2(r.int(0, 23))}:${pad2(r.int(0, 59))}:00Z`;
    if (style === 5) return `${month}${year}`;
    if (style === 6) return `the ${r.pick(ORDINALS)} of ${month}`;
    return `${r.pick(MODIFIERS)} ${r.pick(["week", "month", "year", "quarter"])}`;
}

function relativeExpr(r) {
    const n = r.chance(0.5) ? String(r.int(1, 30)) : r.pick(NUMBER_WORDS);
    const unit = r.pick(UNITS) + (r.chance(0.4) ? "s" : "");
    const style = r.int(0, 4);
    if (style === 0) return `in ${n} ${unit}`;
    if (style === 1) return `${n} ${unit} ago`;
    if (style === 2) return `${n} ${unit} later`;
    if (style === 3) return `within ${n} ${unit}`;
    return `${r.pick(["+", "-", "next ", "last "])}${n} ${unit}`;
}

function expression(r) {
    const kind = r.int(0, 9);
    if (kind <= 1) return casePerturb(r, r.pick(CASUAL));
    if (kind <= 3) return weekdayExpr(r);
    if (kind <= 5) return timeExpr(r);
    if (kind === 6) return `${weekdayExpr(r)}${r.pick([" at ", " ", ", "])}${timeExpr(r)}`;
    if (kind === 7) return `${casePerturb(r, r.pick(CASUAL))}${r.pick([" at ", " ", " "])}${timeExpr(r)}`;
    if (kind === 8) return dateExpr(r);
    return relativeExpr(r);
}

function phrase(r) {
    const [pre, post] = r.pick(FILLERS);
    let body = expression(r);
    // Range connectors too, so date-range merging (including reversed ranges) is exercised.
    if (r.chance(0.3)) body += r.pick([" and ", ", ", " or ", " then ", " - ", " to ", " until ", " through ", "-"]) + expression(r);
    if (r.chance(0.1)) body += ` ${r.pick(TIMEZONE_ABBRS)}`;
    return pre + body + post;
}

function referenceInstant(r) {
    const year = r.int(2000, 2040);
    const kind = r.int(0, 9);
    let month, day;
    if (kind === 0) {
        [month, day] = [1, r.int(28, 29)]; // Feb 28/29 (0-based month)
    } else if (kind === 1) {
        [month, day] = [11, 31]; // Dec 31
    } else if (kind === 2) {
        [month, day] = [0, 1]; // Jan 1
    } else if (kind === 3) {
        month = r.int(0, 11);
        day = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); // last day of month
    } else {
        month = r.int(0, 11);
        day = r.int(1, 28);
    }
    const hour = r.chance(0.3) ? r.pick([0, 23, 11, 12, 2, 6]) : r.int(0, 23);
    const t = Date.UTC(year, month, day, hour, r.int(0, 59), r.int(0, 59), r.chance(0.2) ? r.int(0, 999) : 0);
    return new Date(t).toISOString();
}

/** A request in the golden-case shape (see tests/golden/README.md). */
function request(r, id) {
    const config = r.pick(["en.casual", "en.casual", "en.casual", "en.strict", "en.GB.casual", "en.GB.strict"]);
    const instant = referenceInstant(r);
    const reference = r.chance(0.7)
        ? { kind: "date", instant, timezone_input: null }
        : { kind: "object", instant, timezone_input: r.chance(0.6) ? r.pick(TIMEZONE_ABBRS) : r.pick([-480, -300, 0, 60, 330, 540, 600]) };
    const options = r.chance(0.2) ? { forwardDate: true } : {};
    return { id, text: phrase(r), config, reference, system_timezone: "UTC", options };
}

function generate(seed, count) {
    const r = prng(seed);
    const out = [];
    for (let i = 0; i < count; i++) out.push(request(r, i));
    return out;
}

module.exports = { prng, generate };
