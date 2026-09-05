# Test Automation Spec (v1.1)

This spec defines `special-mail-lib` automation through `visor2 build` under
`ci2/`: file layout, VM provisioning, source staging, suites, the outer runner
and its authorization as agent validation. It owns execution and evidence;
[dependency-upgrades.md §8] owns the dependency policy's enforcement boundary.

The common layer, runner and all four suites are implemented. Execution
evidence must identify the registered suites actually exercised (§9).

## 0. Glossary

* **Automation runner**: `ci2/scripts/test-automation.sh`, which selects
  registered suites and invokes `visor2 build` for their leaves.
* **Full-suite wrapper**: `ci2/scripts/all-tests.sh`, the entry point that
  invokes the Automation runner with `--suite all`.
* **Capture helper**: `ci2/scripts/test-automation-capture.py`, the Python
  helper started once per selected build to capture its output and result.
* **Visorfile**: an input file for `visor2 build`, placed directly under
  `ci2/` and using the dialect of §3.
* **Common Visorfile**: `ci2/common.visorfile`, which provisions the VM and
  Stage tree and is included first by every executable suite leaf.
* **Leaf Visorfile**: a directly contained `ci2/*.visorfile` that no other
  directly contained `ci2/*.visorfile` INCLUDEs. Leaf status alone does not
  register a suite.
* **Suite**: one group of tests or checks executed by one Leaf Visorfile.
* **Registered suite**: an implemented suite declared in §6's live-suite
  table. A FUTURE suite declaration is a target contract, not a registration.
* **`all`**: the selector for every registered suite in §8.1's order; it is
  not a separate suite or leaf.
* **Repository root**: the directory two levels above the Automation
  runner's location, resolved from its path rather than the caller's working
  directory.
* **Stage tree**: `/tmp/special-mail-lib` inside the VM, containing the
  repository files against which suites run.
* **Outer executor**: the host environment that starts the Automation
  runner, Capture helper and `visor2`.
* **Project-authorized Automation**: the exact automation command explicitly
  authorized by this project's user for agent validation (§9).
* **Testing Evidence**: the recorded command, coverage, results and
  limitations used to substantiate validation of a change (§9).
* **Local Test Flow**: a directly run language-local test command, end-to-end
  command or repository test script outside that authorization.

Dependency state, pre-change state, policed change set, gate, waiver, ledger
and upgrade record retain their [dependency-upgrades.md §0] meanings.

## 1. Goals and non-goals

### 1.1 Goals

STARTINTENT
Project test automation MUST run through a script that invokes
`visor2 build`. The user selected visor2 as the CI system.
ENDINTENT

* Define the common layer, suite contracts, runner and result reporting.
* Specify the intended suite coverage in §6 and its staged registration.
* Establish the project-authorized validation path and evidence rules (§9).
* Make each registered leaf independently runnable through visor2, with
  any inputs its §6 entry declares.

### 1.2 Non-goals

* Changing the library runtime contract, exported APIs, package fields or
  existing test scripts. [overview.md §3] and [overview.md §4] retain their
  ownership of exports and packaging.
* Defining dependency-upgrade policy beyond its automation interface.
  [dependency-upgrades.md §2] through [dependency-upgrades.md §10] own it.
* Integrating a CI service or scheduler, or modifying the visor2 tool.
* Building a separate runner self-test, such as a fake-visor2 test harness.
  Section 10 states correctness scenarios without adding that deliverable.

Spec publication supplies no passing execution evidence (§9).

## 2. File layout and naming

STARTINTENT
The automation directory MUST be named `ci2`, and all Visorfiles for this
automation MUST live under the repository's `ci2/` directory. The user
selected the visor2 `ci2/` structure used by the sibling projects.
ENDINTENT

Automation filenames and suite selectors MUST use kebab-case. The immediate
layout is:

```
ci2/
|-- common.visorfile
|-- lint.visorfile
|-- unit-tests.visorfile
|-- int-tests.visorfile
|-- dep-policy.visorfile
|-- policy/
|   `-- dependency-policy.yaml
`-- scripts/
    |-- all-tests.sh
    |-- test-automation.sh
    `-- test-automation-capture.py
