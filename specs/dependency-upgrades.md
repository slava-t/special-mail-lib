# Dependency Upgrades Spec (v1.0)

This spec governs dependency upgrades, publish-age checks, the determination
of a policed change set, and the waiver and upgrade-record protocol. It
separates policy applied procedurally from checks assigned to the gate (§8).
The gate requirements are implemented by the automation specified in
[test-automation.md §6.4]; procedural policy remains separately applicable.

## 0. Glossary

* **Advisory**: a report identifying a vulnerable package, its affected
  versions and its severity, with an identifier supplied by its source.
* **Advisory source**: the npm registry's advisory data for the package.
* **Severity**: the advisory source's scale: critical, high, moderate or low.
  Critical and high are the two levels that can drive an upgrade.
* **Dependency state**: a `package-lock.json` together with the `package.json`
  from which it was generated.
* **Pre-change state**: the change set's own dependency state before the
  change, established under §4.3.
* **Post-change state**: the dependency state the change set proposes to adopt.
* **Change set**: the proposed transition between those two states, including
  its upgrade record and any waivers.
* **Lock entry / installed node**: one `packages` entry other than the root
  entry, identified by its installed location.
* **Root dependency**: a package the root manifest names in `dependencies`,
  `devDependencies`, `optionalDependencies` or `peerDependencies`.
* **Dependency chain / path**: the ordered chain of package names from a root
  dependency to an installed package, with the walk and bound of §4.2.
* **Advisory instance**: the tuple of vulnerable package, resolved version,
  severity and path defined by §4.1.
* **Driver**: evidence that puts a change set within the policy gate's scope:
  a removed critical or high advisory instance, or a declared advisory.
* **Derived driver set**: the pre-change critical and high instances that no
  longer hold in the post-change state (§4.4).
* **Declared driver**: an advisory identified in the upgrade record as driving
  the change set (§6); its declaration can only widen scope.
* **Effective driver set**: the derived driver set together with any declared
  drivers (§4.4).
* **Policed change set**: a change set whose effective driver set is non-empty
  after a completed determination under §4.
* **Newly-introduced entry**: a package-name and exact resolved-version pair
  installed after the change but not before it, independent of location (§3.4).
* **From-version**: the package's pre-change installed version for the recorded
  transition.
* **Target version**: the post-change version adopted for that transition.
* **Upgrade**: a transition to a version above that package's from-version.
* **Downgrade**: a transition to a version below that package's from-version.
* **Publish time**: the registry timestamp for publication of an exact package
  version (§3.2).
* **Publish age**: elapsed time from publish time to check time.
* **Cooldown**: the 14-day minimum publish age of §3, subject to §5's waiver.
* **Check / check time**: the publish-age assessment and its reference time:
  selection time for a human or agent, or gate-run time for the gate (§3.2).
* **Gate / gate-run time**: the dependency-policy check performed by the
  project's authorized test automation, and the time of that check.
* **Waiver**: recorded user authorization to admit the exact entries listed
  despite the cooldown, under §5.
* **Ledger**: the checked-in structured record of waivers (§5.2).
* **Upgrade record**: the checked-in structured evidence of a change set's
  upgrades, remediated advisories and waiver references (§6).
* **Project's authorized test automation**: the automation defined by
  [test-automation.md §9].

## 1. Goals and non-goals

### 1.1 Goals

* State when a dependency may be upgraded and which target versions qualify.
* Identify policed change sets and the entries age-checked inside them.
* Define waiver authorization, its recorded evidence and exact coverage.
* Define the upgrade record and the enforcement boundary for each rule.

STARTINTENT
The policy ships with tooling and a CI gate, not as a spec alone.
Every rule §8 marks `gate` MUST be delivered as gate enforcement by the
project's authorized test automation.
The user chose this deliverable scope over a policy document by itself.
ENDINTENT

### 1.2 Non-goals

