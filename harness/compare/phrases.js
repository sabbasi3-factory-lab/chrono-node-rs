"use strict";
// Seeded random phrase generator for the comparison harness.
//
// Phrases mix everyday English date/time expressions (casual words, weekdays, times, months,
// relative units, numeric formats) with filler text, punctuation, case changes and a little
// non-ASCII text (to exercise UTF-16 vs byte indexes). Reference dates are random in 2000-2040,
// biased towards month ends, year ends and Feb 28/29.
//
// `generate(seed, n)` returns n English requests, then n each of German, French, Swedish,
// Portuguese, Spanish and Japanese. Each language has its own random stream (seeded by its fixed
// position), so the requests of the earlier languages for a seed are the same as before later
// languages were added.

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

// --- German and French (same shape: expression + range connector + filler) ---

const LANGS = {
    de: {
        configs: ["de.casual", "de.casual", "de.casual", "de.strict"],
        casual: ["jetzt", "heute", "morgen", "übermorgen", "uebermorgen", "gestern", "vorgestern", "letzte Nacht", "heute Abend", "morgen früh", "gestern Nachmittag", "heute Mitternacht"],
        partOfDay: ["morgen", "vormittag", "mittag", "mittags", "nachmittag", "abend", "nacht", "mitternacht", "diesen Abend"],
        weekdays: ["Sonntag", "So", "Montag", "Mo", "Dienstag", "Di", "Mittwoch", "Mi", "Donnerstag", "Do", "Freitag", "Fr", "Samstag", "Sa"],
        weekdayPrefix: ["am ", "an ", "", "(", ", "],
        weekdayModifiers: ["diesen", "letzten", "nächsten", "naechsten", "diesem", "letztem"],
        weekdaySuffix: [" diese Woche", " letzte Woche", " nächste Woche"],
        months: ["Januar", "Jänner", "Jan", "Jan.", "Februar", "Feb", "März", "Maerz", "Mär.", "Mrz", "April", "Apr.", "Mai", "Juni", "Jun", "Juli", "Jul.", "August", "Aug", "September", "Sept.", "Oktober", "Okt", "November", "Nov.", "Dezember", "Dez"],
        day: (r) => `${r.int(1, 31)}.`,
        dayRange: [" bis ", "-", " – ", " bis zum "],
        years: (r) => r.pick([String(r.int(1990, 2035)), String(r.int(10, 99)), `${r.int(1, 2000)} v. Chr.`, `${r.int(1, 2000)} n. Chr.`, `${r.int(1, 2000)} uZ`, `${r.int(1, 2000)} d. g. Z.`]),
        timePrefix: ["um ", "von ", "Um ", ""],
        timeSuffix: [" Uhr", "h", " morgens", " vormittags", " nachmittags", " abends", " nachts", " am Morgen", " am Abend", " in der Nacht", " Uhr abends"],
        timeRange: [" - ", "-", " bis ", " bis um ", "~", " – "],
        numbers: ["eins", "eine", "einem", "einen", "einer", "zwei", "drei", "fünf", "zehn", "zwölf", "halbe", "einigen", "wenigen", "mehreren"],
        units: ["Sekunden", "Sek", "Minute", "Minuten", "min", "Stunde", "Stunden", "Std", "h", "Tag", "Tage", "Tagen", "Woche", "Wochen", "Monat", "Monate", "Monaten", "Quartal", "Jahr", "Jahre", "Jahren", "J"],
        relative: (r, n, unit) => {
            const mod = r.pick(["nächste", "nächsten", "kommende", "folgenden", "letzte", "letzten", "vergangene", "vorigen", "vorhergegangene"]);
            return r.pick([`in ${n} ${unit}`, `vor ${n} ${unit}`, `für ${n} ${unit}`, `während ${n} ${unit}`, `${mod} ${unit}`, `${n} ${mod} ${unit}`, `${mod} ${n} ${unit}`, `innerhalb von ${n} ${unit}`]);
        },
        dateConnectors: [" um ", " am ", ", ", " - ", " ", "T"],
        rangeConnectors: [" bis ", " bis zum ", " bis am ", " - ", "-", " und ", ", "],
        fillers: [["", ""], ["Die Deadline ist ", "."], ["Treffen wir uns ", "?"], ["Termin: ", ""], ["Ich war ", " dort."], ["(", ")"], ["Bis ", " 😀"], ["Rückruf ", "\n danke"]],
    },
    fr: {
        configs: ["fr.casual", "fr.casual", "fr.casual", "fr.strict"],
        casual: ["maintenant", "aujourd'hui", "demain", "hier", "cette nuit", "la veille", "ce soir", "ce matin", "cet après-midi", "demain matin", "hier soir", "à midi", "minuit"],
        partOfDay: ["matin", "soir", "après-midi", "aprem", "midi", "minuit", "nuit"],
        weekdays: ["dimanche", "dim", "lundi", "lun", "mardi", "mar", "mercredi", "mer", "jeudi", "jeu", "vendredi", "ven", "samedi", "sam"],
        weekdayPrefix: ["", "(", ", ", "le "],
        weekdayModifiers: ["ce", "cette", "le"],
        weekdaySuffix: [" prochain", " dernier", " suivant", " précédent", " cette semaine", " la semaine prochaine", " la semaine dernière"],
        months: ["janvier", "janv.", "Jan", "février", "févr.", "fevrier", "mars", "Mar.", "avril", "avr", "mai", "juin", "juillet", "juil.", "août", "aout", "septembre", "sept.", "octobre", "oct", "novembre", "nov.", "décembre", "decembre", "déc."],
        day: (r) => (r.chance(0.2) ? "1er" : String(r.int(1, 31))),
        dayRange: [" au ", "-", " – ", " jusqu'au "],
        years: (r) => r.pick([String(r.int(1990, 2035)), String(r.int(50, 99)), `${r.int(1, 2000)} AC`, `${r.int(1, 2000)} AD`, `${r.int(1, 2000)} p. Chr. n.`]),
        timePrefix: ["à ", "a ", "À ", ""],
        timeSuffix: ["h", " AM", " PM", " A.M.", " P.M.", "h du matin", " du soir", " heures"],
        timeRange: [" - ", "-", " à ", "~", " – "],
        numbers: ["un", "une", "deux", "trois", "cinq", "dix", "douze", "treize", "quelques", "demi"],
        units: ["sec", "seconde", "secondes", "min", "minute", "minutes", "h", "heure", "heures", "jour", "jours", "semaine", "semaines", "mois", "trimestre", "ans", "année", "années"],
        relative: (r, n, unit) => {
            const mod = r.pick(["prochain", "prochaine", "prochains", "dernier", "dernière", "derniers", "passé", "passée", "précédent", "suivante"]);
            return r.pick([`dans ${n} ${unit}`, `il y a ${n} ${unit}`, `pendant ${n} ${unit}`, `pour ${n} ${unit}`, `en ${n} ${unit}`, `la ${unit} ${mod}`, `les ${n} ${unit} ${mod}`, `le ${mod} ${unit}`, `l'${unit} ${mod}`, `des ${n} ${unit}`]);
        },
        dateConnectors: [" à ", " a ", " vers ", " au ", ", ", " - ", " ", "T"],
        rangeConnectors: [" au ", " à ", " jusqu'au ", " - ", "-", " et ", ", "],
        fillers: [["", ""], ["La deadline est ", "."], ["On se voit ", " ?"], ["Rendez-vous ", " à Paris"], ["J'étais là ", "."], ["(", ")"], ["café ", " 😀"], ["Rappel ", "\n merci"]],
    },
    sv: {
        configs: ["sv.casual", "sv.casual", "sv.casual", "sv.strict"],
        casual: ["nu", "idag", "imorgon", "imorn", "övermorgon", "igår", "förrgår", "i förrgår", "idag på morgonen", "igår kväll", "imorgon eftermiddag", "idag midnatt", "nu på natten"],
        partOfDay: ["morgonen", "förmiddagen", "middag", "eftermiddagen", "kvällen", "natten", "midnatt"],
        weekdays: ["söndag", "sön", "so", "måndag", "mån", "må", "tisdag", "tis", "ti", "onsdag", "ons", "on", "torsdag", "tors", "to", "fredag", "fre", "fr", "lördag", "lör", "lö"],
        weekdayPrefix: ["", "på ", "(", ", ", "i "],
        weekdayModifiers: ["denna", "förra", "nästa", "kommande", "senaste"],
        weekdaySuffix: [" denna vecka", " förra veckan", " nästa vecka"],
        months: ["januari", "jan", "jan.", "februari", "feb", "mars", "mar.", "april", "apr", "maj", "juni", "jun.", "juli", "jul", "augusti", "aug.", "september", "sep", "sept", "oktober", "okt.", "november", "nov", "december", "dec."],
        day: (r) => (r.chance(0.2) ? r.pick(["första", "andra", "tredje", "tjugoförsta", "trettionde"]) : `${r.int(1, 31)}${r.chance(0.2) ? ":e" : ""}`),
        dayRange: [" - ", "-", " till ", " – "],
        years: (r) => r.pick([String(r.int(1990, 2035)), String(r.int(10, 99)), `${r.int(1, 2000)} f.Kr.`, `${r.int(1, 2000)} e.Kr.`]),
        timePrefix: ["kl ", "kl. ", "klockan ", ""],
        timeSuffix: [" på morgonen", " på kvällen", "h", " fm", " em"],
        timeRange: [" - ", "-", " till ", "–"],
        numbers: ["en", "ett", "två", "tre", "fem", "tio", "tolv", "tjugo", "trettiо", "några", "ett par"],
        units: ["sek", "sekund", "sekunder", "min", "minut", "minuter", "tim", "timme", "timmar", "dag", "dagar", "vecka", "veckor", "mån", "månad", "månader", "år", "kvartal", "kvartаl"],
        relative: (r, n, unit) => {
            const mod = r.pick(["nästa", "kommande", "förra", "senaste", "föregående", "denna", "detta"]);
            return r.pick([`om ${n} ${unit}`, `för ${n} ${unit} sedan`, `${mod} ${unit}`, `${mod} ${n} ${unit}`, `inom ${n} ${unit}`, `${n} ${unit} sedan`, `under ${n} ${unit}`]);
        },
        dateConnectors: [" kl ", " klockan ", ", ", " - ", " ", "T", " den "],
        rangeConnectors: [" till ", " - ", "-", " och ", ", "],
        fillers: [["", ""], ["Mötet är ", "."], ["Ses vi ", "?"], ["Deadline: ", ""], ["Jag var där ", "."], ["(", ")"], ["Fika ", " 😀"], ["Ring ", "\n tack"]],
    },
    pt: {
        configs: ["pt.casual", "pt.casual", "pt.casual", "pt.strict"],
        casual: ["agora", "hoje", "amanhã", "amanha", "ontem", "esta manhã", "esta tarde", "esta noite", "meia-noite", "meio-dia", "manhã", "tarde", "noite", "hoje à noite", "amanhã de manhã"],
        partOfDay: ["manhã", "manha", "tarde", "noite", "meia-noite", "meio-dia"],
        weekdays: ["domingo", "dom", "segunda", "segunda-feira", "seg", "terça", "terça-feira", "ter", "quarta", "quarta-feira", "qua", "quinta", "quinta-feira", "qui", "sexta", "sexta-feira", "sex", "sábado", "sabado", "sab"],
        weekdayPrefix: ["", "na ", "no ", "(", ", ", "em "],
        weekdayModifiers: ["esta", "este", "próxima", "proxima", "próximo", "passada", "passado", "última", "ultimo"],
        weekdaySuffix: [" que vem", " passada", " passado", " próxima", " anterior"],
        months: ["janeiro", "jan", "jan.", "fevereiro", "fev", "março", "mar.", "abril", "abr", "maio", "mai.", "junho", "jun", "julho", "jul.", "agosto", "ago", "setembro", "set.", "outubro", "out", "novembro", "nov.", "dezembro", "dez"],
        day: (r) => String(r.int(1, 31)),
        dayRange: [" a ", "-", " – ", " até ", " ao "],
        years: (r) => r.pick([String(r.int(1990, 2035)), String(r.int(10, 99)), `${r.int(1, 2000)} AC`, `${r.int(1, 2000)} a.c.`, `${r.int(1, 2000)} d.c.`, `${r.int(1, 2000)} AD`]),
        timePrefix: ["às ", "as ", "à ", "a ", "ao ", "das ", "da ", "de ", "do ", ""],
        timeSuffix: ["h", " AM", " PM", " horas", " da manhã", " da tarde", " da noite"],
        timeRange: [" - ", "-", " a ", " ao ", "~", " – "],
        numbers: ["um", "uma", "dois", "duas", "três", "cinco", "dez", "doze", "alguns"],
        units: ["segundo", "segundos", "min", "minuto", "minutos", "h", "hora", "horas", "dia", "dias", "semana", "semanas", "mês", "meses", "ano", "anos"],
        relative: (r, n, unit) => r.pick([`em ${n} ${unit}`, `há ${n} ${unit}`, `${n} ${unit} atrás`, `daqui a ${n} ${unit}`, `dentro de ${n} ${unit}`, `próximo ${unit}`, `${unit} passado`]),
        dateConnectors: [" às ", " as ", " a ", ", ", " - ", " ", "T", " de "],
        rangeConnectors: [" a ", " até ", " ao ", " - ", "-", " e ", ", "],
        fillers: [["", ""], ["O prazo é ", "."], ["Vamos nos ver ", "?"], ["Reunião: ", ""], ["Eu estive lá ", "."], ["(", ")"], ["café ", " 😀"], ["Ligar ", "\n obrigado"]],
    },
    es: {
        configs: ["es.casual", "es.casual", "es.casual", "es.strict"],
        casual: ["ahora", "hoy", "mañana", "manana", "ayer", "esta mañana", "esta tarde", "esta noche", "medianoche", "mediodía", "mediodia", "noche", "a la mañana", "en la tarde", "mañana por la tarde"],
        partOfDay: ["mañana", "tarde", "noche", "medianoche", "mediodía"],
        weekdays: ["domingo", "dom", "lunes", "lun", "martes", "mar", "miércoles", "miercoles", "mié", "mie", "jueves", "jue", "viernes", "vie", "sábado", "sabado", "sáb", "sab"],
        weekdayPrefix: ["", "el ", "(", ", ", "este "],
        weekdayModifiers: ["este", "esta", "próximo", "proximo", "pasado", "último", "ultimo"],
        weekdaySuffix: [" que viene", " pasado", " próximo", " anterior"],
        months: ["enero", "ene", "ene.", "febrero", "feb", "marzo", "mar.", "abril", "abr", "mayo", "may.", "junio", "jun", "julio", "jul.", "agosto", "ago", "septiembre", "setiembre", "sep.", "octubre", "oct", "noviembre", "nov.", "diciembre", "dic"],
        day: (r) => (r.chance(0.2) ? r.pick(["primero", "1º", "2ª", "tercero", "vigésimo primero", "decimoquinto"]) : String(r.int(1, 31))),
        dayRange: [" a ", "-", " – ", " al ", " hasta "],
        years: (r) => r.pick([String(r.int(1990, 2035)), String(r.int(10, 99)), `${r.int(1, 2000)} AC`, `${r.int(1, 2000)} a.c.`, `${r.int(1, 2000)} d.c.`, `${r.int(1, 2000)} AD`]),
        timePrefix: ["a las ", "a la ", "las ", "la ", "de ", "desde ", ""],
        timeSuffix: ["h", " AM", " PM", " horas", " de la mañana", " de la tarde", " de la noche"],
        timeRange: [" - ", "-", " a ", " a las ", "~", " – "],
        numbers: ["un", "uno", "una", "dos", "tres", "cinco", "diez", "doce", "trece", "algunos", "unos"],
        units: ["sec", "segundo", "segundos", "min", "mins", "minuto", "minutos", "h", "hr", "hora", "horas", "día", "dias", "semana", "semanas", "mes", "meses", "cuarto", "año", "años", "anos"],
        relative: (r, n, unit) => r.pick([`en ${n} ${unit}`, `dentro de ${n} ${unit}`, `hace ${n} ${unit}`, `durante ${n} ${unit}`, `por ${n} ${unit}`, `${n} ${unit}`, `el próximo ${unit}`, `la ${unit} pasada`]),
        dateConnectors: [" a las ", " a la ", " de ", ", ", " - ", " ", "T", " en "],
        rangeConnectors: [" a ", " al ", " hasta ", " - ", "-", " y ", ", "],
        fillers: [["", ""], ["La fecha límite es ", "."], ["¿Nos vemos ", "?"], ["Cita: ", ""], ["Estuve allí ", "."], ["(", ")"], ["café ", " 😀"], ["Llamar ", "\n gracias"], ["Nos vemos en la ", ""], ["Llegamos a la ", ""]],
    },
};