```

1. The Common Visorfile and three helpers MUST use the paths above.
2. `ci2/scripts/` MUST contain exactly those three helpers. The shell entry
   points MUST be executable; the Capture helper runs through Python.
3. Every Visorfile MUST live directly under `ci2/`. INCLUDE paths MUST
   resolve to that direct `ci2/*.visorfile` set, never to a subdirectory or
   outside `ci2/` (§8.1).
4. Each suite's §6 entry owns its leaf filename. The layout above is a
   required live layout; FUTURE leaf filenames do not register suites.
5. `ci2/policy/` MAY hold gate data. It is not another helper directory;
   the dependency-policy entry in §6.4 names its structured file.

## 3. visor2 dialect boundary

Visorfiles MUST target the `visor2 build` dialect. The ordinary layer
directives are `MACHINE`, `FROM ubuntu24`, `INCLUDE`, `COPY`, `RUN`
(including `RUN --mount=type=cache,...` for apt caches), and `SNAPSHOT OFF`.
This list does not prohibit additional directives needed by declared suite
inputs or service setup.

The ordinary runner invocation MUST be
`visor2 build --no-interactive <ci2/file>`, with the Repository root as its
working directory. Each registered leaf MUST also support an independent
visor2 build with the inputs declared by its §6 entry. A baseline-dependent
leaf is not promised to work without those inputs.

INCLUDE paths MUST be relative and resolve directly under `ci2/`. Each
executable suite leaf MUST begin with `INCLUDE ./common.visorfile`.
`COPY` sources resolve relative to the containing Visorfile, so the common
layer's repository inputs begin with `../` (§5.2).

Common is a provisioning include and MUST NOT be selected as a suite. The
baseline input channel extends build arguments as specified in §5.4 and
§8.6. Common requires the generated input directory even for an explicitly
unrequested baseline; the runner creates it before any build.

## 4. Outer executor preconditions

The Outer executor MUST provide bash, the ordinary shell/text utilities used
by the runner, Python 3 able to execute the Capture helper, and `visor2`
already logged in and configured for noninteractive builds. The executable
overrides in §8.5 apply to both preflight and execution.

The repository MUST NOT contain visor2 credentials. Automation MUST NOT
write or embed them. Authentication is an existing Outer executor condition.

The runner MUST derive the Repository root from its own location and pass
that root to every build through the Capture helper. Invoking it from a
different working directory MUST leave selection and build inputs unchanged.

Before starting any VM, execution preflight MUST check these items in order:

1. `ci2/` and `ci2/scripts/` exist under the resolved Repository root.
2. `ci2/scripts/test-automation.sh`,
   `ci2/scripts/test-automation-capture.py` and `ci2/scripts/all-tests.sh`
   exist.
3. `visor2`, or the `VISOR2_BIN` override, resolves as an executable.
4. `python3`, or the `PYTHON_BIN` override, resolves as an executable.
5. The Capture helper compiles under that Python interpreter.
6. `visor2 build --no-interactive --help` succeeds within
   `VISOR2_PREFLIGHT_TIMEOUT` without starting a VM.
7. Every selected Visorfile path is under `ci2/` and exists.

A failed item MUST print `Preflight failed: <item>` to stderr and exit 1
before launching any build. Selection and configuration errors, help and
listing follow §8.1; help and listing require no execution preflight.

After these checks, the runner MUST prepare the generated directory under
§5.4. Git is required for its tracked/ignored-path checks. Requested baseline
resolution additionally requires complete workspace history. Preparation
failure MUST print `Baseline input error: <reason>` and exit 1 before any
build starts; it MUST print no result rows or total line.

## 5. Common Visorfile contract

`ci2/common.visorfile` MUST begin with `MACHINE 0` and `FROM ubuntu24`.
It MUST provide the tools and staged inputs below. It MUST NOT run tests or
the dependency-policy check.

### 5.1 Tools and runtime

The common layer MUST provide:

| Capability | Required tools or version |
|---|---|
| Shell and basic utilities | bash and coreutils |
| Repository and metadata operations | git and Python 3 |
| Downloads and archives | curl, CA certificates, tar and gzip |
| Automation JavaScript runtime | Node 20.x, at least 20.17.0 |
| Automation package manager | npm 11.6.2 |
| Native dependency builds | make, a C/C++ compiler and Python |

Tools already present in the base image satisfy the requirement. Node MUST be
provisioned from the official Node 20.19.5 Linux x64 tarball
with SHA-256 `4eba5fbe1fb10753bc06e42f001a91c5cec16798b7764a3e9257adc59af47fe1`,
then npm 11.6.2 installed globally. Unsupported VM architectures MUST fail
with a diagnostic. Node and npm do not come from apt. Apt provisioning SHOULD
use cache mounts for `/var/cache/apt` and `/var/lib/apt`.

The Node selection is automation coverage, matching the major used by the
existing integration image. The pinned runtime satisfies the consumer
requirement of [overview.md §4], but does not exercise the exact minimum or
every later supported version. The minimum 20.17.0 makes the selected Node 20
runtime compatible with npm 11.6.2. Provisioning MUST record the actual runtime
and package-manager versions in its validation evidence.

Common MUST provision `docker.io`; service execution and integration
coverage belong to §6.3.

### 5.2 Source staging

Common MUST copy these inputs to the matching destinations:

| COPY source | Stage destination |
|---|---|
| `../scripts` | `/tmp/special-mail-lib/scripts` |
| `../lib` | `/tmp/special-mail-lib/lib` |
| `../tests` | `/tmp/special-mail-lib/tests` |
| `../docker` | `/tmp/special-mail-lib/docker` |
| `../index.js` | `/tmp/special-mail-lib/index.js` |
| `../package.json` | `/tmp/special-mail-lib/package.json` |
| `../package-lock.json` | `/tmp/special-mail-lib/package-lock.json` |
| `../.eslintrc.js` | `/tmp/special-mail-lib/.eslintrc.js` |
| `../.eslintignore` | `/tmp/special-mail-lib/.eslintignore` |
| `../ci2` | `/tmp/special-mail-lib/ci2` |

The staged tests MUST preserve the relative symlinks `tests/unit/lib` and
`tests/int/lib`, each pointing to `../../lib`, with their targets resolving
inside the Stage tree. Staging MUST preserve the package scripts, lint
configuration, fixtures and test paths used by the suite contracts.

The Stage tree MUST NOT contain `.git` except where the suite's own §6 entry
declares that it requires repository history and states why. No suite entry
declares that requirement. The selected baseline mechanism resolves history
on the Outer executor and copies only generated inputs into a separate VM
directory (§5.4); it does not activate a Stage tree history exception.

`.local`, `.claude` and `.codex` MUST NOT be copied into the Stage tree.
Host `node_modules` MUST NOT be copied either. After source staging and
before dependency installation, common MUST use `test ! -e` guards for
those four paths and for `.git` unless a declared history exception applies.
Installed `node_modules` created inside the VM is permitted and needed by
the suites; the pre-install guard is not a permanent-absence requirement.

Repository `scripts/` MUST be copied with the other source areas and
checked against workspace HEAD by the host resolver. This binds the checker
source to the proposed endpoint whose inputs the record certifies.

### 5.3 Locked installation

Dependencies MUST be installed from the staged manifest and lockfile with
`npm ci`, with dev dependencies included. Installation MUST NOT regenerate
or modify the lockfile. The VM MUST provide the native-build tools needed
by the locked dependencies.

Installation MUST run in common after the source COPYs and guards, before
the generated-input COPY. It MAY be cached, but MUST invalidate when the
staged manifest or lockfile changes. Common MUST compare the lockfile SHA-256
before and after installation and fail if it changes. Installing packages is
provisioning; it MUST NOT substitute for execution of a test or policy check
(§7).

### 5.4 Generated baseline inputs

The selected mechanism resolves history in the Outer executor, then copies
only the baseline pair and resolution record into the VM. The optional
`SML_BASELINE_TARGET_REF` is the invocation target string verbatim. Leaving
it unset requests no baseline; explicitly setting it empty MUST fail.
Supplying it MUST enable resolution for independent lint/unit/int selections too.
The dep-policy selection MUST require it; no default target exists.

The runner MUST exclusively create `<repository-root>/.ci2-baseline/` with
mode 0700. A pre-existing path, symlink, tracked path or git-ignored input
MUST fail without adoption or deletion. This directory MUST NOT be added to
`.gitignore`: visor2 filters ignored inputs. Concurrent invocations in one
checkout therefore fail clearly; independent checkouts may run concurrently.

Without a requested baseline, the directory MUST contain only a regular
`not-requested` file with bytes `not-requested\n`. This is provisioning-only
state, not an empty dependency pair or a policy pass. With a requested
baseline it MUST contain exactly regular `package.json`, `package-lock.json`
and `record.json` files generated by this invocation, never maintained by
the change author.

Requested preparation MUST perform these operations in order:

1. Reject shallow, partial/promisor or grafted history. Git commands MUST
   disable lazy fetching and replacement objects. Missing objects MUST fail;
   preparation MUST NOT fetch, deepen or substitute history.
2. Resolve C from this workspace's `HEAD^{commit}` and T from the exact
   target input with option termination. Require staged source areas (§5.2)
   to match C, including untracked/ignored files and both proposed files.
   Assume-unchanged and skip-worktree entries in those areas MUST fail.
3. Run `git merge-base --all T C` and require exactly one result B. B is
   the baseline, not either endpoint by assumption. Equality is permitted
   only when established by Git; no default branch, target tip, previous
   commit, synthetic parent, empty pair or working-tree fallback is allowed.
4. Extract both root files together with one `git archive B -- package.json
   package-lock.json` operation into the generated directory. Require exactly
   the two regular members and compare each file with its blob at B; archive
   attributes MUST NOT silently omit or substitute either file.
5. Parse both JSON objects, require an integer baseline `lockfileVersion`,
   and recheck HEAD and source state. Publish `record.json` last by atomic
   rename after the complete pair and its SHA-256 identities are available.
   This layer does not implement the checker's lockfile walk.

The record MUST contain exactly these fields:

| Fields | Type and meaning |
|---|---|
| `schema_version` | Integer 1 |
| `run_id` | Fresh cryptographically random 32-byte value, lowercase hex |
| `target_ref` | Original nonempty UTF-8 target string, without normalization |
| `target_commit`, `review_commit` | Full immutable commit IDs T and C |
| `baseline_ref`, `baseline_commit`, `manifest_ref`, `lockfile_ref` | Full immutable commit ID B, equal across all four fields |
| `merge_base_verified` | Boolean true, after successful unique resolution |
| `lockfile_version` | Actual integer baseline lockfileVersion |
| `manifest_sha256`, `lockfile_sha256` | SHA-256 of the extracted baseline bytes |
| `review_manifest_sha256`, `review_lockfile_sha256` | SHA-256 of the proposed workspace pair |

Commit IDs MUST be lowercase hexadecimal Git object IDs of 40 or 64
characters; SHA-256 values MUST be 64 lowercase hexadecimal characters.

Common MUST COPY `../.ci2-baseline` to `/tmp/special-mail-lib-baseline`
**after** cached installation. The proposed pair remains at the repository
root on the host and `/tmp/special-mail-lib/` in the VM. Neither landing of
the baseline may overwrite either proposed file. Source workspaces MUST
remain quiescent during preparation and their build.

The runner MUST discard inherited `SML_BASELINE_RUN_ID` and
`SML_BASELINE_TARGET_B64` and supply freshly derived values in memory to
Capture. Capture MUST append these argv pairs to its real visor2 build:

* `--build-env SML_BASELINE_RUN_ID=<fresh-hex-id>`
* `--build-env SML_BASELINE_TARGET_B64=<base64-of-original-UTF8-target>`

Only safe hex/base64 alphabets travel through the build environment; the
raw target MUST NOT be shell-evaluated or exported by visor2. No expected
identity file may accompany the copied record. Both values are empty when
baseline preparation is unrequested. Each leaf MUST declare both BUILDENVs
after common INCLUDE and `SNAPSHOT OFF`, before a fresh preparation RUN.

That RUN MUST validate the exact record schema, fields and types, equal
baseline refs, actual lockfileVersion, both baseline digests and both proposed
pair digests. It MUST compare run ID against the independent invocation ID
and strictly decode the target input and compare UTF-8 bytes to `target_ref`.
Any mismatch MUST fail before the suite command. A stale pair and record
MUST fail freshness even if their target and all digests still agree.
Unrequested state permits only both empty invocation values and the sole
valid sentinel. Any mixture with a pair or record MUST fail.

These VM checks are consistency assertions, not an independent Git
merge-base calculation. They cannot detect consistently false commit IDs or
a false merge-base claim. The checked host resolver, disjoint extraction,
blob comparisons and discriminating Git fixtures constrain those errors;
the independent fresh ID constrains cached record reuse. Target selection
and trusted resolver execution remain boundaries. A history-bearing VM could
also resolve the invocation target and compare its commit, but this chosen
mechanism does not claim that additional verification.

Normal wrapper success, failure and signal cleanup MUST remove only the
generated directory that invocation created, after its launched helpers
finish. An uncatchable termination may leave it behind; the next invocation
MUST fail closed. Section 8.6 specifies independently prepared ownership.

## 6. Leaf Visorfiles and suites

STARTINTENT
The user selected full test parity, including the docker-compose and
PostgreSQL integration coverage.
The automation MUST provide lint, unit, integration and dependency-policy
coverage; integration coverage MUST NOT be silently omitted.
ENDINTENT

The registered suites are:

| Leaf | Suite | Commands or Contract | Repository history |
|---|---|---|---|
| `ci2/lint.visorfile` | `lint` | Fresh baseline input check (§5.4), then `npm run lint` (§6.1) | None in VM; requested preparation uses host history |
| `ci2/unit-tests.visorfile` | `unit` | Fresh baseline input check (§5.4), then `npm run unit-tests` (§6.2) | None in VM; requested preparation uses host history |
| `ci2/int-tests.visorfile` | `int` | Baseline check, PostgreSQL readiness, then full `npm run int-tests` and cleanup (§6.3) | None in VM; requested preparation uses host history |
| `ci2/dep-policy.visorfile` | `dep-policy` | Baseline check and dependency policy (§6.4) | Complete host history; none in VM |

Each registered suite MUST have exactly one leaf and one row. Promotions
MUST preserve detailed contracts, acceptance scenarios and cross-reference
targets. All four contracts below are live; their INTENT content persists.

Every executable suite leaf MUST start with `INCLUDE ./common.visorfile`,
then `SNAPSHOT OFF` before any RUN. It MUST use one ordered RUN per logical
suite command. Service setup, dependency installation and baseline
preparation MAY precede the actual test or check below `SNAPSHOT OFF`.
A nonzero suite command MUST fail the build and the runner's result.

### 6.1 Lint

The `lint` suite MUST use `ci2/lint.visorfile` and run
`RUN cd /tmp/special-mail-lib && npm run lint` against the staged repository.
The package script runs `eslint ./`; the original `.eslintrc.js` and
`.eslintignore` and installed dev dependencies MUST be available. The lint
scope MUST NOT be narrowed to a hand-picked source subset.

Repository history: this suite does not require it.

Acceptance scenarios: the command and working directory match this
contract; staged lint configuration is used; a lint violation in the
configured scope fails the leaf; host `node_modules` cannot supply lint
tools in place of the locked VM install.


### 6.2 Unit

The `unit` suite MUST use `ci2/unit-tests.visorfile` and run
`RUN cd /tmp/special-mail-lib && npm run unit-tests`. It MUST preserve the
package script's `NODE_PRESERVE_SYMLINKS=1` and Mocha glob
`tests/unit/**/test-*.js`. Its test symlink MUST resolve to the staged
library, and its dependencies MUST come from the locked VM install.

Repository history: this suite does not require it.

Acceptance scenarios: every test selected by the existing glob is reached;
the symlink environment and in-stage resolution hold; a failing unit test
fails the leaf; neither copied host modules nor a narrowed test list hides
that failure.


### 6.3 Integration

The `int` suite MUST use `ci2/int-tests.visorfile` and reach every existing
integration test through `npm run int-tests`, preserving
`NODE_PRESERVE_SYMLINKS=1` and `tests/int/**/test-*.js`. It MUST supply the
PostgreSQL `queue` user/database and `pgcrypto` prerequisites and the
database connectivity those tests require.

The accepted implementation runs `postgres:12.13` in the VM-local Docker
service and tests on the Node VM against the Stage tree. It MUST mount the
unchanged staged `docker/int/postgres/initdb.d` read-only and retain the
existing integration credentials. The developer compose stack and wrapper
remain unchanged. The CI path preserves its database and test coverage;
separate lint/unit leaves replace those commands in the auxiliary `sml`
container. CI exercises no host home or identity-file mounts.

After the fresh §5.4 assertion, one Bash RUN MUST own setup, tests and EXIT,
INT and TERM cleanup. Docker operations MUST explicitly use the VM-local
Unix socket with sudo, no host socket or remote configuration. Service
startup/readiness MUST be bounded to 60 seconds, with no silent fallback.
The suite MUST reject existing `db` resolution or a loopback port 5432
listener, then add only its unique `127.0.0.1 db` hosts entry. Image pulling
MUST have a 300-second bound and report the resolved image identity.
The uniquely named container MUST publish only `127.0.0.1:5432`, without
privileged mode, restart policy or persistent named volumes.

Readiness MUST use the locked `pg` client over `db:5432`, with bounded
connection/query attempts and client closure, for at most 120 seconds.
It MUST verify user/database `queue`, server version number `120013` and
`pgcrypto`, and fail immediately if the container exits. Tests MUST follow
readiness; service/test failures MUST fail the leaf with diagnostics.
Cleanup MUST preserve the primary failure, make cleanup failure fail an
otherwise successful run, and verify removal of only the owned container,
anonymous volumes, hosts entry and temporary metadata. It MUST stop Docker
only if this RUN started it and MUST NOT prune shared Docker state.
Cleanup commands MUST be bounded. Uncatchable VM termination cannot promise
shell-trap completion; the suite intentionally creates no external resources.

If the available VM cannot provide the selected coverage, implementation
MUST stop for user clarification rather than narrow or omit integration
tests silently. Running the host wrapper unchanged is not a requirement.

Repository history: no requirement is declared for this suite.

Acceptance scenarios: all existing integration tests execute with the
database prerequisites and resolved test symlink; testing waits for
readiness; startup and test failures fail the leaf; resources are cleaned
up after success and failure; an unsupported setup leads to clarification,
not a successful skipped suite.

### 6.4 Dependency policy

The `dep-policy` suite MUST use `ci2/dep-policy.visorfile` to run
`scripts/check-dependency-policy.js` against the proposed dependency state
and the resolved pre-change manifest/lockfile pair. Its ledger and upgrade
record MUST be staged at `ci2/policy/dependency-policy.yaml`, relative to
the Stage tree. Sections 6.4.1–6.4.4 specify the file schema, collection,
arguments, report and exit codes.

The suite MUST apply [dependency-upgrades.md §10] in order, within the
enforcement boundary of [dependency-upgrades.md §8]. It first establishes
and validates the states, then determines scope over both, then age-checks
every newly-introduced pair in a concluded policed set with exact waiver
matching. It MUST NOT implement a blanket audit-severity threshold.
A concluded unpoliced set passes without publish-time lookup. Invalid or
inconclusive required inputs stop before any exemption is concluded.

The baseline mechanism MUST resolve the manifest and lockfile together
from the change set's own merge-base, independently of its author, as
[dependency-upgrades.md §4.3] requires. The current invocation's resolution
evidence MUST bind both comparison endpoints and the pair it certifies;
an author-editable record, unrelated historical ref, empty pair or working
tree fallback MUST NOT substitute for that resolution.

The selected mechanism is the live outer-executor resolver and generated
COPY contract of §5.4. Every selection containing dep-policy MUST require
`SML_BASELINE_TARGET_REF` and forward the independent invocation values; an
independent build uses §8.6 with this leaf filename. The checker MUST require
a complete prepared record and apply the same current-input assertions;
the unrequested sentinel can never satisfy it. Missing or empty target input
MUST fail before any VM launches; there is no default target or unpoliced
fallback. Independent lint/unit/int selections retain optional baseline input.

Repository history: complete history is required only on the Outer executor
for baseline resolution. No Git history is copied into the VM, and §5.2's
Stage tree exception is not activated.

Violations MUST identify the instances and declared drivers putting the
change set in scope and each violating entry, as [dependency-upgrades.md
§10] requires. Invalid or inconclusive required inputs and failed assigned
checks MUST fail the leaf. The runner treats any nonzero leaf exit as
failed, independently of the checker's more detailed exit-code scheme.

Acceptance scenarios: unresolved or substituted pre-change input fails;
resolution, policy decisions and metadata lookups use current-run inputs;
a concluded unpoliced set performs no publish-time lookup; a policed set
age-checks advisory-free transitive entries too; unavailable publish time
or an under-age entry without an exact applicable waiver fails; the report
identifies drivers and violating entries. Procedural rules in
[dependency-upgrades.md §8] are not misrepresented as mechanically proved.

### 6.4.1 Invocation and decision

The leaf MUST place the two §5.4 BUILDENV declarations after `SNAPSHOT OFF`,
then execute one fresh RUN from `/tmp/special-mail-lib`:
`node scripts/check-dependency-policy.js --baseline-dir
/tmp/special-mail-lib-baseline`. That process MUST check the baseline record
before acquiring advisories. The package's `dep-policy` script invokes the
same checker. The CLI accepts only optional, nonrepeated `--project-dir <path>`
and `--baseline-dir <path>` arguments. Defaults are the checker repository
root and `<project-root>/.ci2-baseline`. Missing values, duplicate options and
unknown arguments MUST exit 2. No CLI or environment switch substitutes a
clock, registry, advisory response, publish time, target identity or scope.

The checker MUST validate the exact §5.4 schema, identities, digests and
independently forwarded run/target values. Baseline and proposed files MUST
be regular, disjoint inputs; a sentinel MUST fail. It MUST recheck source
pair bytes after collection. These remain consistency assertions against
the host resolver's evidence, with §5.4's trust boundary.

Both lockfileVersion 2 and 3 MUST be read through `packages`. Version 1,
missing root/packages, malformed dependency maps and unsupported workspace,
link, bundled, alias or non-registry entries MUST fail with exit 2. Manifest
and root dependency fields MUST agree. The same four-field, nearest-ancestor
placement walk MUST reach every installed entry in both states. Optional
edge declarations override regular declarations. Uninstalled edges contribute
no node. Paths MAY repeat a name at different installed nodes; they MUST NOT
repeat an installed node. No path-count truncation is permitted.

Only covering `via` objects supply advisory severity and ranges. Bare `via`
strings and `effects`, `nodes`, report keys and entry aggregate severity/range
MUST NOT supply topology or instance identity. Advisory source identifiers
and URLs remain explanatory metadata; a propagated object's nullable URL
MUST NOT alter its package/version/severity/name-chain key. Same-severity
objects on one chain deduplicate; distinct severities remain distinct.
The completed pre/post difference and widening-only declarations determine
scope before publish-time or waiver checks.

### 6.4.2 Advisory snapshot and publish metadata

The checker MUST use the installed npm 11.6.2 beside the active Node binary,
including its bundled semver with `includePrerelease: true` and `loose: true`
for advisory ranges. A missing or different npm installation MUST fail.

One fresh POST of the union of both installed name/version inventories to
`https://registry.npmjs.org/-/npm/v1/security/advisories/bulk` MUST supply
both audits. An ephemeral loopback registry adapter MUST answer each npm
bulk request from that retained response, filtered only by submitted names,
and verify that the request inventory equals the respective full state.
A nonempty state MUST issue exactly one bulk request; root-only states may
omit it. Package metadata requests MUST be confined to union names, fetched
once per name with a shared pending promise, and served from frozen full JSON
bytes. The snapshot is one bulk response plus per-name captured metadata;
it does not claim an atomic registry-wide revision.