* The automation contract: layout, runner, suites and gate invocation.
  [test-automation.md §2] through [test-automation.md §8] own those subjects.
* The checker's algorithm, report format and exit code beyond the policy here.
* The dependency set and packaging fields pinned by [overview.md §4]; §9
  states the boundary.
* Moderate and low advisories as upgrade triggers.
* The Node runtime version and vulnerabilities in the library's own code.

## 2. Trigger and coverage

### 2.1 Trigger and target version

STARTINTENT
A dependency MUST be upgraded only to remediate a critical or high advisory,
and MUST NOT be upgraded for routine maintenance; moderate and low
advisories do not trigger an upgrade. The user directed that not all
dependencies are upgraded, only those with high vulnerabilities, and chose
critical and high as the trigger severities.
ENDINTENT

The remediated advisory may affect the upgraded package itself or a package
reached through it. Upgrading a dependent to remediate a transitive advisory
therefore falls within the trigger's scope.

A remediation adopting a version MUST resolve the driving advisory on the
remediated paths and MUST satisfy §3. For a directly vulnerable package, the
target must be outside that advisory's vulnerable range. When changing a
dependent, it is the reached package's resulting version that resolves the
advisory; the dependent's version is not compared with another package's
vulnerable range.

For non-downgrade selection, eligible candidates are versions of the package
being changed at or above that transition's from-version that resolve the
driving advisory on the remediated paths and satisfy §3. The remediation
SHOULD adopt the lowest eligible candidate. If it adopts a higher eligible
candidate, its upgrade record MUST state why in the note of §6. This confines
the version increase to its driver; it does not promise a minimum number of
changed transitive entries.

That ranking and conditional note obligation apply only to the non-downgrade
candidate set. A downgrade under §7 still MUST resolve the driving advisory
and satisfy §3, but is not ranked against older releases. A removal adopting
no replacement version has no target to which the version requirements,
ranking or conditional note apply. Section 2.2's coverage and §3–§4 still
govern any entries the change set introduces.

### 2.2 Coverage

STARTINTENT
Every `package-lock.json` entry is covered by this policy — direct and
transitive dependencies alike, runtime and dev dependencies alike — and no
rule in this spec exempts an entry on either axis. The user chose full
coverage over a runtime-only or direct-only scope.
ENDINTENT

The application of this coverage at each layer is specified there: the
newly-introduced set in §3.4, advisory instances in §4.1, and the dependency
walk and its coverage property in §4.2.

## 3. The 14-day rule and its scope

### 3.1 Cooldown

STARTINTENT
A version published less than 14 days earlier MUST NOT be adopted. The user
directed this cooldown as a defense against supply-chain attacks.
ENDINTENT

Adoption means a lock entry resolving to that version newly appearing in the
post-change state: through an upgrade, a new dependency or a transitive entry
pulled in. The identity rule in §3.4 means moving an already-installed version
does not itself constitute an adoption. Section 3.2 specifies the measurement;
§5 specifies the waiver protocol.

### 3.2 Publish age and unavailable metadata

Publish age is check time minus publish time. Fourteen days means 14 × 24
hours, or 336 hours of elapsed time; both timestamps are interpreted in UTC.
A publish age of exactly 336 hours satisfies the cooldown.

The reference time MUST be the time of the check: gate-run time for the gate,
or selection time for a human or agent choosing a version. It MUST NOT be the
authoring time of an upgrade.

The authority for publish time is the npm registry packument's `time` entry
for the exact version adopted. A packument is the registry's package metadata
document. An entry whose publish time cannot be determined is not adoptable:
the check MUST stop rather than pass it. This includes an unreachable
registry, an absent packument and a missing `time` entry for that version.
The automation owns the report form and exit code.

The gate reaches this lookup only after concluding that the change set is
policed (§8). Selection-time checks also apply the cooldown procedurally
outside that branch.

### 3.3 Which change sets are policed