// --- Japanese: no spaces, kanji/full-width numerals and its own date and time grammar ---

const JA_KANJI = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "二十", "二十三", "三十", "〇", "零", "十五"];
const toZenkaku = (s) => s.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 65248));

function jaNum(r, lo, hi) {
    const n = String(r.int(lo, hi));
    const style = r.int(0, 5);
    if (style === 0) return toZenkaku(n);
    if (style === 1) return r.pick(JA_KANJI);
    return n;
}

function jaDate(r) {
    const style = r.int(0, 5);
    if (style <= 2) {
        let y = "";
        const ys = r.int(0, 5);
        if (ys === 1) y = `${jaNum(r, 1990, 2035)}年`;
        else if (ys === 2) y = `${r.pick(["令和", "平成", "昭和"])}${r.chance(0.2) ? "元" : jaNum(r, 1, 64)}年`;
        else if (ys === 3) y = `${r.pick(["同", "今", "本"])}年`;
        return `${y}${r.chance(0.3) ? " " : ""}${jaNum(r, 1, 12)}月${r.chance(0.2) ? " " : ""}${jaNum(r, 1, 31)}日`;
    }
    if (style === 3) return `${r.chance(0.5) ? `${jaNum(r, 1990, 2035)}/` : ""}${jaNum(r, 1, 12)}/${jaNum(r, 1, 31)}`;
    if (style === 4) return `${r.pick(["令和", "平成", "昭和", ""])}${jaNum(r, 1, 40)}/${jaNum(r, 1, 12)}/${jaNum(r, 1, 31)}`;
    return `${r.int(2000, 2040)}-${pad2(r.int(1, 12))}-${pad2(r.int(1, 28))}`;
}