Both audits MUST run sequentially against isolated copies of the validated
pairs using identical npm options: `audit --package-lock-only --include=dev
--include=optional --include=peer --json`, the loopback registry, online
auditing and disabled scripts. They MUST use distinct empty user/global
config files and fresh caches, with inherited npm configuration and Node
injection settings removed. Copies MUST contain no project npmrc, shrinkwrap
or installed modules. Audits MUST preserve their input pair bytes.

Exit 0 or 1 from npm is usable only with a complete auditReportVersion 2
report, valid advisory/metadata shapes and matching inventories. An npm
vulnerability exit alone is not a policy violation. Upstream failure,
unexpected routes, malformed bodies and swallowed packument errors MUST be
retained independently of npm's result and fail the checker. Requests,
responses and child processes MUST have finite size/time bounds with errors
on exceeded bounds. Child, server and isolated-audit resources MUST be cleaned
up on success or failure; no failed fetch may become an empty successful map.

Evidence MUST retain the exact bulk request/response, raw audits and captured
packuments, source URLs, UTC collection times, npm version, payload/body
hashes and the digest of the sorted per-packument index. The resulting
snapshot identity and evidence location MUST appear in the report. Hashes
alone are not a promise to reconstruct vanished registry data.

Only after a policed result, every new pair MUST use the full public registry
packument's `time[exactVersion]`. Within a run, publish responses MUST be
shared by name; a full captured packument with time data MAY be reused.
No persistent age cache is trusted. The run's UTC check time, 336-hour exact
boundary and unavailable/future-time failure rules follow
[dependency-upgrades.md §3.2]. Waivers cannot establish unknown publish time.
Known violations and metadata errors MUST both be reported when present.