STARTINTENT
The gate polices security-driven change sets only, and MUST NOT block a
change set that is not security-driven. The user chose not to have the gate
block non-security changes.
ENDINTENT

This section scopes change sets; §3.4 scopes entries within a policed set.
Section 4 supplies the determination of a security-driven change set and
states the proxy's limitations. An inconclusive determination stops under
§4.3 instead of concluding that the change set is unpoliced. Section 8
reconciles those failure directions with the completed unpoliced case.
The cooldown remains policy for an unpoliced change set, applied procedurally.

### 3.4 Which entries are age-checked

STARTINTENT
Inside a policed change set, every newly-introduced `package-lock.json`
entry MUST be age-checked under §3.1, whether or not it carries an advisory
of its own. The user confirmed that the 14-day rule covers every
newly-introduced entry, including a new transitive entry with no advisory
of its own.
ENDINTENT

The newly-introduced set is the set difference of post-change installed
(package name, resolved version) pairs over pre-change installed pairs. The
root entry is excluded. Installed location is not part of this identity:
re-parenting a version already installed before the change does not introduce
it. By §2.2, neither flags such as `dev`, `optional` and `peer` nor the
entry's direct-versus-transitive position filter this set.

## 4. Identifying a policed change set

### 4.1 Advisory instances

An advisory instance is keyed by:

| Component | Meaning |
|-----------|---------|
| Vulnerable package | The name of the package an advisory affects |
| Resolved version | That installed package's exact version |
| Severity | The severity of the advisory covering that version on the chain |
| Path | The ordered chain of package names from a root dependency to that package |

The path contains no resolved versions. The vulnerable package's resolved
version is a separate component; severity is that of the covering advisory,
never a per-package or per-report aggregate. These definitions apply the
coverage of §2.2 to the instances used by the determination.

A bump of an intermediate node leaves an instance unchanged exactly when it
leaves the rest of the name chain and the vulnerable package's resolved
version unchanged. Re-parenting the vulnerable package or changing it to a
different still-vulnerable version changes the key.

### 4.2 Enumeration, chains and coverage

The determination MUST enumerate one instance per distinct root-to-package
name chain, per distinct severity among advisories covering that installed
version. Enumeration is not one instance per installed node: hoisting makes
multiple chains to a shared node common, and per-node enumeration hides a
partially remediated path while the vulnerable node retains its location.

Both dependency states MUST be walked over the same edge set:
`dependencies`, root `devDependencies`, `optionalDependencies` and
`peerDependencies`. This applies §2.2 to the walk. Narrowing the walk to
`dependencies` alone fails open: in this repository's v4.7.10 baseline, with
root `devDependencies` omitted, it reaches only 152 of 489 installed nodes.
The runtime entry `node_modules/pg-cloudflare` is reachable only over an
`optionalDependencies` edge. The four-field walk reaches all 489 nodes.

STARTINTENT
Every installed lock entry MUST be reachable by at least one dependency
chain over each dependency state the determination of §4.4 walks. This is
the coverage the user directed, held at the level of the chains instances
are keyed on.
ENDINTENT

A lockfile introducing nodes through another field, such as workspace `link`
entries or `bundleDependencies`, presents a gap to close in the edge set;
it does not silently narrow coverage. This repository's v4.7.10 baseline
contains neither. Until the walk supports such a state, §4.3 applies.

No installed node may repeat within a chain, while the recorded path remains
a chain of names. A bound on repeated names would discard real paths through
a second installed copy of a name and could miss a vulnerable package when
every chain to it repeats a name. The node bound instead excludes cycles
without excluding a node reachable by a simple path: a path to a node never
needs to repeat an installed node.

### 4.3 The two states and failure directions

The pre-change state MUST be the change set's own pre-change dependency state:
the state it is diffed and audited against, not a fixed or historical state.
It MUST be established independently of the change set's author, never from
an artifact the author can edit. The automation specifies the mechanism and
the evidence of that resolution; this spec specifies its required property.

