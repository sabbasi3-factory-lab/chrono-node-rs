# Shared by mutation.sh (sourced). When the gate fails, each surviving mutant becomes one `::error`
# workflow command: a PR annotation, and a `##[error]` line in the job log, which the repair
# workflow's failure.txt keeps. So the repair agent gets the exact mutants without running
# cargo-mutants.
#
# annotate_missed <cap>: stdin = cargo-mutants missed.txt lines (`path:line:col: description`,
# paths repo-relative). Prints at most <cap> annotations, then one line for the rest. The
# description comes from PR code (function names), so it's escaped as workflow-command data: `%`,
# CR and LF in the message; also `:` and `,` in properties. Lines that don't parse are reported
# whole, without a file.
annotate_missed() {
    local cap="$1"
    awk -v cap="$cap" '
        function msg(s) { gsub(/%/, "%25", s); gsub(/\r/, "%0D", s); gsub(/\n/, "%0A", s); return s }
        function prop(s) { s = msg(s); gsub(/:/, "%3A", s); gsub(/,/, "%2C", s); return s }
        NF == 0 { next }
        {
            n++
            if (n > cap) next
            if (match($0, /^[^:]+:[0-9]+:[0-9]+: /)) {
                head = substr($0, 1, RLENGTH - 2)
                split(head, a, ":")
                printf "::error file=%s,line=%s,title=surviving mutant::surviving mutant at %s: %s\n", prop(a[1]), a[2], msg(head), msg(substr($0, RLENGTH + 1))
            } else {
                printf "::error title=surviving mutant::surviving mutant: %s\n", msg($0)
            }
        }
        END { if (n > cap) printf "::error::%d more surviving mutants (the full list is in this step'"'"'s log)\n", n - cap }
    '
}