### 6.4.3 Ledger schema and waiver matching

The checked-in YAML file MUST begin with this empty policy data until a real
record or user-authorized waiver is needed:

```yaml
schema_version: 1
upgrade_record: null
waivers: []
```

The top-level fields are `schema_version` (1), `upgrade_record` (null or an
object) and `waivers` (a list, consumed in policed results). Missing ledger,
YAML syntax errors, duplicate YAML keys, invalid schema and malformed
consumed declarations MUST exit 2. An absent upgrade record declares nothing.
The record may carry these fields:

| Field | Content |
|---|---|
| `upgrades` | List of package/from_version/target_version transitions, with `advisory_ids` referencing advisory IDs |
| `advisories` | List of declared drivers, each with nonempty string `id`, `package` and advisory `severity` |
| `waiver_refs` | List of referenced waiver IDs |
| `date` | Record authoring date; never the gate's reference time |
| `note` | Procedural selection explanation when required by dependency policy |

Declarations only widen scope. Record completeness, upgrade motive,
remediation sufficiency, target ranking/note and user authorship remain
procedural under [dependency-upgrades.md §8]. Missing unrelated procedural
fields MUST NOT block a completed unpoliced result.

Each waiver has a unique nonempty `id`, `scope`, `admitted_entries`, `drivers`,
nonempty `user_statement` and a nonfuture UTC authorization `date`.
`admitted_entries` lists objects with `package` and exact `version`; neither
ranges nor implicit transitive coverage is permitted. A waiver must be
explicitly referenced by the record. Invalid, unreferenced or inapplicable
coverage MUST NOT admit an entry; duplicate IDs MUST fail a policed check.