function jaTime(r) {
    let s = r.chance(0.3) ? r.pick(["午前", "午後", "AM", "PM", "A.M.", "P.M."]) : "";
    if (r.chance(0.2)) s += r.pick(["", " ", "、", "，"]);
    s += jaNum(r, 0, 24);
    s += r.pick(["時", "時", ":", "："]);
    if (r.chance(0.6)) s += r.chance(0.2) ? "半" : `${jaNum(r, 0, 59)}${r.pick(["分", "", ":"])}`;
    if (r.chance(0.15)) s += `${jaNum(r, 0, 59)}秒`;
    if (r.chance(0.1)) s += r.pick(["AM", "PM", "A.M.", "P.M.", "A", "P"]);
    if (r.chance(0.25)) s += `${r.pick(["から", "-", "–", "－", "~", "〜", "ー"])}${r.chance(0.3) ? r.pick(["午前", "午後"]) : ""}${jaNum(r, 0, 24)}${r.pick(["時", ":"])}${r.chance(0.5) ? `${jaNum(r, 0, 59)}分` : ""}`;
    return s;
}

function jaWeekday(r) {
    const d = r.pick(["日", "月", "火", "水", "木", "金", "土"]);
    if (r.chance(0.3)) return r.pick(["(", "（"]) + d + r.pick([")", "）"]);
    const pre = r.chance(0.4) ? r.pick(["今週", "先週", "来週", "前の", "次の", "今週の", "先週の", "来週の"]) : "";
    return `${pre}${d}曜${r.chance(0.8) ? "日" : ""}`;
}

