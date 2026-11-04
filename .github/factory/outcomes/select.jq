# Which completed agent runs `outcomes` evaluates this time (outcomes.yml). Input: the listed runs
# ([{run_id, workflow, title, created_at}]). Args: $p (previous outcomes.json), $prs (agent PRs:
# [{number, closedAt}]), $full ("true": everything), $now, $cut (14 days ago), $day (24 h ago), $max.
#
# Budget (1,000 GITHUB_TOKEN requests/h per repo, shared with CI, CodeQL and gh-aw jobs): each
# evaluation costs ~8-16 requests, so at most $max per invocation, by priority:
#   0  a run whose PR closed after the run was last evaluated, whatever its previous verdict (a PR
#      rejected, reopened and merged closes again later)
#   1  a new run (never evaluated)
#   2  a failed evaluation, or a pending/unknown item, under 14 days old, last evaluated over 24 h ago
# then oldest first. The rest waits for the next invocation. A record without `evaluated_at` (before
# this field existed) counts as evaluated when the previous file was generated.
($p[0].runs | map({key: (.run_id|tostring), value: .}) | from_entries) as $prev
| ($p[0].generated_at // "1970-01-01T00:00:00Z") as $gen
| ($prs[0] | map(select(.closedAt != null) | {key: (.number|tostring), value: .closedAt}) | from_entries) as $closed
| [ .[] | $prev[(.run_id|tostring)] as $o
    | ($o.evaluated_at // $gen) as $at
    | ([$o.items[]? | (.object_url // "") | capture("/pull/(?<n>[0-9]+)").n? | $closed[.] | select(. != null and . > $at)] | length > 0) as $prclosed
    | ($o != null and (($o.eval_failed // false) or any($o.items[]?; .outcome_status == "pending" or .outcome_status == "unknown"))) as $open
    | (if $full == "true" then 3
       elif $o == null then 1
       elif $prclosed then 0
       elif .created_at > $cut and $open and $at < $day then 2
       else null end) as $prio
    | select($prio != null)
    | {run_id, prio: $prio, at: (if $o == null then .created_at else $at end)} ]
| sort_by(.prio, .at, .run_id)
| (if $full == "true" then . else .[: ($max | tonumber)] end)
| .[].run_id