`drivers` has `derived` and `declared` lists. Derived entries identify complete
removed keys using `package`, `version`, `severity` and `chain` (a name list).
Declared entries identify the record's `id`, `package` and `severity`.
Canonical set comparison ignores list order and explanatory source metadata.
A waiver's nonempty driver evidence MUST belong to the effective driver set.

Upgrade scope is `{kind: upgrade, package, from_version, target_version}`.
It MUST match a recorded state-matching numerical version increase, with the
from-version installed before and target version installed after. The waiver
may enumerate explicitly authorized under-age transitive pairs for that
upgrade. Change-set scope is `{kind: change-set}` with exactly the complete
effective driver set. It MUST NOT apply when an upgrade is expressible: a
common chain's version increases, a newly introduced same-name version is
higher than a pre-change version, or the record declares a state-matching
increase. Uncertain correspondence does not authorize the broader form.
An unpoliced result MUST precede waiver validation and publish lookup.

### 6.4.4 Reporting and acceptance scenarios

The checker MUST return 0 for a completed unpoliced or compliant policed
result, 1 for known cooldown violations with complete metadata, and 2 for
usage errors, invalid inputs or inconclusive metadata. The outer runner
continues mapping every nonzero leaf status to a failed row and exit 1.

Text MUST identify the outcome, concrete removed instances, declared drivers,
each violating pair's publish time, age, adoptable-from time and unmatched
waiver reason. A JSON result in a fresh VM evidence directory MUST retain
baseline and snapshot identities, check time, state/instance counts, drivers,
new pairs, age/waiver decisions and errors. Reports MUST NOT expose credentials
or claim to prove the author of a recorded statement.