function jaExpression(r) {
    const kind = r.int(0, 8);
    if (kind <= 1) return r.pick(["今日", "きょう", "本日", "ほんじつ", "昨日", "きのう", "明日", "あした", "今夜", "こんや", "今夕", "こんゆう", "今晩", "こんばん", "今朝", "けさ"]);
    if (kind === 2) return jaWeekday(r);
    if (kind <= 4) return jaTime(r);
    if (kind === 5) return `${jaDate(r)}${r.pick(["", "の", " ", "、", ","])}${jaWeekday(r)}`;
    if (kind === 6) return `${jaDate(r)}${r.pick(["", "の", " "])}${jaTime(r)}`;
    if (kind === 7) return `${r.pick(["今日", "明日", "昨日"])}${r.pick(["", "の"])}${jaTime(r)}`;
    return jaDate(r);
}

function jaRequest(r, id) {
    const [pre, post] = r.pick([["", ""], ["会議は", "です。"], ["", "に会いましょう"], ["締切：", ""], ["主な株主（", "現在）"], ["予定 ", " 😀"], ["", "\nよろしく"]]);
    let body = jaExpression(r);
    if (r.chance(0.3)) body += r.pick(["から", "ー", "－", "-", "～", "~", "、"]) + jaExpression(r);
    if (r.chance(0.05)) body += ` ${r.pick(TIMEZONE_ABBRS)}`;
    const config = r.pick(["ja.casual", "ja.casual", "ja.casual", "ja.strict"]);
    const instant = referenceInstant(r);
    const reference = r.chance(0.7)
        ? { kind: "date", instant, timezone_input: null }
        : { kind: "object", instant, timezone_input: r.chance(0.6) ? r.pick(TIMEZONE_ABBRS) : r.pick([-480, -300, 0, 60, 330, 540, 600]) };
    const options = r.chance(0.2) ? { forwardDate: true } : {};
    return { id, text: pre + body + post, config, reference, system_timezone: "UTC", options };
}