STARTINTENT
A change set whose pre-change dependency state cannot be established is not
a change set with an empty pre-change state, and is not thereby unpoliced:
the determination MUST stop rather than treat it as out of scope. The user's
exemption covers change sets that removed no critical or high instance, not
change sets whose pre-change state was never resolved.
ENDINTENT

STARTINTENT
An installed lock entry that no chain reaches, and a dependency state that
does not present the structure the walk reads, are not absences of
instances: the determination MUST stop rather than proceed on either.
Treating either as instance-free would exempt entries on exactly the axes
the user refused to exempt.
ENDINTENT

The walk MUST verify its input before walking it. In particular, it MUST
reject a lockfile whose `lockfileVersion` it does not implement and MUST NOT
default an absent `packages` member to an empty object. The version is
declared in the lockfile and can differ between the two states; the supported
version must be implemented or the input rejected. This is the current
format-specific application of the failure direction above. The automation
owns the report form and exit code.

### 4.4 Scope test

The determination is evaluated once per change set, not once per entry:

1. Establish the states and validate the walk inputs under §4.3.
2. Enumerate their advisory instances under §4.1–§4.2, completing the
   coverage check for each state.
3. Form the derived driver set as the set difference of pre-change critical
   and high instances over post-change instances: every such instance that
   held before and no longer holds, and nothing else.
4. Form the effective driver set by adding any drivers declared by the
   upgrade record (§6).
5. Conclude that the change set is policed if the effective set is non-empty;
   otherwise conclude that it is unpoliced.

An upgrade record MAY declare a driver. A declaration can bring a change set
into scope and MUST NOT take one out: otherwise author-controlled scope
declarations would reproduce the waiver-authorship gap of §5.4. An audit of
the post-change state alone cannot make the determination, because it reports
advisories still present rather than instances the change set removed.

### 4.5 Proxy and bound

The scope test is a proxy for “security-driven”, not a definition of motive.
It errs in both directions. Under-inclusion is the unsafe error; the instance
key closes it for the remediation classes here: partial remediation drops
the fixed path's instance, and a still-vulnerable bump drops the pre-change
version's instance. A key containing only a package name would miss both.

Over-inclusion remains. Dropping or re-parenting a dependency for unrelated
reasons removes the instance carried by that chain. This includes dropping
an intermediate package while the vulnerable package remains installed at the
same version and is still reported on other chains. Such a change set is
policed on outcome. Per-chain enumeration widens this residual relative to
per-node enumeration: dropping an unused dev dependency on a critical or
high chain suffices. Motive is not mechanically observable, and narrowing
this comparison would reopen under-inclusion.

A change set that modifies a lock entry on a critical or high chain while
every instance survives unchanged has removed nothing and is not policed by
the derived set. An intermediate bump that preserves the rest of the name
chain and the vulnerable package's version is such a case. A bump that
re-parents the vulnerable package or moves it to another vulnerable version
is policed. A declared driver supplies the route into scope for a
security-motivated change whose instances all survive.

The over-inclusion residual is bounded: the derived test reaches only change
sets that verifiably removed a critical or high instance, and the cooldown
blocks only those that also introduce an under-age entry without a matching
waiver. Declared drivers independently widen scope as §4.4 states. Section
5.3's change-set-scoped waiver is the recorded release valve for the residual
when the change set contains no upgrade. The inconclusive-input stops of
§4.3 precede any scope verdict; unavailable publish time in a policed set is
handled separately by §3.2.

## 5. Waivers

### 5.1 Authorization

STARTINTENT
The cooldown of §3 MAY be waived only by explicit user authorization, given
per upgrade and recorded. An agent MUST NOT waive it and MUST NOT record a
waiver the user has not explicitly authorized. The user chose an explicit
user override as the only escape hatch.
ENDINTENT

### 5.2 Ledger and exact coverage

