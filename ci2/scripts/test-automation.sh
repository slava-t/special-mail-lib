#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CI_DIR_NAME="ci2"
CI_DIR="$REPO_ROOT/$CI_DIR_NAME"
VISOR2_BIN="${VISOR2_BIN:-visor2}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
CAPTURE_HELPER="$SCRIPT_DIR/test-automation-capture.py"
PREFLIGHT_TIMEOUT="${VISOR2_PREFLIGHT_TIMEOUT:-10}"
CANCEL_GRACE_SECONDS="${TEST_AUTOMATION_CANCEL_GRACE_SECONDS:-0.2}"
POLL_SECONDS="${TEST_AUTOMATION_POLL_SECONDS:-0.05}"
BASELINE_DIR="$REPO_ROOT/.ci2-baseline"
baseline_owned_identity=""
baseline_run_id=""
baseline_target_b64=""
# Expected identities come from this invocation, never from inherited state.
unset SML_BASELINE_RUN_ID SML_BASELINE_TARGET_B64

usage() {
    cat <<'EOF'
Usage: ci2/scripts/test-automation.sh [--suite all|lint|unit|int|dep-policy] [--fail-fast] [--list]
       ci2/scripts/test-automation.sh --prepare-baseline
EOF
}

die_usage() {
    echo "Usage error: $1" >&2
    usage >&2
    exit 2
}

preflight_fail() {
    echo "Preflight failed: $1" >&2
    exit 1
}

config_fail() {
    echo "Configuration error: $1" >&2
    exit 1
}

print_list() {
    echo "Suites:"
    echo "  all"
    echo "  lint"
    echo "  unit"
    echo "  int"
    echo "  dep-policy"
}

format_duration() {
    local total_seconds="$1"
    local minutes=$((total_seconds / 60))
    local seconds=$((total_seconds % 60))
    printf '%dm%02ds\n' "$minutes" "$seconds"
}

status_field() {
    local field="$1" file="$2"
    sed -n "s/^$field=//p" "$file" | head -n 1
}

print_final_report() {
    local index
    local total=0
    local ok_count=0
    local failed_count=0
    for index in "${!selected_files[@]}"; do
        [[ "${reported_by_index[$index]:-false}" == "true" ]] || continue
        printf '%s %s %s\n' \
            "${selected_files[$index]}" \
            "${result_by_index[$index]}" \
            "$(format_duration "${seconds_by_index[$index]}")"
        total=$((total + 1))
        case "${result_by_index[$index]}" in
            ok) ok_count=$((ok_count + 1)) ;;
            failed) failed_count=$((failed_count + 1)) ;;
        esac
    done
    printf 'total %d ok %d failed %d\n' "$total" "$ok_count" "$failed_count"
}

suite=""
fail_fast=false
list_only=false
prepare_only=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --suite)
            [[ -n "${2:-}" ]] || die_usage "--suite requires a value"
            [[ -z "$suite" ]] || die_usage "--suite may be provided only once"
            suite="$2"
            case "$suite" in
                all|lint|unit|int|dep-policy) ;;
                *) die_usage "unknown suite: $suite" ;;
            esac
            shift 2
            ;;
        --prepare-baseline)
            [[ "$prepare_only" == "false" ]] || die_usage "--prepare-baseline may be provided only once"
            prepare_only=true
            shift
            ;;
        --fail-fast)
            fail_fast=true
            shift
            ;;
        --list)
            list_only=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die_usage "unknown argument: $1"
            ;;
    esac
done

if [[ "$prepare_only" == "true" ]]; then
    [[ -z "$suite" && "$list_only" == "false" && "$fail_fast" == "false" ]] \
        || die_usage "--prepare-baseline cannot be combined with --suite, --list or --fail-fast"
fi

if [[ "$list_only" == "true" ]]; then
    print_list
    exit 0
fi

effective_suite="${suite:-all}"

selected_files=()
ci_leaf_files=()

add_selected() {
    selected_files+=("$1")
}