function localTime(r, L) {
    let s = r.chance(0.4) ? r.pick(L.timePrefix) : "";
    const style = r.int(0, 4);
    if (style === 0) s += String(r.int(0, 24));
    else if (style === 1) s += `${r.int(0, 24)}:${pad2(r.int(0, 59))}`;
    else if (style === 2) s += `${r.int(0, 23)}h${r.chance(0.5) ? pad2(r.int(0, 59)) : ""}`;
    else if (style === 3) s += `${r.int(0, 23)}:${pad2(r.int(0, 59))}:${pad2(r.int(0, 59))}`;
    else s += `${r.int(0, 23)}h${pad2(r.int(0, 59))}m${pad2(r.int(0, 59))}s`;
    if (r.chance(0.5)) s += r.pick(L.timeSuffix);
    if (r.chance(0.2)) {
        s += r.pick(L.timeRange) + String(r.int(0, 24));
        if (r.chance(0.5)) s += `:${pad2(r.int(0, 59))}`;
        if (r.chance(0.4)) s += r.pick(L.timeSuffix);
    }
    return s;
}

function localWeekday(r, L) {
    let s = r.pick(L.weekdayPrefix);
    if (r.chance(0.3)) s += r.pick(L.weekdayModifiers) + " ";
    s += casePerturb(r, r.pick(L.weekdays));
    if (r.chance(0.3)) s += r.pick(L.weekdaySuffix);
    return s;
}