The ledger is a checked-in structured file. Each per-upgrade waiver MUST
record:

| Content | Required meaning |
|---------|------------------|
| Upgrade | Package name, from-version and target version |
| Admitted entries | Every (package name, exact version) pair admitted by this waiver: the upgraded package's new version and any under-age entries the upgrade pulls in |
| Drivers | The advisory or advisories driving the change set |
| Authorization | The authorizing user's statement |
| Authorization date | The date of that authorization |

A waiver covers exactly the pairs it lists, never a version range and never a
later version. Listing an upgrade does not implicitly admit all the entries
it pulls in; each admitted pair is enumerated. This makes the authorization's
coverage checkable without changing its per-upgrade scope.

The ledger is stored in `ci2/policy/dependency-policy.yaml`.

### 5.3 A policed change set with no upgrade

For a policed change set containing no upgrade, a waiver MAY be scoped to the
change set instead. This includes §4.5's residual and a change set policed
only by a declared driver. The form names no upgrade. It identifies the
change set by its effective driver set — removed instance keys and declared
advisory identities, whichever are present — and lists the exact (name,
version) pairs it admits. When only declared drivers are present, no removed
instance is required.

This form MUST NOT be used where a per-upgrade authorization is expressible:
wherever the change set contains an upgrade, the per-upgrade form applies.
Otherwise one authorization could cover several upgrades contrary to §5.1.
The form retains §5.1's authorization requirements and §5.2's recorded user
statement, date and exact entry coverage; it changes the scope named by the
record only because no upgrade exists for that scope to name.

### 5.4 Authorship and mechanical checks

The gate can verify that a waiver exists and matches an entry. A checked-in
statement does not mechanically establish who authorized it. Compliance with
§5.1's authorship requirements is therefore procedural, as §8 records.

## 6. The upgrade record

Every dependency upgrade MUST have an upgrade record. It is the evidence
against which §2.1's procedural rule is reviewed. A policed change set with no
upgrade MAY also have a record.

The record is checked-in structured content the gate can read. Its minimum
content is:

| Content | Meaning |
|---------|---------|
| Upgrades | Packages changed, with each from-version and target version; the list may be empty in the no-upgrade case |
| Remediated advisories | Advisory identifier, affected package and severity; these identify what each recorded upgrade remediates |
| Waiver references | References to the applicable ledger waivers, empty when none applies |
| Date | The record's date |
| Note | Optional except for the conditional obligation below |

The record's remediated advisories double as declared drivers under §4.4.
Declaring drivers is optional for a record carrying no upgrade; its advisory
list may be empty. Omitting a declaration never removes a derived driver.
This permits a no-upgrade policed change set to record an empty upgrades list,
any declared drivers, and a §5.3 waiver reference when applicable.

The record MAY carry a note in general. When a remediation adopts a higher
eligible non-downgrade candidate than the lowest candidate in §2.1's bounded
set, the note MUST state why. A downgrade or removal adopting no replacement
version does not trigger this obligation. The note requirement and record
completeness are procedural; they add no gate check (§8).

The upgrade record is stored alongside the ledger in
`ci2/policy/dependency-policy.yaml`.

The automation specifies the structured file's format; this section specifies
the content and its meaning.

## 7. No compliant remediation

When no compliant remediation is available and the fixing upgrade version is
inside its cooldown with no waiver authorized, the remediation waits until
the cooldown elapses. An agent MUST NOT adopt that version and MUST NOT waive
the cooldown. The agent MUST report the advisory, the fixed version and the
date the version becomes adoptable to the user, rather than wait silently.
The user may authorize a waiver under §5; that is the only cooldown exception.

An older non-vulnerable version pinned by `overrides`, or removal of the
dependency, is an ordinary remediation subject to §2–§4. A downgrade resolves
the driver and satisfies §3 without entering §2.1's non-downgrade ranking.
A removal adopting no replacement version has no target-version obligation,
while any other newly-introduced entries remain subject to §3–§4. If either
alternative is compliant, the no-compliant-remediation wait does not apply.

