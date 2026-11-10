# chrono-node-rs

A behaviour-matched Rust port of **[chrono-node](https://github.com/wanasit/chrono)** by **Wanasit Tanakitrungruang**, the JavaScript library that finds dates and times in plain text ("tomorrow at 5pm", "next Friday at noon"). All credit for the parsing rules goes to chrono-node and its author; this crate is an independent port, not an official chrono-node release. chrono-node is MIT-licensed, and its copyright and licence notice are kept in [`NOTICE`](NOTICE), which ships with the crate.

The port follows upstream closely, file by file, and is checked against chrono-node's own output:

- **Golden tests**: chrono-node's own test cases, with outputs recorded by running the real chrono-node.
- **Random-phrase comparison**: a harness runs generated phrases through both chrono-node and this crate and requires the same answers.
- **Nightly monitor**: every night, fresh random phrases in every ported language are compared between `main` and chrono-node; any mismatch is filed as a bug with a reproducible seed.

It ports a pinned upstream release: chrono-node `v2.10.3` (commit `d4fe7e3`). The copy is kept unmodified in [`upstream/`](upstream/); see [`upstream/PINNED.md`](upstream/PINNED.md).

## Status

As of 2026-11-10, all 16 of chrono-node's locales are ported, plus the shared code (`zh` as `zh.hans` and `zh.hant`):

| Locales | How they were ported |
|---|---|
| Common code, `en`, `de`, `fr`, `sv`, `pt`, `es`, `ja` | Factory v1, in waves |
| `fi`, `id`, `nl`, `ru`, `uk`, `ar`, `zh.hans`, `zh.hant` | Factory v1 with generated onboarding: a generator records each language's golden cases and contracts from the pinned chrono-node, and the factory onboards the next language as soon as the previous one's tasks close |
| `vi` | A/B experiment: a separate goal-driven agent session, outside the factory's task automation ([#491](https://github.com/sabbasi3-factory-lab/chrono-node-rs/pull/491), [#495](https://github.com/sabbasi3-factory-lab/chrono-node-rs/pull/495)–[#500](https://github.com/sabbasi3-factory-lab/chrono-node-rs/pull/500)) |
| `it` | Factory v2 pilot: one agent run for the whole language ([#553](https://github.com/sabbasi3-factory-lab/chrono-node-rs/pull/553); results in [`docs/factory-v2.md`](docs/factory-v2.md#pilot-results-it-2026-11-10)) |

Every locale passes the same checks on `main`, whichever way it was ported:

- **Golden cases:** 2,675 of chrono-node's own test cases, 0 pending ([`tests/golden/`](tests/golden/)).
- **Golden frontier:** each ported parser and refiner is checked on its own against chrono-node's output, on every case. The check also confirms that every language has every step ported, with no case left pending ([`harness/golden/frontier.js`](harness/golden/frontier.js); the run at completion: [ci #42744564299](https://github.com/sabbasi3-factory-lab/chrono-node-rs/actions/runs/42744564299)).
- **Random-phrase comparison:** generated phrases run through both chrono-node and this crate, with the same answers required ([comparison harness](harness/README.md#comparison-harness)). At the v2 pilot, 10,000 phrases per language (170,000 in all, seed 20261110) had 0 mismatches.
- **Nightly monitor:** fresh random phrases in every language, every night ([monitor runs](https://github.com/sabbasi3-factory-lab/chrono-node-rs/actions/workflows/monitor.yml)).

The crate isn't published to crates.io yet. 0.1.0 is the first planned release.

## Usage

```toml
[dependencies]
chrono-node-rs = "0.1"   # the library is imported as `chrono_node`; needs Rust 1.85 or later
```

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

MIT, see [`LICENSE`](LICENSE). Parts of `src/` are translations of chrono-node (MIT, Copyright (c) 2014 Wanasit Tanakitrungruang); its full licence notice is in [`NOTICE`](NOTICE), included in the published crate.
