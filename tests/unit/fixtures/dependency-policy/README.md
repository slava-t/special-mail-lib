# Dependency policy fixture inputs

These are immutable npm 11.6.2 audit captures, acquired on 2026-09-05 using
host Node v24.12.0. Acquisition was input research, not checker validation.
The unit suite runs the checker under the VM Node 20.19.5/npm 11.6.2 toolchain.

The seven original endpoints in `identities.json` are the exact accepted
phase-05 planning inputs. `capture-index.json` adds all later graph captures.
Each directory contains its manifest/lock pair, raw audit stdout and stderr,
and `capture.json` with the exact command, working directory, capture time
and digest. Fake scoped packages provide graph structure only. Do not install
these trees or edit their reports to fit an assertion.

- `shared-before`, `fixed-all`: advisory-free transitive adoption and complete remediation.
- `fixed-partial`, `vulnerable-partial`: one path to the unchanged hoisted node is fixed or bumped.
- `intermediate-bump`: an intermediate version changes while endpoint instances survive.
- `severity-before/after`: request/form-data aggregate severity and effects do not encode per-chain vulnerability.
- `collection-before/after`: a real minimist dev dependency and full offline npm collection.
- `edges-before/after`: optional/peer routes, two installed A copies, and cycles.
- `dev-chain-before/after`: removing a dev-root chain leaves every node reachable.
- `moved-before/after`: the fixed version already existed elsewhere; only fresh is newly introduced, but a common chain upgrades.
- `removal-after`: incidental chain removal with an advisory-free new package.
- `declared-before/after`: a declaration-only change set with no upgrade.

The `registry` directory stores the exact full minimist packument and bulk
response used by offline collection tests, plus source/request/time/digest
provenance. Tests run the actual pinned npm CLI through the loopback adapter
inside the authorized unit leaf. Clock and publish responses used for policy
decisions are explicit synthetic test inputs. Test authorization statements
are fixtures, not user waivers; the project ledger remains empty.

Additional cycle captures expose npm's same-name propagated objects: their
source is a hash, their URL is null, and their range is `*`. Raw objects remain
unchanged; source IDs and URLs are explanatory, outside instance identity.
The complete object inventory below includes these as well as registry IDs.

## Complete captured object inventory