Interim exposure decisions, such as disabling the affected code path or
accepting the risk, belong to the user and are outside this spec. When no
fixed version exists at all, including a transitive advisory with no fix
path, the agent MUST report that advisory and the absence of a fixed version;
no upgrade is demanded.

## 8. Enforcement boundary

The mapping below is part of this spec. `gate` means mechanically checked;
`proc` means procedural, through human or agent selection and review of the
ledger and upgrade record; `built` concerns what is delivered rather than a
runtime check. `gate + proc` splits a rule across both. The mapping describes
the gate's assigned checks, implemented through [test-automation.md §6.4].
Procedural responsibilities remain applicable alongside the gate.

The numbered directions correspond to the user's policy decisions. Directions
5, 8 and 9 have their point of use in `test-automation.md`, which carries
their INTENT-marked requirements. The mapping and its reasoning here are
derived enforcement boundaries, not additional user directions.

| Rule / section | By | Gate check or delivery evidence | Procedural responsibility |
|----------------|----|---------------------------------|---------------------------|
| 0 — cooldown (§3.1–§3.2) | gate + proc | Age of newly-introduced entries in a concluded policed set | Cooldown at selection time, including adoptions outside policed sets |
| 1 — deliverable scope (§1.1) | built | Delivery of the assigned gate checks through authorized automation | — |
| 2 — trigger and target selection (§2.1) | proc | Motive and the target-selection justification are not inferred by the gate | Advisory-driven upgrade, resolution on the remediated paths, lowest eligible non-downgrade candidate or the required note |
| 3 — coverage (§2.2, §3.4, §4.2) | gate | Instance enumeration, reachability and the unfiltered newly-introduced set | Apply the same policy when selecting versions |
| 4 — cooldown waiver (§5.1) | gate + proc | Existence and exact match of a recorded waiver | Verify explicit user authorization and its recorded scope |
| 5 — CI system (`test-automation.md`) | built | Delivery of the visor2 `ci2/` automation structure | — |
| 6 — change-set scope (§3.3) | gate | Completed §4 determination; an empty effective driver set is exempt | Review the acknowledged proxy limitation of §4.5 |
| 7 — entry scope (§3.4) | gate | Every newly-introduced pair in a concluded policed set | — |
| 8 — suite coverage (`test-automation.md`) | built | Delivery of lint, unit, integration and dependency-policy coverage | — |
| 9 — authorized automation (`test-automation.md`) | proc | — | Use that spec's project-authorized automation as validation evidence |
| Derived scope test (§4.1–§4.5) | gate | Instance difference plus widening-only declarations, once per change set | Interpret outcome independently of motive |
| Walk coverage (§4.2) | gate | All chains over the stated edges and reachability of each installed node | — |
| Pre-change input failure (§4.3) | gate | Unresolved input stops an inconclusive determination before any exemption | No substitute historical or author-editable baseline |
| Walk/input-structure failure (§4.3) | gate | Unreachable entries or unsupported structure stop an inconclusive determination before any exemption | — |
| Publish-time failure (§3.2) | gate + proc | An unavailable time stops the check only after a concluded policed result | An entry with unavailable publish time is not selected |
| Waiver matching (§5.2–§5.3) | gate + proc | Match recorded scope and exact admitted pairs | Verify the authorization against the user's statement |
| Upgrade record and conditional note (§6) | proc | Declarations and waiver references are read; record completeness and the note are not gate checks | Record each upgrade and its advisory evidence; justify a higher eligible candidate |
| No compliant remediation (§7) | proc | — | Report the advisory and fix/cooldown status; leave interim exposure decisions to the user |

