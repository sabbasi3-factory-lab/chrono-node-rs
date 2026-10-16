# Porting guide

How to port a chrono-node parser or refiner to this crate. Copy the patterns here; they encode the traps we already hit. **This file changes only by reviewed PR.**

## 1. The task

Your contract (`contracts/<area>/<task>.yaml`) names the upstream file, the paths you may change, and the golden cases that must pass. The source is in `upstream/src/` at the pinned commit (`upstream/PINNED.md`). Never edit `upstream/`, `tests/golden/`, `contracts/`, `Cargo.toml`, `Cargo.lock` or `.github/`.

Port **behaviour, line by line**, not intent. The judge is chrono-node's real output, including its quirks.

## 2. Where files go

| Upstream | Rust |
|---|---|
| `src/locales/en/parsers/ENFooParser.ts` | `src/locales/en/parsers/foo.rs` |
| `src/locales/en/refiners/ENFooRefiner.ts` | `src/locales/en/refiners/foo.rs` |
| `src/common/parsers/FooParser.ts` | `src/common/parsers/foo.rs` |
| `src/common/refiners/FooRefiner.ts` | `src/common/refiners/foo.rs` |
| `src/calculation/*.ts` | `src/calculation/*.rs` |
| `src/utils/*.ts` | `src/core/utils/*.rs` |

**Don't edit any `mod` list or registry.** `build.rs` registers every `.rs` file in a `parsers/` or `refiners/` directory. A file whose name starts with `_` is skipped, so you can use one for helpers. The configuration (`src/locales/en/configuration.rs`) already has a slot for every upstream step. Your file fills the slot whose name equals your `UPSTREAM` constant.

## 3. The shape of a parser file

```rust
//! upstream `locales/en/parsers/ENWeekdayParser.ts`.

pub const UPSTREAM: &str = "ENWeekdayParser";          // exact upstream class name

pub fn create(flags: &Flags) -> Box<dyn Parser> {       // flags = upstream constructor args
    Box::new(WithWordBoundary::new(EnWeekdayParser))     // wrapper = upstream base class
}
```

| Upstream base class | Rust |
|---|---|
| `AbstractParserWithWordBoundaryChecking` | implement `WordBoundaryParser` (`inner_pattern`, `inner_extract`) and wrap it in `WithWordBoundary` |
| `AbstractTimeExpressionParser` | implement `TimeExpressionParser` and wrap it in `TimeExpression`. `super.x(...)` calls become `time_expression::x(...)`. |
| plain `Parser` | implement `Parser` (`pattern`, `extract`) directly |
| `Refiner` | implement `Refiner::refine(&self, context, Vec<ParsingResult>) -> Vec<ParsingResult>` |

Constructor arguments come from `flags.get("strictMode")` and so on, using upstream's property names. Examples to copy: `parsers/casual_date.rs` (simple), `parsers/weekday.rs` (dictionary + modifiers), `parsers/time_expression.rs` (abstract base with overrides).