function localDate(r, L) {
    const style = r.int(0, 4);
    const year = r.chance(0.5) ? `${r.pick([" ", ", ", "-", "/"])}${L.years(r)}` : "";
    if (style <= 1) return `${L.day(r)} ${casePerturb(r, r.pick(L.months))}${year}`;
    if (style === 2) return `${L.day(r)}${r.pick(L.dayRange)}${L.day(r)} ${r.pick(L.months)}${year}`;
    if (style === 3) return `${r.int(1, 31)}/${r.int(1, 12)}${r.chance(0.5) ? `/${r.int(0, 99)}` : ""}`;
    return `${r.int(2000, 2040)}-${pad2(r.int(1, 12))}-${pad2(r.int(1, 28))}${r.chance(0.5) ? `T${pad2(r.int(0, 23))}:${pad2(r.int(0, 59))}` : ""}`;
}

function localRelative(r, L) {
    const n = r.chance(0.5) ? String(r.int(1, 30)) : r.pick(L.numbers);
    return L.relative(r, n, r.pick(L.units));
}

function localExpression(r, L) {
    const kind = r.int(0, 9);
    if (kind <= 1) return casePerturb(r, r.pick(L.casual));
    if (kind === 2) return casePerturb(r, r.pick(L.partOfDay));
    if (kind === 3) return localWeekday(r, L);
    if (kind <= 5) return localTime(r, L);
    if (kind === 6) return `${localWeekday(r, L)}${r.pick(L.dateConnectors)}${localTime(r, L)}`;
    if (kind === 7) return `${localDate(r, L)}${r.pick(L.dateConnectors)}${localTime(r, L)}`;
    if (kind === 8) return localDate(r, L);
    return localRelative(r, L);
}