Three limitations prevent blanket automation. The trigger rule is procedural
because §3.3 exempts non-security change sets and motive is not observable.
Waiver authorship is procedural because a checked-in entry supplies content,
not proof of its author. The cooldown is policy for every adoption, while the
gate reaches it only within policed change sets.

The exemption in §3.3 follows a completed §4 determination with an empty
effective driver set. An unresolved pre-change state, an unreachable
installed entry or unsupported input structure instead leaves that
determination inconclusive. Its required stop is not a verdict that the
change set is security-driven, and absence of a declared driver cannot turn
it into an exemption. Thus both §4.3 failure directions retain their force
without weakening §3.3's completed unpoliced case.

Publish-time lookup is separate: the gate looks up publish times only inside
a concluded policed change set. An unavailable time therefore cannot block a
concluded unpoliced one. These distinctions govern §10's ordering.

## 9. Boundary with the packaging contract

[overview.md §4] pins the set of 18 runtime dependencies and the packaging
fields, and deliberately does not pin declared version ranges. This spec
governs when a dependency's resolved version may change and to which version;
it adds, removes and renames nothing in that section's set and pins no range.

A compliant remediation changes the resolved version in `package-lock.json`
and, where the declared range requires it, the range in `package.json`.
Neither changes what that section pins. A change set that alters its
dependency set is a change to `overview.md`, reviewed as such, and is
additionally policed by this spec when §4.4 reaches it. Removing a dependency
that carried a critical or high instance is one such case.

## 10. The gate

The project's authorized test automation, specified by
[test-automation.md §6.4], MUST run the dependency-policy check on every change
set in this order:

1. Establish the pre-change state under §4.3 and verify the inputs.
2. Apply §4.4, including enumeration and coverage on both states.
3. For a concluded policed change set, derive the newly-introduced entries
   under §3.4 and apply §3.1–§3.2 to each, consulting §5's ledger.

The gate MUST block on any violation of its assigned checks in §8. It MUST
fail closed in the three directions of §3.2 and §4.3: the input and walk
stops precede any scope conclusion, while publish-time lookup is confined to
the concluded policed branch. A concluded unpoliced change set passes without
that lookup, as §8 states.

The gate MUST report the instances and declared drivers that put a change
set in scope, so a blocked author can see whether §5's waiver route applies,
and each violating entry. The automation owns the report form and exit code.

## 11. Tests checklist

### 11.1 Trigger and target version

* An upgrade's record identifies the critical or high advisory it remediates;
  a moderate or low advisory alone triggers no upgrade (§2.1, §6).
* The target resolves the driving advisory on the remediated paths and
  satisfies §3. For a transitive advisory, the reached package's resulting
  version resolves it; the dependent's version is not compared with the
  vulnerable range of the reached package (§2.1).
* Non-downgrade candidates are bounded below by the changed package's
  from-version. The lowest eligible candidate is adopted, or the record's
  note states why a higher eligible candidate was selected (§2.1, §6).
* With from-version 1.2.0, advisory range `>=1.0.0 <1.5.0`, and §3-compliant
  releases 0.9.0, 1.5.0 and 1.6.0, selecting 1.5.0 needs no deviation note;
  selecting 1.6.0 requires one. Version 0.9.0 is a downgrade alternative,
  not the preferred upgrade (§2.1, §7).

### 11.2 Coverage

* In a policed change set, a newly-introduced under-age entry reached through
  a root `devDependencies`, `optionalDependencies` or `peerDependencies`
  edge is a violation just as a runtime entry is. The root and transitive
  cases respect the field scope of §4.2 (§2.2, §3.4).
* A change set whose only removed critical or high instance lies on a chain
  through a root `devDependencies` edge is policed (§4.2–§4.4).
* Each additional edge field has a separate enumeration scenario: an
  instance whose only chain crosses a root `devDependencies` edge; one whose
  only chain crosses an `optionalDependencies` edge; and one whose only
  chain crosses a `peerDependencies` edge. Its removal polices the set,
  including when a narrower walk would still reach all installed nodes by
  other paths (§4.2).