| Endpoint | Package | Source | Severity | Range | URL |
|---|---|---|---|---|---|
| collection-after | — | none | — | — | — |
| collection-before | minimist | 1096465 | moderate | `>=1.0.0 <1.2.3` | https://github.com/advisories/GHSA-vh95-rmgr-6w4m |
| collection-before | minimist | 1097678 | critical | `>=1.0.0 <1.2.6` | https://github.com/advisories/GHSA-xvch-5gv4-984h |
| declared-after | — | none | — | — | — |
| declared-before | — | none | — | — | — |
| dev-chain-after | minimist | 1096465 | moderate | `>=1.0.0 <1.2.3` | https://github.com/advisories/GHSA-vh95-rmgr-6w4m |
| dev-chain-after | minimist | 1097678 | critical | `>=1.0.0 <1.2.6` | https://github.com/advisories/GHSA-xvch-5gv4-984h |
| dev-chain-before | minimist | 1096465 | moderate | `>=1.0.0 <1.2.3` | https://github.com/advisories/GHSA-vh95-rmgr-6w4m |
| dev-chain-before | minimist | 1097678 | critical | `>=1.0.0 <1.2.6` | https://github.com/advisories/GHSA-xvch-5gv4-984h |
| edges-after | @dep-policy-fixture/a | lCpP9Sz+JWbizo/3FfbUgKG6Bwnogb8KFOun3OBNIB0q3yb1EC2pPyP1kjkG9MA7zz8QFgv+MYP5sM3Slrr06w== | critical | `*` | None |
| edges-after | minimist | 1096465 | moderate | `>=1.0.0 <1.2.3` | https://github.com/advisories/GHSA-vh95-rmgr-6w4m |
| edges-after | minimist | 1097678 | critical | `>=1.0.0 <1.2.6` | https://github.com/advisories/GHSA-xvch-5gv4-984h |
| edges-before | @dep-policy-fixture/a | 0mwFGZgxbtniN5vlM7+wExUowk9JL73FUfpfJbX2j9LcorsFKgkOdsRxQOPqU8LR1lsfWkOq8yMRRN1+sQCJpQ== | critical | `*` | None |
| edges-before | minimist | 1096465 | moderate | `>=1.0.0 <1.2.3` | https://github.com/advisories/GHSA-vh95-rmgr-6w4m |
| edges-before | minimist | 1097678 | critical | `>=1.0.0 <1.2.6` | https://github.com/advisories/GHSA-xvch-5gv4-984h |
| fixed-all | — | none | — | — | — |
| fixed-partial | minimist | 1096465 | moderate | `>=1.0.0 <1.2.3` | https://github.com/advisories/GHSA-vh95-rmgr-6w4m |
| fixed-partial | minimist | 1097678 | critical | `>=1.0.0 <1.2.6` | https://github.com/advisories/GHSA-xvch-5gv4-984h |
| intermediate-bump | minimist | 1096465 | moderate | `>=1.0.0 <1.2.3` | https://github.com/advisories/GHSA-vh95-rmgr-6w4m |
| intermediate-bump | minimist | 1097678 | critical | `>=1.0.0 <1.2.6` | https://github.com/advisories/GHSA-xvch-5gv4-984h |
| moved-after | — | none | — | — | — |
| moved-before | minimist | 1096465 | moderate | `>=1.0.0 <1.2.3` | https://github.com/advisories/GHSA-vh95-rmgr-6w4m |
| moved-before | minimist | 1097678 | critical | `>=1.0.0 <1.2.6` | https://github.com/advisories/GHSA-xvch-5gv4-984h |
| removal-after | minimist | 1096465 | moderate | `>=1.0.0 <1.2.3` | https://github.com/advisories/GHSA-vh95-rmgr-6w4m |
| removal-after | minimist | 1097678 | critical | `>=1.0.0 <1.2.6` | https://github.com/advisories/GHSA-xvch-5gv4-984h |
| severity-after | form-data | 1109540 | critical | `<2.5.4` | https://github.com/advisories/GHSA-fjxv-7rqg-78g4 |
| severity-after | form-data | 1120745 | high | `<2.5.6` | https://github.com/advisories/GHSA-hmw2-7cc7-3qxx |
| severity-after | request | 1096727 | moderate | `<=2.88.2` | https://github.com/advisories/GHSA-p8p7-x288-28g6 |
| severity-before | form-data | 1109540 | critical | `<2.5.4` | https://github.com/advisories/GHSA-fjxv-7rqg-78g4 |
| severity-before | form-data | 1120745 | high | `<2.5.6` | https://github.com/advisories/GHSA-hmw2-7cc7-3qxx |
| severity-before | request | 1096727 | moderate | `<=2.88.2` | https://github.com/advisories/GHSA-p8p7-x288-28g6 |
| shared-before | minimist | 1096465 | moderate | `>=1.0.0 <1.2.3` | https://github.com/advisories/GHSA-vh95-rmgr-6w4m |
| shared-before | minimist | 1097678 | critical | `>=1.0.0 <1.2.6` | https://github.com/advisories/GHSA-xvch-5gv4-984h |
| vulnerable-partial | minimist | 1096465 | moderate | `>=1.0.0 <1.2.3` | https://github.com/advisories/GHSA-vh95-rmgr-6w4m |
| vulnerable-partial | minimist | 1097678 | critical | `>=1.0.0 <1.2.6` | https://github.com/advisories/GHSA-xvch-5gv4-984h |

## Re-acquisition

Copy an endpoint's pair to a disposable empty directory. Use npm 11.6.2 with
distinct empty user/global npmrc files and a fresh cache, and capture stdout
and stderr verbatim:

```text
npm audit --package-lock-only --include=dev --include=optional --include=peer
  --json --registry=https://registry.npmjs.org --userconfig=<empty-user-config>
  --globalconfig=<different-empty-global-config> --fetch-retries=0
  --cache=<fresh-cache>
```

Recheck the entire advisory inventory and the intended graph discriminators.
Capture changes are input research; they do not establish a policy pass.
Intentional malformed-report variants in the tests identify their corruption.
Checker validation and failure/correction evidence use only
`SML_BASELINE_TARGET_REF=refs/remotes/origin/master ci2/scripts/all-tests.sh`.
