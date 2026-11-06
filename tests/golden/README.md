# Golden tests

Expected outputs recorded from the **real chrono-node** pinned in `upstream/` (see `upstream/PINNED.md`).

**Tier:** human. Agents can't edit this directory. It changes only when `upstream/` or `harness/golden/` changes, by regenerating:

```sh
cd harness && npm ci && npm run golden        # rewrite tests/golden/
cd harness && npm run golden:check            # fail if tests/golden is stale
```

## How the cases are made

- `harness/golden/generate.js` runs chrono-node's **own test files** (`upstream/test/*.test.ts` and `upstream/test/{en,de,fr,sv,pt,es,ja}/*.test.ts`, except the performance test) under jest, unmodified.
- `harness/golden/setup.js` records every `Chrono.prototype.parse` call those tests make: the input, the reference, the options and chrono-node's actual output. All 259 upstream tests must pass, or generation fails.
- The process time zone is forced to `UTC`. "Now" is frozen at `2012-08-10T12:00:00.000Z`. That date is used only where a test passes no reference date. Otherwise each test's own reference date is kept.
- Calls on configurations other than the named ones (four English, and `<lang>.casual` / `<lang>.strict` for `de`, `fr`, `sv`, `pt`, `es`, `ja`) (for example a test that adds a custom parser) are skipped and counted in `index.json`. So are calls whose options can't be written as JSON (custom timezone maps with functions).

## Layout

| Path | Contents |
|---|---|
| `index.json` | Upstream pin, defaults, and per-area case and skip counts |
| `configurations.json` | The exact parser and refiner order (with boolean flags) of every named configuration. The Rust configurations must match it. Step names are upstream class names, except the German and French `…TimeUnitRelativeFormatParser`, named after their file because their class names aren't unique. |
| `core/<name>.json` | Cases from `upstream/test/<name>.test.ts` |
| `<lang>/<name>.json` | Cases from `upstream/test/<lang>/<lang>_<name>.test.ts` (`en.test.ts` → `general`); `lang` is `en`, `de`, `fr`, `sv`, `pt`, `es` or `ja` |

## Case schema (`schema: 1`)

```jsonc
{
  "id": "en/weekday#01",            // stable within a generation: area + call order
  "text": "Monday",                 // the input string
  "config": "en.casual",            // en.casual | en.strict | en.GB.casual | en.GB.strict | <lang>.casual | <lang>.strict (de, fr, sv, pt, es, ja)
  "reference": {
    "kind": "date",                 // none (chrono used "now") | date (a Date) | object (a ParsingReference)
    "instant": "2012-08-09T00:00:00.000Z",  // always set: the resolved reference instant
    "timezone_input": null,         // ParsingReference.timezone as passed (string abbreviation or minutes), or null
    "timezone_offset": null         // what chrono resolved it to, in minutes, or null
  },
  "system_timezone": "UTC",         // the JS process time zone; always UTC
  "options": {},                    // ParsingOption without `debug` (for example {"forwardDate": true})
  "requires": {                     // what this case needs from the Rust crate
    "parsers": ["ENWeekdayParser"], // parsers that produced at least one result
    "refiners": []                  // refiners that changed the result list
  },
  "results": [{
    "index": 0,                     // UTF-16 code units, as JavaScript counts. Rust converts from bytes.
    "text": "Monday",
    "start": {
      "known":   {"weekday": 1},    // components chrono is certain of
      "implied": {"day": 6, "hour": 12, "millisecond": 0, "minute": 0, "month": 8, "second": 0, "year": 2012},
      "date": "2012-08-06T12:00:00.000Z",   // start.date() as UTC ISO, or null if invalid
      "tags": []                    // sorted
    },
    "end": null                     // same shape as start, or null
  }],
  "upstream_test": "Test - Single Expression"   // the jest test name, for tracing back
}
```

## How `requires` works

The generator re-runs each call step by step:

- a **parser** is listed if it returned at least one result
- a **refiner** is listed if the result list differed after it ran

A parser that found nothing, or a refiner that changed nothing, can't affect the output. So if the Rust crate registers every listed parser and refiner, it must produce exactly `results`. The Rust golden runner checks every such case and reports the rest as **pending**. As parsers and refiners are ported, cases move from pending to checked automatically, and a regression in any checked case fails CI.

### Pending cases are still checked step by step (golden frontier)

A pending case can't check the whole output, but it can check each **ported step** on it. `harness/golden/frontier.js` traces every case in chrono-node and in Rust (`chrono-rs-json --trace`) and compares:

- each ported parser's own results;
- each ported refiner run **alone on chrono-node's input for its slot** (`isolate`), so a refiner behind an unported step is still checked.

The earliest step that differs is blamed, with its task (from the contracts' `upstream_class`). CI fails on any blame, so a defective step fails its **own** PR instead of surfacing later in another task's PR, when its case's last required step lands (#397). If every step matches alone but a fully ported case's end results differ, the blame is `chain`: state the JSON shape doesn't carry between steps, for a person to look at.

`--complete` also fails if a generated locale whose task steps are all ported still has pending cases: a language counts as done only with 0 pending. `release.yml` runs `--complete --all`: a release has no pending case at all.

```sh
cargo build --bin chrono-rs-json && cd harness && npm ci && npm run build:upstream
TZ=UTC node golden/frontier.js --complete [--all] [--report frontier.json]
```