normalize_ci_include() {
    local includer="$1" raw_path="$2" path candidate rest prefix
    local base_dir="${includer%/*}"
    prefix="$CI_DIR_NAME/"

    path="$raw_path"
    while [[ "$path" == ./* ]]; do
        path="${path#./}"
    done

    [[ -n "$path" ]] || return 1
    [[ "$path" != /* ]] || return 1

    if [[ "$path" == "$prefix"* ]]; then
        candidate="$path"
    else
        candidate="$base_dir/$path"
    fi

    while [[ "$candidate" == ./* ]]; do
        candidate="${candidate#./}"
    done
    while [[ "$candidate" == *"/./"* ]]; do
        candidate="${candidate//\/.\//\/}"
    done

    [[ "$candidate" != ../* && "$candidate" != *"/../"* && "$candidate" != */.. ]] || return 1
    rest="${candidate#$prefix}"
    [[ "$candidate" == "$prefix"* && "$rest" != */* && "$rest" == *.visorfile ]] || return 1

    printf '%s\n' "$candidate"
}

build_ci_leaf_files() {
    local file rel line include_path normalized
    local ci_files=()
    local included_set=$'\n'

    ci_leaf_files=()
    while IFS= read -r file; do
        ci_files+=("$CI_DIR_NAME/${file##*/}")
    done < <(find "$CI_DIR" -maxdepth 1 -type f -name '*.visorfile' | sort)

    for rel in "${ci_files[@]}"; do
        while IFS= read -r line; do
            [[ "$line" =~ ^[[:space:]]*INCLUDE[[:space:]]+([^[:space:]#]+) ]] || continue
            include_path="${BASH_REMATCH[1]}"
            normalized="$(normalize_ci_include "$rel" "$include_path")" \
                || config_fail "unsupported INCLUDE path in $rel: $include_path"
            included_set+="$normalized"$'\n'
        done < "$REPO_ROOT/$rel"
    done

    for rel in "${ci_files[@]}"; do
        if [[ "$included_set" != *$'\n'"$rel"$'\n'* ]]; then
            ci_leaf_files+=("$rel")
        fi
    done
}

is_ci_leaf() {
    local needle="$1" rel
    for rel in "${ci_leaf_files[@]}"; do
        [[ "$rel" == "$needle" ]] && return 0
    done
    return 1
}

add_selected_leaf() {
    local rel="$1"
    if [[ -f "$REPO_ROOT/$rel" ]] && ! is_ci_leaf "$rel"; then
        config_fail "selected Visorfile is not a leaf: $rel"
    fi
    add_selected "$rel"
}

[[ -d "$CI_DIR" ]] || preflight_fail "repo-root"
build_ci_leaf_files

case "$effective_suite" in
    all)
        add_selected_leaf "$CI_DIR_NAME/lint.visorfile"
        add_selected_leaf "$CI_DIR_NAME/unit-tests.visorfile"
        add_selected_leaf "$CI_DIR_NAME/int-tests.visorfile"
        add_selected_leaf "$CI_DIR_NAME/dep-policy.visorfile"
        ;;
    lint)
        add_selected_leaf "$CI_DIR_NAME/lint.visorfile"
        ;;
    unit)
        add_selected_leaf "$CI_DIR_NAME/unit-tests.visorfile"
        ;;
    int)
        add_selected_leaf "$CI_DIR_NAME/int-tests.visorfile"
        ;;
    dep-policy)
        add_selected_leaf "$CI_DIR_NAME/dep-policy.visorfile"
        ;;
esac