function localRequest(r, L, id) {
    const [pre, post] = r.pick(L.fillers);
    let body = localExpression(r, L);
    if (r.chance(0.3)) body += r.pick(L.rangeConnectors) + localExpression(r, L);
    if (r.chance(0.1)) body += ` ${r.pick(TIMEZONE_ABBRS)}`;
    const config = r.pick(L.configs);
    const instant = referenceInstant(r);
    const reference = r.chance(0.7)
        ? { kind: "date", instant, timezone_input: null }
        : { kind: "object", instant, timezone_input: r.chance(0.6) ? r.pick(TIMEZONE_ABBRS) : r.pick([-480, -300, 0, 60, 330, 540, 600]) };
    const options = r.chance(0.2) ? { forwardDate: true } : {};
    return { id, text: pre + body + post, config, reference, system_timezone: "UTC", options };
}

/** count English requests (ids 0..count-1), then count of each other language, in this order. */
const LANG_ORDER = ["de", "fr", "sv", "pt", "es", "ja"];

function generate(seed, count) {
    const r = prng(seed);
    const out = [];
    for (let i = 0; i < count; i++) out.push(request(r, i));
    for (const [k, lang] of LANG_ORDER.entries()) {
        // A separate stream per language (fixed seed offset by position), so earlier languages are unchanged.
        const lr = prng((seed ^ (0x9e3779b9 * (k + 1))) >>> 0);
        for (let i = 0; i < count; i++) {
            const id = (k + 1) * count + i;
            out.push(lang === "ja" ? jaRequest(lr, id) : localRequest(lr, LANGS[lang], id));
        }
    }
    return out;
}

module.exports = { prng, generate };