`extract` returns `Extracted::None` (upstream `null`), `Components`, `Result` or `Known(vec![...])` (upstream's plain `{day: 1}` object).

## 4. Regular expressions (trap: lookahead)

- Keep patterns **as the JS source text**, in a raw string, and pass the JS flags. Use `JsRegex::new(source, "i")`, or `js_regex!(r"...", "i")` for a lazy `&'static` one.
- `JsRegex` runs on `fancy-regex`, so lookahead `(?=...)`, lookbehind and backreferences work. It also translates JS semantics: `\d`, `\w` and `\b` are ASCII-only, `\s` is JS's set, `.` excludes line terminators, and escaped non-ASCII like `\–` is a literal. Don't hand-translate any of these.
- A JS string `"\\s*"` becomes the raw Rust string `r"\s*"`. With `format!`, double the braces of quantifiers: `\d{{1,2}}`.
- Patterns built from dictionaries: `match_any_pattern(dict_keys(DICT))`. Dictionaries are `(key, value)` slices **in upstream key order**, because the stable longest-first sort depends on it. `src/locales/en/constants.rs` already has every English dictionary and helper (`parse_number_pattern`, `parse_ordinal_number_pattern`, `parse_year`, `parse_duration`, `TIME_UNITS_PATTERN`, ...).
- Upstream `str.match(/x/)` as a condition becomes `js_regex!(r"x").is_match(s)`. `re.exec(s)` becomes `.exec(s)`, which returns a `RegexMatch` whose `get(i)` is `Option<&str>` (`None` = `undefined`).

## 5. Strings and indexes (trap: string length)

- Inside the crate, `index` is a **byte** offset into `context.text`. JSON output converts it to UTF-16, as JS counts. So upstream index arithmetic (`match.index + match[0].length`) uses byte lengths (`m.text().len()`).
- Where upstream uses `.length` as a *count* (comparisons, sorting), use `js_len(s)` (UTF-16 units). `js_substring_from(s, n)` takes UTF-16 units.
- Use `core::utils::js`: `js_parse_int` (`parseInt("12px")` = 12; `None` is `NaN`), `js_parse_float`, `js_trim` (also strips U+FEFF).
- JS truthiness: `if (match[3])` is false for both `undefined` and `""`. Write `m.get(3).is_some_and(|s| !s.is_empty())`. `x != null` is `m.get(3).is_some()`.

## 6. Dates and time zones (trap: JS vs Rust time zones)

- Never use `chrono` or system-time APIs for date maths. Use `JsDate`: it reproduces JS `Date` arithmetic (`setDate`/`setMonth` overflow, `new Date(y, m, d)` mapping 0–99 to 1900s, time clipping to an invalid date).
- **One known difference:** on an invalid date, JS getters return `NaN`, but `JsDate` getters (`get_date`, `get_hours`, ...) return `0`. Where upstream might read fields of a possibly invalid date, check `date.get_time().is_some()` first and reproduce the upstream `NaN` behaviour explicitly (`NaN` comparisons are false; `NaN` arithmetic stays `NaN`).
- **The system time zone is always UTC** (golden data is recorded under `TZ=UTC`). JS local getters (`getHours`) are `JsDate::get_hours`, and so on.
- A reference's own time zone is handled by `ReferenceWithTimezone`, exactly as upstream: `context.reference.get_date_with_adjusted_timezone()`, `get_timezone_offset()`. Port these calls one-to-one.
- `addDuration`, `addDurationAsImplied` and `createRelativeFromReference` **mutate the duration** they get (short keys renamed, fractions cascaded), so they take `&mut Duration`. If upstream reuses the duration after the call, so must you.
- Comparisons on dates (`a.getTime() < b.getTime()`) are false when either is `NaN`. Match on `get_time()` returning `Some`.

## 7. Components

- `ParsingComponents::get(c)` is `Option<i64>` (`None` = JS `null`). Where upstream does arithmetic on a possibly null value, `get_or_zero` reproduces JS `null + 1 == 1`.
- `imply` never overrides a known value; `assign` does. Known and implied maps keep JS insertion order.
- Tags: add the same tags upstream adds (`"parser/ENFooParser"`). Golden data compares tags.

## 8. Checking your work

```sh
cargo fmt && cargo clippy --all-targets -- -D warnings
cargo test                                                  # unit tests, configuration order, golden suite
GOLDEN_AREAS=en/weekday cargo test --test golden -- --nocapture
GOLDEN_AREAS=en/weekday GOLDEN_REQUIRE_ALL=1 cargo test --test golden   # what your contract requires
cargo build --bin chrono-rs-json && (cd harness && npm ci && npm run build:upstream && npm run compare -- --phrases 3000)
```

The golden suite checks every case whose `requires` are all ported. When you add a parser, cases that need it move from *pending* to *checked*, and they must pass. CI also runs the comparison with a seed you can't see.

## 9. Lessons learned

| # | Lesson | Where |
|---|---|---|
| 1 | chrono searches the **remaining substring** after each match. `^` and lookbehinds see that slice's start, not the text's. The engine does this for you; don't "fix" it. | `core/chrono.rs` |
| 2 | An extractor may move `m.index` before returning `None` to choose where the search resumes (`AbstractTimeExpressionParser` skips 4 chars for year-like text). Port those lines too. | `common/time_expression.rs` |
| 3 | `AbstractParserWithWordBoundaryChecking` shifts groups down by one **without shrinking** the array. The last group is duplicated. Indexes in `inner_extract` are the upstream ones. | `common/word_boundary.rs` |
| 4 | Port all of a shared constants file at once. Otherwise every parser task edits it and parallel tasks conflict. | `locales/en/constants.rs` |
| 5 | Test expectations come from chrono-node, not from reasoning. To check a helper, compile upstream (`npm run build:upstream`) and call the function in Node. Two of our own hand-written expectations were wrong. | `constants.rs` tests |
| 6 | Mutation-check the checks: plant a bug and confirm the golden suite or comparison fails. Some mutations are equivalent (for example `<` vs `<=` where equality can't happen); they prove nothing. | PRs #4–#6 |
| 7 | JS `%` keeps the dividend's sign, like Rust's `%`. Use `rem_euclid` only where upstream does something different. | `parsers/weekday.rs` |
| 8 | `endsWith`, `===` and dictionary lookups are case-sensitive in upstream even when the regex has the `i` flag. Keep them case-sensitive. | `parsers/time_expression.rs` |
| 9 | Touch **only** the file in the contract's `scope`. The trusted `gates` check lists every violation: a protected path (even a moved or renamed file), an out-of-scope path, or a stale `Contract-SHA`. A failed `gates` run goes to a human; it is never repaired. | `harness/gates/scope.js` (#18) |