* The four-field walk positively reaches every installed entry in both
  dependency states (§4.2). A chain through a second installed copy of a
  package name is retained; no installed node repeats within a chain.
* Multiple chains to one installed vulnerable version produce separate
  instances, and distinct covering advisory severities produce separate
  instances on each chain (§4.1–§4.2).

### 11.3 Scope determination

* Full remediation removes a critical or high instance and is policed.
  Partial remediation of one path to a hoisted shared node is policed even
  when the node retains its installed location (§4.4).
* A still-vulnerable bump changes the version component, removes the old
  instance and is policed. An intermediate bump leaving the instance set
  unchanged is unpoliced unless a driver is declared (§4.1, §4.5).
* An unrelated drop or re-parenting of an intermediate on a critical or high
  chain is policed even if the vulnerable package remains at the same
  version on another chain: this is the stated residual (§4.5).
* A declared driver widens scope when no instance was removed; a declaration
  or its omission cannot remove a derived driver (§4.4).

### 11.4 Failure directions

* An unresolvable pre-change state stops the determination rather than
  substituting an empty or unrelated historical state (§4.3).
* An unreachable installed entry, an unimplemented `lockfileVersion`, or an
  absent `packages` member stops the determination even when no driver is
  declared. No completed unpoliced result was possible (§4.3, §8).
* A completed determination with an empty effective driver set passes
  without a publish-time lookup. An unavailable publish time inside a
  policed set is not adoptable (§3.2, §8).

### 11.5 Publish age and entries

* An age below 336 elapsed hours is inside the cooldown; exactly 336 hours
  satisfies it. Authoring time does not replace selection or gate-run time
  as the reference (§3.2).
* An under-age transitive entry with no advisory in a policed change set is
  a violation absent a matching waiver. The same entry in a concluded
  non-security change set is not blocked by the gate; procedural policy
  still applies (§3.3–§3.4, §8).
* Re-parenting a package version already installed before the change does
  not make it newly introduced (§3.4).
* A waiver admits exactly the listed package-name and version pairs, not an
  unlisted pulled-in entry or a later version (§5.2).

### 11.6 Records and authorization

* Every upgrade has a record identifying its from-version, target version
  and remediated advisory, with the date and applicable waiver references
  (§6).
* A waiver records the upgrade, admitted exact pairs, drivers, authorizing
  user's statement and authorization date. Review checks §5.1's
  authorization separately from mechanical entry matching (§5.2, §5.4).
* A policed change set with no upgrade can carry a §5.3 waiver and a §6
  record. This remains satisfiable when its effective driver set contains
  only declared advisories and no removed instance: the waiver identifies
  those declarations and the exact entries admitted.
* Wherever an upgrade exists, the per-upgrade waiver form is required;
  the no-upgrade form does not authorize several upgrades (§5.3).

### 11.7 No compliant remediation

* If the only fixing version is inside its cooldown and no waiver is
  authorized, the version is not adopted, no agent records an unauthorized
  waiver, and the advisory, fixed version and adoptable-from date are
  reported to the user (§7).
* If no fixed version exists, the advisory and absence of a fix are reported
  and no upgrade is demanded (§7).
* An `overrides` pin to an older non-vulnerable version or dependency removal
  is an ordinary remediation under §2–§4, without the non-downgrade ranking
  or conditional note. Removal adopting no replacement version has no
  target-version obligation; any other newly-introduced entries remain
  covered. A compliant alternative avoids the wait (§7).

### 11.8 Packaging boundary

* A dependency version upgrade changes no row pinned by [overview.md §4].
  Removing a dependency is a change to that section's set that may also be
  policed by this spec (§9).

### 11.9 Gate reporting

* A blocked change set's report identifies each instance and declared driver
  that put it in scope, so its author can see whether §5's waiver route
  applies, and each violating entry (§10).