preflight() {
    [[ -d "$CI_DIR" && -d "$CI_DIR/scripts" ]] || preflight_fail "repo-root"
    local required_script
    for required_script in \
        test-automation.sh \
        test-automation-capture.py \
        all-tests.sh
    do
        [[ -f "$CI_DIR/scripts/$required_script" ]] || preflight_fail "required automation script exists: $CI_DIR_NAME/scripts/$required_script"
    done

    if ! command -v "$VISOR2_BIN" >/dev/null 2>&1; then
        preflight_fail "visor2 in PATH"
    fi

    if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
        preflight_fail "python3 in PATH"
    fi

    if ! "$PYTHON_BIN" - "$CAPTURE_HELPER" >/dev/null 2>&1 <<'PY'; then
import pathlib
import sys
compile(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec")
PY
        preflight_fail "python3 capture helper syntax"
    fi

    # Nondestructive probe: --no-interactive is the visor2 build flag this
    # automation depends on. Help parsing verifies it without starting a VM
    # or requiring credentials.
    if ! timeout "$PREFLIGHT_TIMEOUT" "$VISOR2_BIN" build --no-interactive --help </dev/null >/dev/null 2>&1; then
        preflight_fail "visor2 build non-interactive entrypoint"
    fi

    local rel abs index
    for index in "${!selected_files[@]}"; do
        rel="${selected_files[$index]}"
        [[ "$rel" == "$CI_DIR_NAME/"* ]] || preflight_fail "selected Visorfile under $CI_DIR_NAME/: $rel"
        abs="$REPO_ROOT/$rel"
        [[ -f "$abs" ]] || preflight_fail "selected Visorfile exists: $rel"
    done
}

cleanup_baseline() {
    [[ -n "$baseline_owned_identity" ]] || return 0
    if [[ ! -L "$BASELINE_DIR" && -d "$BASELINE_DIR" &&
          "$(stat -c '%d:%i' -- "$BASELINE_DIR")" == "$baseline_owned_identity" ]]; then
        rm -rf -- "$BASELINE_DIR"
    fi
    baseline_owned_identity=""
}

prepare_baseline() {
    local values
    if ! mkdir -m 700 -- "$BASELINE_DIR"; then
        echo "Baseline input error: .ci2-baseline already exists or cannot be created" >&2
        return 1
    fi
    baseline_owned_identity="$(stat -c '%d:%i' -- "$BASELINE_DIR")"
    values="$("$PYTHON_BIN" - "$REPO_ROOT" "$BASELINE_DIR" "$prepare_only" \
        "${SML_BASELINE_TARGET_REF+x}" "${SML_BASELINE_TARGET_REF:-}" <<'PY'
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tarfile

root, output, prepare_only, requested, target = sys.argv[1:]
output = Path(output)
source_areas = ["lib", "tests", "docker", "index.js", "package.json",
                "package-lock.json", ".eslintrc.js", ".eslintignore", "ci2", "scripts"]
env = dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_NO_REPLACE_OBJECTS="1")
# Resolve the actual workspace even if the caller ran from another Git context.
for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_SHALLOW_FILE"):
    env.pop(key, None)

def git(*args, allowed=(0,)):
    result = subprocess.run(["git", "--no-replace-objects", "-C", root, *args],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if result.returncode not in allowed:
        raise ValueError("git " + args[0] + " failed: " +
                         result.stderr.decode("utf-8", "replace").strip())
    return result

def text(*args):
    return git(*args).stdout.decode("utf-8").strip()

def digest(data):
    return hashlib.sha256(data).hexdigest()

def check_workspace(commit):
    if text("rev-parse", "--verify", "HEAD^{commit}") != commit:
        raise ValueError("workspace HEAD changed during baseline preparation")
    if git("status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching",
           "--", *source_areas).stdout:
        raise ValueError("staged source areas must match HEAD, including untracked files")
    flags = text("ls-files", "-v", "--", *source_areas).splitlines()
    if any(line[0].islower() or line[0] == "S" for line in flags):
        raise ValueError("staged source areas cannot use assume-unchanged or skip-worktree")
    pair = {}
    for name in ("package.json", "package-lock.json"):
        path = Path(root) / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("proposed " + name + " must be a regular file")
        data = path.read_bytes()
        if data != git("cat-file", "blob", commit + ":" + name).stdout:
            raise ValueError("proposed " + name + " differs from workspace HEAD")
        pair[name] = data
    return pair

try:
    if git("ls-files", "--", ".ci2-baseline").stdout:
        raise ValueError(".ci2-baseline must not be tracked")
    for name in (".ci2-baseline/", ".ci2-baseline/record.json",
                 ".ci2-baseline/package.json", ".ci2-baseline/package-lock.json",
                 ".ci2-baseline/not-requested"):
        if git("check-ignore", "--no-index", "--", name, allowed=(0, 1)).returncode == 0:
            raise ValueError(".ci2-baseline inputs must not be git-ignored")
    if not requested:
        if prepare_only == "true":
            raise ValueError("--prepare-baseline requires SML_BASELINE_TARGET_REF")
        (output / "not-requested").write_bytes(b"not-requested\n")
        print("\n")
        sys.exit(0)
    if not target:
        raise ValueError("SML_BASELINE_TARGET_REF must not be empty")
    target_bytes = target.encode("utf-8", "strict")
    if text("rev-parse", "--is-shallow-repository") != "false":
        raise ValueError("complete history required; shallow repository")
    partial = git("config", "--get-regexp", r"^(extensions\.partialclone|remote\..*\.promisor)$",
                  allowed=(0, 1)).stdout
    if partial:
        raise ValueError("complete history required; partial/promisor repository")
    grafts = Path(text("rev-parse", "--git-path", "info/grafts"))
    if not grafts.is_absolute():
        grafts = Path(root) / grafts
    if grafts.exists() and grafts.stat().st_size:
        raise ValueError("complete history required; grafted history")
    review_commit = text("rev-parse", "--verify", "HEAD^{commit}")
    target_commit = text("rev-parse", "--verify", "--end-of-options", target + "^{commit}")
    # Missing objects must fail here; no fetch, empty result or endpoint fallback.
    git("rev-list", "--objects", "--missing=error", target_commit, review_commit)
    pair = check_workspace(review_commit)
    bases = text("merge-base", "--all", target_commit, review_commit).splitlines()
    if len(bases) != 1:
        raise ValueError("expected exactly one merge-base, found " + str(len(bases)))
    baseline = bases[0]
    archive = git("archive", "--format=tar", baseline, "--",
                  "package.json", "package-lock.json").stdout
    baseline_pair = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
        members = bundle.getmembers()
        if sorted(member.name for member in members) != ["package-lock.json", "package.json"]:
            raise ValueError("baseline archive must contain exactly the manifest/lockfile pair")
        for member in members:
            if not member.isfile():
                raise ValueError("baseline " + member.name + " must be a regular file")
            data = bundle.extractfile(member).read()
            if data != git("cat-file", "blob", baseline + ":" + member.name).stdout:
                raise ValueError("baseline archive bytes differ from Git blob: " + member.name)
            baseline_pair[member.name] = data
            (output / member.name).write_bytes(data)
    manifest = json.loads(baseline_pair["package.json"])
    lockfile = json.loads(baseline_pair["package-lock.json"])
    if not isinstance(manifest, dict) or not isinstance(lockfile, dict):
        raise ValueError("baseline manifest and lockfile must be JSON objects")
    version = lockfile.get("lockfileVersion")
    if type(version) is not int:
        raise ValueError("baseline lockfileVersion must be an integer")
    if check_workspace(review_commit) != pair:
        raise ValueError("proposed dependency pair changed during preparation")
    run_id = secrets.token_hex(32)
    record = {
        "schema_version": 1, "run_id": run_id, "target_ref": target,
        "target_commit": target_commit, "review_commit": review_commit,
        "baseline_ref": baseline, "baseline_commit": baseline,
        "manifest_ref": baseline, "lockfile_ref": baseline,
        "merge_base_verified": True, "lockfile_version": version,
        "manifest_sha256": digest(baseline_pair["package.json"]),
        "lockfile_sha256": digest(baseline_pair["package-lock.json"]),
        "review_manifest_sha256": digest(pair["package.json"]),
        "review_lockfile_sha256": digest(pair["package-lock.json"]),
    }
    pending = output / "record.json.tmp"
    pending.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    pending.replace(output / "record.json")
    print("Baseline prepared: " + json.dumps(record, sort_keys=True), file=sys.stderr)
    print(run_id)
    print(base64.b64encode(target_bytes).decode("ascii"))
except (OSError, ValueError, tarfile.TarError) as exc:
    print("Baseline input error: " + str(exc), file=sys.stderr)
    sys.exit(1)
PY
)" || return 1
    baseline_run_id="${values%%$'\n'*}"
    baseline_target_b64="${values#*$'\n'}"
}