In addition to §6.4's scenarios, contract tests MUST cover the captured
transitive-young, complete-remediation, shared-hoisted partial-fix,
still-vulnerable bump, unchanged intermediate bump, and per-chain severity
fixtures. They MUST discriminate optional/dev/peer coverage, repeated names
and cycles, exact instance identity, supported/unsupported lock structures,
unavailable metadata, the exact 336-hour boundary, exact waiver references
and scope, single snapshot acquisition, frozen packuments, swallowed errors,
malformed reports and independent invocation identity. Real captured reports
remain unedited input data; intentional corruption cases identify themselves.
Failure-before-fix evidence uses only §9's authorized full automation.

## 7. Snapshot policy

`SNAPSHOT OFF` MUST appear immediately after the common INCLUDE in each
executable suite leaf and before its first RUN. Common provisioning and
locked installation MAY be cached subject to §5.3's input invalidation.

Tests and policy decisions MUST execute on each current invocation.
Run-specific baseline preparation and publish-time lookup MUST NOT reuse
a cached passing check or stale run result. A provisioning cache hit is not
evidence that a current test or policy decision passed.

## 8. Automation runner interface

The ordinary runner behavior is a near-verbatim port of the sibling
runner precedent, adapting suite selection, help and listing to this
project. Its baseline additions implement §5.4 and §8.6; capture, replay,
cancellation and report behavior remain as specified here.
The port adds no separate runner self-test (§1.2).

### 8.1 Usage and selection

```
ci2/scripts/test-automation.sh [--suite <suite>] [--fail-fast] [--list]
ci2/scripts/test-automation.sh --prepare-baseline
```

1. Without `--suite`, the runner MUST select `all`.
2. `all` MUST select every registered suite in the order `lint`, `unit`,
   `int`, `dep-policy`, restricted to the live entries in §6. Each other
   registered selector MUST select only its own leaf. Missing registered
   files fail preflight; they MUST NOT silently reduce `all`.
3. Availability MUST come from registration, not file discovery. Future
   names remain unselectable even if a corresponding unregistered leaf
   file exists. Help and listing MUST reflect only `all` and current
   registered selectors, in that order.
4. `--suite` MUST appear at most once and have a value. A repeated
   `--suite`, missing value, unknown or unregistered suite, or unknown
   argument MUST print `Usage error: <reason>` and usage to stderr and
   exit 2 before any execution.
