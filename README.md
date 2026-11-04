# chrono-node-rs

A Rust port of [chrono-node](https://github.com/wanasit/chrono), the JavaScript library that finds dates and times in plain text ("tomorrow at 5pm", "next Friday at noon"). The port follows upstream closely, file by file, and must give the same answers.

It ports a pinned upstream release: chrono-node `v2.10.3` (commit `d4fe7e3`). The copy is kept unmodified in [`upstream/`](upstream/); see [`upstream/PINNED.md`](upstream/PINNED.md).

## Status

As of 2026-11-04, 3 of chrono-node's 16 locales are ported, plus the shared code:

| Locales | State |
|---|---|
| Common code, `en`, `de`, `fr` | Merged (contracts in [`contracts/`](contracts/), code in [`src/locales/`](src/locales/)) |
| `sv`, `pt`, `es`, `ja` | Wave 1, in progress ([#208](https://github.com/sabbasi3-factory-lab/chrono-node-rs/pull/208), [#209](https://github.com/sabbasi3-factory-lab/chrono-node-rs/pull/209)) |
| `ar`, `fi`, `id`, `it`, `nl`, `ru`, `uk`, `vi`, `zh` | Planned |

These counts change as each wave lands. The crate isn't published to crates.io yet.

## Usage

```rust
use chrono_node::{configuration, parse, parse_date, JsDate, ParsingOption, ReferenceInput};

let reference = ReferenceInput::Date(JsDate::parse_iso("2012-08-10T09:00:00.000Z").unwrap());

// English (casual), like chrono.parseDate and chrono.parse
let date = parse_date("tomorrow at 5pm", &reference).unwrap();
assert_eq!(date.to_iso_string().unwrap(), "2012-08-11T17:00:00.000Z");

let results = parse("Let's meet next Friday at noon", &reference);
assert_eq!(results[0].text, "next Friday at noon");
assert_eq!(results[0].date().to_iso_string().unwrap(), "2012-08-17T12:00:00.000Z");

// Other locales by name: "de.casual", "fr.strict", "en.GB.casual", ...
let de = configuration("de.casual").unwrap();
let results = de.parse("morgen um 10 Uhr", &reference, &ParsingOption::default());
assert_eq!(results[0].date().to_iso_string().unwrap(), "2012-08-11T10:00:00.000Z");
```

The system time zone is always UTC: a reference without a time zone is read as UTC. How the JavaScript is translated, and why, is in [`PORTING.md`](PORTING.md).

## Build and test

Needs the Rust toolchain in [`rust-toolchain.toml`](rust-toolchain.toml) (`rustup` picks it up).

```sh
cargo build
cargo test                       # unit, configuration, golden and doc tests
cargo test --test golden         # just the golden tests
```

The golden tests in [`tests/golden/`](tests/golden/) are chrono-node's own test cases, with outputs recorded by running the real chrono-node. The comparison harness in [`harness/`](harness/) (Node 24+) also runs random phrases through both chrono-node and the Rust CLI `chrono-rs-json` and compares the answers:

```sh
cd harness && npm ci && npm run build:upstream
cargo build && npm run compare -- --rust ../target/debug/chrono-rs-json
```

See [`harness/README.md`](harness/README.md) for seeds and options.

## How it's built

Each change is made by an AI agent through the [factory](https://github.com/sabbasi3-factory-lab/factory#readme), and is checked against chrono-node's own output before it merges. Agents can't edit the contracts, golden tests, harness or workflows.

## Licence

MIT, see [`LICENSE`](LICENSE). Parts of `src/` are translations of chrono-node (MIT, © Wanasit Tanakitrungruang); see [`NOTICE`](NOTICE).