tmp_output_dir=""
cleanup_running=false
normal_done=false
helper_pids=()
child_pgids=()
event_files=()
status_files=()
pgid_files=()
completed_by_index=()
signaled_by_index=()
reported_by_index=()
result_by_index=()
seconds_by_index=()
completed_failed=false

helper_alive() {
    local index="$1" pid="${helper_pids[$index]:-}"
    [[ -n "$pid" ]] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    [[ "$(ps -o stat= -p "$pid" 2>/dev/null || true)" != Z* ]]
}

refresh_child_pgid() {
    local index="$1" pgid_file="${pgid_files[$index]:-}" pgid
    if [[ -z "${child_pgids[$index]:-}" && -n "$pgid_file" && -s "$pgid_file" ]]; then
        IFS= read -r pgid < "$pgid_file"
        child_pgids[$index]="$pgid"
    fi
}

process_group_alive() {
    local pgid="$1"
    [[ -n "$pgid" ]] && kill -0 -- "-$pgid" 2>/dev/null
}

wait_helper_no_fail() {
    local index="$1" pid="${helper_pids[$index]:-}"
    [[ -n "$pid" ]] || return 0
    set +e
    wait "$pid"
    set -e
    helper_pids[$index]=""
}

signal_build() {
    local index="$1" pgid pid
    [[ "${completed_by_index[$index]:-false}" == "true" ]] && return 0
    [[ -f "${status_files[$index]:-}" ]] && return 0

    refresh_child_pgid "$index"
    pgid="${child_pgids[$index]:-}"
    if process_group_alive "$pgid"; then
        signaled_by_index[$index]=true
        kill -TERM -- "-$pgid" 2>/dev/null || true
        return 0
    fi

    pid="${helper_pids[$index]:-}"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        signaled_by_index[$index]=true
        kill -TERM "$pid" 2>/dev/null || true
    fi
}