5. `-h` or `--help` MUST print usage and exit 0. `--list` MUST print
   `Suites:` followed by `all` and every current registered selector,
   one per line indented by two spaces, then exit 0. Neither performs
   execution preflight or invokes visor2.
6. Selecting an included non-leaf, or encountering an INCLUDE path that
   resolves outside the direct `ci2/*.visorfile` set, MUST print
   `Configuration error: <reason>` to stderr and exit 1 before any build.

### 8.2 Execution

1. After preflight and required input preparation, the runner MUST launch
   every selected build before waiting for a result, with one background
   Capture helper per build, unlimited concurrency and no concurrency
   option.
2. Each visor2 build MUST run in its own process group with the Repository
   root as its working directory. Capture MUST store stdout and stderr
   separately in the runner's temporary directory, then record exit status
   and elapsed time when the build ends.
3. Completed build transcripts MUST replay whole in completion order,
   without interleaving builds and with stdout/stderr separation preserved.
   Each MUST begin with `==> visor2 build --no-interactive <ci2/file>`.
   Any baseline argument forwarding is declared with §6.4's input channel;
   transcripts need not expose private input values.
4. Without `--fail-fast`, the runner MUST wait for every launched result.
   With it, the first failed result MUST cancel still-running build process
   groups with TERM, then KILL after the cancellation grace period.
   Canceled builds MUST NOT be replayed, reported or counted.
5. On EXIT, INT or TERM, the runner MUST terminate outstanding build
   process groups the same way and remove temporary files. INT MUST exit
   130 and TERM MUST exit 143.

### 8.3 Final report

After replays, when at least one build was launched, the runner MUST print
one row per noncanceled launched build in launch order:

```
<ci2/file> <ok|failed> <m>m<ss>s
```

`ok` means the build exited 0. A nonzero exit, or a Capture helper ending
without recording a status, means `failed`. Duration MUST be elapsed wall
time from immediately before invoking visor2 until it exits, floored to
whole seconds, with unpadded minutes and two-digit seconds: `0m05s`,
`1m23s`, `12m04s`.

The rows MUST be followed by exactly one line:

```
total <n> ok <ok> failed <failed>
```

The counts MUST match the printed rows, with `<n> = <ok> + <failed>`.
The runner MUST exit 1 if any row is failed and 0 otherwise. Help, listing,
usage errors, configuration errors and preflight failures MUST print no
result rows or total line.

### 8.4 Full-suite wrapper

`ci2/scripts/all-tests.sh` MUST reject any `--suite` or `--suite=*`
argument with a usage error on stderr and exit 2 before running anything.
Otherwise it MUST exec the Automation runner with `--suite all` followed
by the forwarded arguments. It always runs the complete registered set.

### 8.5 Environment knobs

The runner and Capture helper MUST honor:

| Variable | Default | Meaning |
|---|---|---|
| `VISOR2_BIN` | `visor2` | Executable used by preflight and Capture. |
| `PYTHON_BIN` | `python3` | Interpreter used to compile and run the Capture helper. |
| `VISOR2_PREFLIGHT_TIMEOUT` | `10` | Seconds allowed for §4's help probe. |
| `TEST_AUTOMATION_CANCEL_GRACE_SECONDS` | `0.2` | Seconds between TERM and KILL during cancellation. |
| `TEST_AUTOMATION_POLL_SECONDS` | `0.05` | Seconds between completion polls. |
| `TEST_AUTOMATION_TMPDIR_FILE` | unset | If set, the runner writes its temporary-directory path to this file after creation. |

Baseline-specific input is `SML_BASELINE_TARGET_REF` (§5.4). Run ID and encoded
target build environments are outputs derived by the runner, not caller
overrides for runner-mediated builds.

### 8.6 Independent baseline preparation and build

`--prepare-baseline` MUST require the target input, use the same resolver and
preflight, launch no VM, and retain successful generated inputs for the
caller. It MUST be mutually exclusive with `--suite`, `--list`, `--fail-fast`
and repeated preparation flags; violations are usage errors with exit 2.
Its stdout MUST be exactly one JSON object containing `run_id` and
`target_ref_b64`. Diagnostics use stderr. Failure MUST remove only its own
partial inputs. The caller MUST keep successful inputs until its build ends,
then remove only its own generated directory.

The Full-suite wrapper always supplies `--suite all`, so forwarding
`--prepare-baseline` through it MUST fail with a usage error; it cannot
produce preparation-only validation evidence.

This complete independent-build recipe runs from the Repository root and
keeps the returned identity in memory, using argv rather than shell parsing:

```sh
SML_BASELINE_TARGET_REF=refs/remotes/origin/master python3 - <<'PY'
import json
from pathlib import Path
import shutil
import subprocess

inputs = Path.cwd() / ".ci2-baseline"
prepared = json.loads(subprocess.check_output(
    ["ci2/scripts/test-automation.sh", "--prepare-baseline"], text=True))
identity = inputs.stat()
try:
    result = subprocess.run([
        "visor2", "build", "--no-interactive", "ci2/lint.visorfile",
        "--build-env", "SML_BASELINE_RUN_ID=" + prepared["run_id"],
        "--build-env", "SML_BASELINE_TARGET_B64=" + prepared["target_ref_b64"],
    ])
finally:
    if not inputs.is_symlink() and inputs.is_dir():
        current = inputs.stat()
        if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
            shutil.rmtree(inputs)
raise SystemExit(result.returncode)
PY
```

The same recipe supports `ci2/unit-tests.visorfile`, `ci2/int-tests.visorfile`
and `ci2/dep-policy.visorfile`. This documented interface grants no additional
agent-validation authorization beyond §9.

## 9. Project-authorized validation

STARTINTENT
`ci2/scripts/all-tests.sh` is this project's Project-authorized Automation.
By explicit user authorization, agents MAY run that command and cite its
output as validation evidence. This authorization names
`ci2/scripts/all-tests.sh`; it does not authorize `npm run all-tests` as
agent validation.
ENDINTENT

