#!/usr/bin/env bash
# Spec for the filename command-injection bug in the Blueprint 2.0 and 3.0
# upgrade rename scripts.
#
# These tests fail while matchingFiles feeds grep output through xargs into
# `perl -lne`, because perl's <> operator opens each argument with two-argument
# open and a trailing "|" runs the argument through the shell. They pass once
# every name is opened as a literal path (no shell command runs).
#
# Both scripts call the same matchingFiles helper from rename, renameProp,
# renameString, warn, and warnProp. The 2.0 script also calls it from
# renamePartialClass. Each case runs the full script, so a fix that leaves any
# of those callers on the vulnerable pipeline still fails.
#
# The payload uses the same shape as a remote command (spaces so xargs splits,
# ${IFS} so the shell inserts a space, a pipe into sh, and a trailing pipe) but
# the command only creates a local marker file. It does not contact a network.

set -u

repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
script_dir="$repo_root/packages/core/scripts"

failures=0

# Run one upgrade script against a tree that contains a crafted filename.
# layout is "root" (file directly under the project) or "nested" (file under
# vendor/drop). The script is always started at the project root with the
# default search path.
run_case() {
    local script_name="$1"
    local extension="$2"
    local layout="$3"
    local label="$script_name ${layout} .${extension}"
    local work project_root dest marker_name crafted_name

    work=$(mktemp -d "${TMPDIR:-/tmp}/blueprint-rename-injection.XXXXXX")
    project_root="$work/project"
    if [[ "$layout" == "nested" ]]; then
        dest="$project_root/vendor/drop"
    else
        dest="$project_root"
    fi
    mkdir -p "$dest"

    # No slash: those would be directory separators in the filename itself.
    marker_name="executed-marker"
    crafted_name="x touch\${IFS}${marker_name}|sh| y.${extension}"
    printf 'hello\n' > "${dest}/${crafted_name}"

    (
        cd "$project_root" || exit 1
        bash "$script_dir/$script_name"
    ) >"$work/stdout.txt" 2>"$work/stderr.txt" || true

    if [[ -e "$project_root/$marker_name" ]]; then
        echo "FAIL ${label}: shell command embedded in the filename was executed"
        failures=$((failures + 1))
    else
        echo "PASS ${label}: filename was not executed as a shell command"
    fi

    rm -rf "$work"
}

scripts=(
    upgrade-blueprint-2.0.0-rename.sh
    upgrade-blueprint-3.0.0-rename.sh
)
extensions=(ts tsx scss less)

for script_name in "${scripts[@]}"; do
    for extension in "${extensions[@]}"; do
        run_case "$script_name" "$extension" root
    done
    # A file in a subdirectory is still on the default recursive search.
    run_case "$script_name" ts nested
done

if [[ "$failures" -ne 0 ]]; then
    echo "${failures} case(s) failed"
    exit 1
fi

echo "all cases passed"
exit 0