force_kill_signaled() {
    local index pgid pid
    for index in "${!selected_files[@]}"; do
        [[ "${signaled_by_index[$index]:-false}" == "true" ]] || continue
        [[ "${completed_by_index[$index]:-false}" == "true" ]] && continue
        refresh_child_pgid "$index"
        pgid="${child_pgids[$index]:-}"
        if process_group_alive "$pgid"; then
            kill -KILL -- "-$pgid" 2>/dev/null || true
        fi
        pid="${helper_pids[$index]:-}"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done
}

cancel_remaining_builds() {
    local index pgid
    for index in "${!selected_files[@]}"; do
        [[ "${completed_by_index[$index]:-false}" == "true" ]] && continue
        [[ -f "${status_files[$index]:-}" ]] && continue
        refresh_child_pgid "$index"
        pgid="${child_pgids[$index]:-}"
        if [[ -n "$pgid" ]] && ! process_group_alive "$pgid"; then
            continue
        fi
        signal_build "$index"
    done
    sleep "$CANCEL_GRACE_SECONDS"
    force_kill_signaled
}

cleanup_children() {
    local index
    for index in "${!selected_files[@]}"; do
        signal_build "$index"
    done
    sleep "$CANCEL_GRACE_SECONDS"
    force_kill_signaled
    for index in "${!selected_files[@]}"; do
        wait_helper_no_fail "$index"
    done
}

cleanup_on_exit() {
    local rc=$?
    [[ "$cleanup_running" == "false" ]] || exit "$rc"
    cleanup_running=true
    if [[ "$normal_done" != "true" ]]; then
        cleanup_children
    fi
    if [[ -n "$tmp_output_dir" ]]; then
        rm -rf "$tmp_output_dir"
    fi
    cleanup_baseline
    exit "$rc"
}

trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

launch_build() {
    local index="$1" rel="$2"
    event_files[$index]="$tmp_output_dir/build-$index.events"
    status_files[$index]="$tmp_output_dir/build-$index.status"
    pgid_files[$index]="$tmp_output_dir/build-$index.pgid"
    completed_by_index[$index]=false
    signaled_by_index[$index]=false
    reported_by_index[$index]=false
    "$PYTHON_BIN" "$CAPTURE_HELPER" capture "$REPO_ROOT" "$rel" \
        "${event_files[$index]}" \
        "${status_files[$index]}" \
        "${pgid_files[$index]}" \
        "$baseline_run_id" "$baseline_target_b64" &
    helper_pids[$index]=$!
}

find_next_status_index() {
    local index completed_ns best_index="" best_completed_ns=""
    for index in "${!selected_files[@]}"; do
        [[ "${completed_by_index[$index]:-false}" == "true" ]] && continue
        [[ -f "${status_files[$index]:-}" ]] || continue
        completed_ns="$(status_field completed_ns "${status_files[$index]}")"
        [[ -n "$completed_ns" ]] || completed_ns=0
        if [[ -z "$best_index" || "$completed_ns" -lt "$best_completed_ns" ]]; then
            best_index="$index"
            best_completed_ns="$completed_ns"
        fi
    done
    [[ -n "$best_index" ]] && printf '%s\n' "$best_index"
}

find_exited_without_status_index() {
    local index
    for index in "${!selected_files[@]}"; do
        [[ "${completed_by_index[$index]:-false}" == "true" ]] && continue
        [[ -f "${status_files[$index]:-}" ]] && continue
        if ! helper_alive "$index"; then
            printf '%s\n' "$index"
            return 0
        fi
    done
}