Testing Evidence citing a run MUST record the exact command line, per-leaf
rows, total line and exit code. It MUST identify the suites registered for
that run. A run containing only lint and unit, or lint, unit and dep-policy,
is evidence only for those suites, not proof of the final four-suite goal.
Failure-before-fix evidence for a new test MUST record both failing and
passing authorized runs.

When automation is unavailable, Testing Evidence MUST record an omitted-test
rationale. Spec publication alone supplies neither a CI run nor evidence
of success. For outer runner or Visorfile behavior without automated
negative tests, evidence MUST identify the static review performed and the
available authorized run, or explain why execution was unavailable.

Direct `npm run lint`, `npm run unit-tests`, `npm run int-tests`,
`npm run all-tests`, `npm test`, `tests/int/run.sh`, and direct compose or
test invocations remain Local Test Flows and MUST NOT be cited as agent
validation under this authorization. Documentation of direct visor2 builds
and the Automation runner's selector interface does not separately
authorize them as agent validation.

Commands executed internally by a real authorized Full-suite wrapper run
are part of that run's evidence. Its integration result may therefore
provide integration-suite evidence without a separately authorized direct
`--suite int` invocation. Authorizations belonging to other projects are
not imported by the runner port.

## 10. Tests checklist

### 10.1 Selection and layout

* The required paths and exactly three helpers follow §2, with Visorfiles
  directly under `ci2/` and relative INCLUDEs confined to that directory.
* Default selection and `all` select every registered leaf in §8.1's
  order; each registered selector chooses exactly its own leaf.
* Help and listing show only current selectors, and run no preflight or
  visor2 invocation. FUTURE names and unregistered files are not selected.
* Missing, repeated, unknown and unregistered suite values and unknown
  arguments fail with usage errors and exit 2.
* A selected non-leaf or invalid INCLUDE fails with configuration error
  and exit 1; a missing registered file fails preflight without reducing
  the selected set.

### 10.2 Preflight and credentials

* Each of §4's seven preflight items fails with its diagnostic and exit 1
  before any VM starts, including a missing command, invalid Capture
  helper, timed-out help probe or missing selected file.
* Invocation from another working directory resolves the same Repository
  root and passes it to every build.
* No repository file or automation-generated configuration embeds visor2
  credentials; configured Outer executor authentication supplies access.
* Declared-input preparation fails before dependent builds are launched.

### 10.3 Common layer

* The VM provides every capability and selected Node/npm version of §5.1;
  evidence records those versions without claiming coverage of the exact
  consumer minimum of [overview.md §4] or every later supported version.
* All §5.2 COPY inputs reach their matching destinations; both test
  symlinks resolve to the staged `lib/`.
* Forbidden-copy guards run after staging and before install; `.git`
  admission is justified only by an explicit §6 history declaration.
* The locked install includes dev dependencies, creates VM `node_modules`
  without host modules, and leaves the lockfile unchanged. Manifest or
  lockfile changes invalidate any installation cache.
* Common runs no test or policy check.

### 10.4 Suites and snapshots

* Every registered suite has exactly one leaf and live-table row. Its
  commands and scenarios match its promoted §6 contract, including the
  exact package commands for lint and unit when registered.
* All suite-specific acceptance scenarios in §6 are live. Full-coverage
  validation reaches all four suites required there.
* `SNAPSHOT OFF` follows INCLUDE and precedes every suite RUN. Changed
  tests execute, and current baseline preparation, policy decisions and
  publish-time lookups are not replaced by cached results.

### 10.5 Reporting, concurrency and cancellation

* All selected builds launch before any result wait, without a concurrency
  limit; each build has its own process group and separate output capture.
* Transcripts replay whole in completion order with their headers and
  stdout/stderr separation; rows follow launch order.
* Zero, nonzero and missing captured statuses map to the specified results;
  elapsed durations are floored and formatted with two-digit seconds.
  Exactly one total line counts precisely the printed rows.
* A failing suite fails the leaf and runner. Without fail-fast all launched
  results are collected. With fail-fast, canceled builds are terminated,
  excluded from replay and counts, and the failure still yields exit 1.
* EXIT, INT and TERM clean up outstanding groups and temporary files; INT
  exits 130 and TERM exits 143. Pre-execution exits print no result rows.

### 10.6 Wrapper and validation evidence

* The Full-suite wrapper rejects both suite-override forms with exit 2 and
  forwards other arguments after `--suite all`.
* Evidence names `ci2/scripts/all-tests.sh` exactly, with command, rows,
  total and exit status. The registered set bounds the claimed coverage.
* Internal suite commands count only as part of an actual authorized run;
  direct Local Test Flows and documentation of selectors supply no extra
  authorization. Unavailable execution is recorded explicitly.

### 10.7 Baseline preparation and current-input checks

* Ordinary and synthetic-merge workspace fixtures resolve the supplied
  target against the actual checked-out commit. Expected B differs from
  the supplied target tip, default tip/default merge-base and near-side
  parent; the synthetic case also differs from its base parent.
* Both extracted halves equal B, while each source proposed half remains
  unchanged and differs from B. VM landings preserve the same separation.
* Missing required, empty or unknown targets, shallow/partial history,
  missing objects and absent or non-unique merge-bases fail before builds,
  without fallback. Dirty copied source areas also fail preparation.
* Pre-existing, symlink, tracked or ignored generated inputs fail without
  adoption or deletion; cleanup removes only invocation-owned inputs.
* Missing fields, incomplete pairs, altered baseline/proposed halves and
  an invocation-target mismatch fail the fresh check before suite execution.
* A cached prior pair/record with matching target and digests fails against
  a new independent invocation ID. Evidence identifies actual COPY cache
  reuse and freshness as the failing check.
* Independent lint/unit/int selections can run without a requested baseline
  and make no policy success claim. Any selection containing dep-policy
  requires the complete prepared input; `all` therefore requires a target.
* Independent preparation emits only its JSON identity on stdout and leaves
  successful inputs for its caller; its mutually exclusive options cannot
  bypass the Full-suite wrapper. Dynamic fault evidence comes from disposable
  checkouts and real authorized full runs, with failing and corrected cases.
