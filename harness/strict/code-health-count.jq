# code_health_not_worse (harness/strict/code-health.sh): one "<file>\t<lint>" line per warning of a
# counted lint, from `cargo clippy --message-format=json`.
#   $lints: the lint names counted.  $root: the checkout's canonical root, with a trailing "/".
# File names are made repo-relative: steps auto-registered by build.rs are included with an absolute
# `#[path]`, so clippy reports them under the absolute (canonical) path.
select(.reason == "compiler-message") | .message
| select(.code != null and (.code.code as $c | $lints | index($c)))
| .code.code as $lint
| .spans[] | select(.is_primary) | .file_name
| (if startswith($root) then .[($root | length):] else . end) + "\t" + $lint