record_report_row() {
    local index="$1" result="$2" elapsed_ms="$3"
    reported_by_index[$index]=true
    result_by_index[$index]="$result"
    if [[ "$elapsed_ms" -lt 0 ]]; then
        elapsed_ms=0
    fi
    seconds_by_index[$index]=$((elapsed_ms / 1000))
}

complete_with_status() {
    local index="$1" rc elapsed_ms result
    completed_failed=false
    completed_by_index[$index]=true
    wait_helper_no_fail "$index"

    if [[ "${signaled_by_index[$index]:-false}" == "true" ]]; then
        return 0
    fi

    rc="$(status_field rc "${status_files[$index]}")"
    elapsed_ms="$(status_field elapsed_ms "${status_files[$index]}")"
    [[ -n "$elapsed_ms" ]] || elapsed_ms=0

    if [[ "$rc" -eq 0 ]]; then
        result="ok"
    else
        result="failed"
        completed_failed=true
        if [[ "$fail_fast" == "true" && "$fail_fast_cancelled" == "false" ]]; then
            fail_fast_cancelled=true
            cancel_remaining_builds
        fi
    fi

    "$PYTHON_BIN" "$CAPTURE_HELPER" replay "${event_files[$index]}"
    record_report_row "$index" "$result" "$elapsed_ms"
}

complete_without_status() {
    local index="$1"
    completed_failed=false
    wait_helper_no_fail "$index"
    if [[ -f "${status_files[$index]:-}" ]]; then
        complete_with_status "$index"
        return 0
    fi
    completed_by_index[$index]=true
    if [[ "${signaled_by_index[$index]:-false}" == "true" ]]; then
        return 0
    fi
    echo "test automation helper failed before recording status for ${selected_files[$index]}" >&2
    record_report_row "$index" "failed" 0
    completed_failed=true
}

preflight
if [[ "$prepare_only" == "false" &&
      ( "$effective_suite" == "all" || "$effective_suite" == "dep-policy" ) &&
      -z "${SML_BASELINE_TARGET_REF+x}" ]]; then
    echo "Baseline input error: dep-policy requires SML_BASELINE_TARGET_REF" >&2
    exit 1
fi
prepare_baseline

if [[ "$prepare_only" == "true" ]]; then
    printf '{"run_id":"%s","target_ref_b64":"%s"}\n' "$baseline_run_id" "$baseline_target_b64"
    # The independent caller owns successful prepared inputs until its build ends.
    baseline_owned_identity=""
    normal_done=true
    exit 0
fi

tmp_output_dir="$(mktemp -d)"
if [[ -n "${TEST_AUTOMATION_TMPDIR_FILE:-}" ]]; then
    printf '%s\n' "$tmp_output_dir" > "$TEST_AUTOMATION_TMPDIR_FILE"
fi

for index in "${!selected_files[@]}"; do
    launch_build "$index" "${selected_files[$index]}"
done

remaining=${#selected_files[@]}
failed=0
fail_fast_cancelled=false

while [[ $remaining -gt 0 ]]; do
    next_index="$(find_next_status_index || true)"
    if [[ -n "$next_index" ]]; then
        complete_with_status "$next_index"
        if [[ "$completed_failed" == "true" ]]; then
            failed=$((failed + 1))
            if [[ "$fail_fast" == "true" && "$fail_fast_cancelled" == "false" ]]; then
                fail_fast_cancelled=true
                cancel_remaining_builds
            fi
        fi
        remaining=$((remaining - 1))
        continue
    fi

    next_index="$(find_exited_without_status_index || true)"
    if [[ -n "$next_index" ]]; then
        complete_without_status "$next_index"
        if [[ "$completed_failed" == "true" ]]; then
            failed=$((failed + 1))
            if [[ "$fail_fast" == "true" && "$fail_fast_cancelled" == "false" ]]; then
                fail_fast_cancelled=true
                cancel_remaining_builds
            fi
        fi
        remaining=$((remaining - 1))
        continue
    fi

    sleep "$POLL_SECONDS"
done

if [[ ${#selected_files[@]} -gt 0 ]]; then
    print_final_report
fi

normal_done=true
cleanup_baseline
rm -rf "$tmp_output_dir"
tmp_output_dir=""
trap - EXIT

if [[ $failed -gt 0 ]]; then
    exit 1
fi
