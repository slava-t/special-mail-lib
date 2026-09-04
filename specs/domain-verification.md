# Domain Verification Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the exported `DomainNameVerifier` class and the DKIM helper exports
`getDkimDir` and `getDkim`. The class verifies a domain against one configured
environment by combining SPF, DKIM and MX checks. The two helper functions are
exported from `index.js` through the spread of `lib/util.js`; the verifier class
is exported from `index.js` as a named property.

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here: this file uses
**Environment**, **DKIM id**, **In-exchange** and **Out-exchange** as that
glossary defines them.

* **Domain verifier**: an instance of `DomainNameVerifier`, holding one
  environment map, one DNS timeout and one `MxVerifier` per configured
  environment.
* **Environment entry**: a value in the verifier's `options.environments` map.
  Its `mailServers`, `spfInclude` and `dkimSelector` fields are read here; the
  configuration file shape is specified by [config-and-resolvers.md §12].
* **DKIM directory**: the directory under `<configDir>/dkim/` from which a DKIM
  key text value is read. It is named either `default` or a two-character
  domain hash key.
* **DKIM key object**: the object `getDkim` returns, carrying `id`, `selector`,
  `domain` and `value`.
* **DKIM DNS name**: the TXT-record name `getDkim` derives for a domain, of the
  form `<selector>._domainkey.<domain>`.
* **Verification subresult**: an object with `errors` and `steps` arrays, as
  SPF and DKIM checks return, or an MX report returned by `MxVerifier.verify`
  and sometimes altered by this verifier.
* **Mail-server IP record**: an object `{ip, server}` produced by
  `_getAllMailServersIps`, pairing one resolved A record value with the mail
  server name whose lookup produced it.
* **SPF include**: the environment entry's `spfInclude` value, inserted into
  `include:<value>` when a corrective SPF step is built.
* **Fast verification**: the public boolean method `fastVerify`, which combines
  SPF, DKIM and the boolean fast MX check.

## 1. Goals and non-goals

### 1.1 Goals

* Specify the two DKIM helper exports, including directory layout, selector
  defaulting, file reads, returned fields and unguarded inputs.
* Specify `DomainNameVerifier` construction, including environment defaulting,
  DNS timeout defaulting and construction of one `MxVerifier` per environment.
* Specify the public verification methods: `verifyAnyMx`, `fastVerify` and
  `verify`.
* Specify SPF, DKIM and MX sub-check orchestration, including the branch
  conditions that create errors and corrective steps.
* Specify the public result shapes and the failures that are caught, swallowed
  into result objects, or allowed to reject.

### 1.2 Non-goals

Scoped by this spec's own subject, never by an incidental property of the
current source:

* DNS helper internals. This file names calls to `dnsResolve`; [utilities.md §7]
  owns the resolver instance, timeout latch and returned promise behavior.
* Promise-settling internals. `_getAllMailServersIps` calls `allPromises`;
  [utilities.md §8] owns that helper's settled-result shape and never-rejects
  transformation.
* Domain hash internals. `getDkimDir` calls `getDomainHashKey`; [utilities.md
  §5] owns the hash input normalization and digest pipeline.
* MX verifier internals. This file owns when `DomainNameVerifier` constructs and
  calls `MxVerifier`; [mx-verification.md §2], [mx-verification.md §4],
  [mx-verification.md §5], [mx-verification.md §6] and
  [mx-verification.md §7] own the configured-server normalization, boolean
  checks and corrective report produced by that class.
* Error message-template ownership. This file names the SPF, DKIM and DNS error
  codes and when the verifier creates them; [errors.md §3] owns the catalog
  templates formatted by `createError`.
* Configuration loading and environment lookup. The `environments` object is an
  input to this verifier. [config-and-resolvers.md §7] owns parsing a routing
  config into that shape, and [config-and-resolvers.md §12] owns the YAML field
  inventory.
* The internals of `spf-check`. This file specifies construction of
  `spfCheck.SPF`, the checked IPs and how the returned `result` and `message`
  are read. The validator's DNS behavior and result taxonomy are third-party
  contracts.

## 2. DKIM helper exports

`getDkimDir` is exported from `index.js` through the spread of `lib/util.js`. It
MUST have the signature `getDkimDir(configDir, domain, defaultDkim = false)`.

`getDkimDir` MUST choose its folder name by testing `defaultDkim` with
JavaScript truthiness:

| `defaultDkim` branch | Folder name |
|----------------------|-------------|
| truthy | `default` |
| falsy | `getDomainHashKey(domain, 2)` |

It MUST return `path.join(configDir, 'dkim', folderName)`. The hash calculation
in the falsy branch is exactly the domain hash key specified by [utilities.md
§5] with `len` fixed to `2`; this file owns only that the helper calls it for
the directory name.

The helper does not guard any input. In the falsy branch, a `domain` value that
`getDomainHashKey` cannot lowercase raises from that helper. In both branches,
path joining is Node's `path.join` behavior; this spec states the segments and
their order.

`getDkim` is exported from `index.js` through the spread of `lib/util.js`. It
MUST have the signature `getDkim(dir, domain, config, defaultDkim = false)` and
MUST be asynchronous.

`getDkim` MUST perform these steps in order:

1. Compute `dkimDir` as `getDkimDir(dir, domain, defaultDkim)`.
2. Compute `textPath` as `path.join(dkimDir, 'txt')`.
3. Compute `id` as `path.basename(dkimDir)`.
4. Compute `selector` as `config.dkimSelector || 'main'`.
5. Compute the DKIM DNS name as `` `${selector}._domainkey.${domain}` ``.
6. Await an `utf8` read of `textPath`.
7. Return `{id, selector, domain: dkimDomain, value: value.trim()}`.

The returned object's property order is `id`, `selector`, `domain`, `value`.
The `domain` property of the returned object is the DKIM DNS name, not the
input domain argument. The `value` property is trimmed once by `getDkim`; callers
may trim it again, as `_verifyDkim` does in §5.

`getDkim` does not catch. A missing `config`, a missing `dkimSelector` container,
an invalid path segment or a failed file read rejects or throws through the
async function. `_verifyDkim` catches those failures when it calls `getDkim`
(§5), but a direct caller of `getDkim` receives the rejection.

## 3. DomainNameVerifier construction

`DomainNameVerifier` MUST be exported from `index.js` as a named property and
MUST be the class defined by `lib/DomainNameVerifier.js`.

The constructor signature is `constructor(configDir, options = {})`. It MUST
perform these assignments in order:

1. Store `configDir` as `_configDir`.
2. Store `options.environments || {}` as `_environments`.
3. Store `options.dnsTimeout || 5000` as `_dnsTimeout`.
4. Store `{}` as `_mxVerifiers`.
5. Iterate `Object.keys(_environments)` and, for each environment name, store
   `new MxVerifier(_environments[environment].mailServers || [])` under the same
   key of `_mxVerifiers`.

The `options = {}` default means constructing with no second argument is valid:
`_environments` becomes `{}`, `_dnsTimeout` becomes `5000`, and no `MxVerifier`
is constructed. The default does not apply to `null`; a `null` options argument
raises on the first property read.

The `dnsTimeout` default applies on any falsy value. A caller-supplied timeout
of `0`, `null`, `''` or `false` is replaced with `5000`.

The environment map default applies on any falsy `options.environments` value.
When an environment key is present, its entry is read without guarding the entry
value. A present key whose value is `null` raises during construction at the
`.mailServers` read. An entry object with no `mailServers` field is safe for
construction and supplies `[]` to `MxVerifier`. This is the class-level reader
for the present-but-null environment-entry axis left to this spec by
[config-and-resolvers.md §12].

`MxVerifier` construction and mail-server normalization are owned by
[mx-verification.md §2]. This constructor owns only the input list it passes to
that class and the per-environment map that stores each verifier.

## 4. MX verification

`verifyAnyMx(environment, domain)` MUST be asynchronous. It MUST first read
`this._mxVerifiers[environment]` into a local `verifier`, then attempt
`dnsResolve(domain, 'MX', this._dnsTimeout)`.

When the MX DNS lookup rejects, `verifyAnyMx` MUST return exactly:

| Property | Value |
|----------|-------|
| `errors` | `[createError('DnsGettingMxRecordsFailed', domain)]` |

The DNS error object and message are discarded. No `result` or `steps` property
is set in this branch, and the selected verifier is not called.

When the MX DNS lookup fulfils, `verifyAnyMx` MUST return exactly:

| Property | Value |
|----------|-------|
| `result` | `verifier.verifyAnyMx(records)` |
| `errors` | `[]` |

The `records` value is the DNS result as returned by [utilities.md §7].
`verifyAnyMx` delegates the membership predicate to [mx-verification.md §4] and
does not inspect priorities, build target records or create MX corrective
steps.

A missing environment has branch-dependent behavior. If DNS lookup fails, the
method returns the DNS error object above before using `verifier`. If DNS lookup
succeeds, the later `verifier.verifyAnyMx(records)` call raises because
`verifier` is `undefined`.

`_verifyMx(environment, domain, fast = false)` MUST be asynchronous. It MUST
read `this._mxVerifiers[environment]` into `verifier`, then attempt
`dnsResolve(domain, 'MX', this._dnsTimeout)`.

When the MX DNS lookup rejects and `fast` is truthy, `_verifyMx` MUST return the
boolean `false` and MUST NOT call the selected verifier. A missing verifier is
therefore not observed in this branch.

When the MX DNS lookup rejects and `fast` is falsy, `_verifyMx` MUST call
`verifier.verify([])`, spread that report into a new object, and replace its
`errors` array with `[createError('DnsGettingMxRecordsFailed', domain)]`. The
returned object therefore keeps the empty-record report's `records`,
`targetRecords` and `steps` from [mx-verification.md §7], while its errors are
only the DNS lookup failure. If the selected verifier is missing, this branch
raises at `verifier.verify([])` rather than returning the DNS error object.

When the MX DNS lookup fulfils, `_verifyMx` MUST return
`verifier.fastVerify(records)` when `fast` is truthy, and
`verifier.verify(records)` otherwise. The two delegated methods are specified in
[mx-verification.md §5] and [mx-verification.md §7].

## 5. DKIM verification

`_verifyDkim(environment, domain)` MUST be asynchronous and MUST return a
verification subresult.

It MUST first call `getDkim(this._configDir, domain,
this._environments[environment])` inside a `try` block. Any rejection or throw
from that call, including a missing environment entry, a missing `config`
argument or a failed `txt` file read, MUST be caught and converted to:

| Property | Value |
|----------|-------|
| `errors` | `[createError('DkimGettingValueFailed', domain)]` |
| `steps` | `[{step: 'DkimAskSupport', message: 'Ask support for help'}]` |

The caught error is discarded.

After `getDkim` succeeds, `_verifyDkim` MUST set `value` to
`dkim.value.trim()`. This is a second trim on the value `getDkim` already
trimmed in §2, and it MUST be preserved as written.

The method MUST then attempt `dnsResolve(dkim.domain, 'TXT',
this._dnsTimeout)`. When that lookup rejects, it MUST return:

| Property | Value |
|----------|-------|
| `errors` | `[createError('DkimDnsResolveError', dkim.domain, err.message)]` |
| `steps` | `[{step: 'DkimSetKey', message: "Set the TXT value for <dkim.domain> to '<value>'"}]` |

The step message is built with the actual `dkim.domain` and trimmed `value`.

When the TXT lookup fulfils with a value that is not an array, or with an empty
array, `_verifyDkim` MUST return:

| Property | Value |
|----------|-------|
| `errors` | `[createError('DkimDnsResolveError', dkim.domain, 'DNS record not found')]` |
| `steps` | the same `DkimSetKey` step message as the DNS-rejection branch |

When the TXT lookup fulfils with more than one top-level record,
`_verifyDkim` MUST return:

| Property | Value |
|----------|-------|
| `errors` | `[createError('DkimMultipleRecords', dkim.domain)]` |
| `steps` | `[{step: 'DkimSetOne', message: "Set one TXT record to '<value>' and remove all other TXT records for the <dkim.domain>"}]` |

With exactly one top-level TXT record, `_verifyDkim` MUST join that first
record's elements with `''` and compare the result with `value`. The first TXT
record is not otherwise guarded; a record without `.join` raises.

When the joined record value does not equal `value`, `_verifyDkim` MUST return:

| Property | Value |
|----------|-------|
| `errors` | `[createError('DkimKeyMismatch', dkim.domain, dkim.id)]` |
| `steps` | the same `DkimSetKey` step message as the DNS-rejection branch |

Only when the joined record value equals `value` MUST `_verifyDkim` return
`{errors: [], steps: []}`.

The DKIM error codes named here are catalog entries of [errors.md §3]. This file
owns when they are created; the formatted messages belong to that catalog.

## 6. SPF verification

`_getAllMailServersIps(mailServers)` MUST be asynchronous. It MUST initialize
empty `errors`, `ips` and `steps` arrays, then build one DNS A-record lookup per
configured mail server in `mailServers` order:

```
dnsResolve(server, 'A', this._dnsTimeout)
```

The lookup promises MUST be passed through `allPromises`, specified by
[utilities.md §8], and then awaited with `Promise.all`.

For each settled result in order, `_getAllMailServersIps` MUST use the same
index into the original `mailServers` array:

* For a fulfilled result, it MUST append one mail-server IP record per returned
  IP value, preserving the result value order, with `server` set to
  `mailServers[index]`.
* For a rejected result, it MUST append
  `createError('DnsGettingARecordsFailed', mailServers[index])` to `errors`.

When at least one A-record lookup failed, the method MUST append exactly one
corrective step:

| Field | Value |
|-------|-------|
| `step` | `MxAskSupport` |
| `message` | `Ask support for help` |

It MUST return `{errors, steps, ips}`. Successful IP records are still present
in `ips` even when some other server failed, although `_verifySpf` discards them
in that case (§6).

`_getAllMailServersIps` does not guard `mailServers`. A missing or non-array
value raises at the `.map` call rather than returning empty results.

`_createSetSpfStep(spfInclude, mailServers, domain)` MUST be asynchronous. It
MUST attempt `dnsResolve(domain, 'TXT', this._dnsTimeout)`. A DNS failure MUST
set a local failure flag and MUST NOT itself create an error object.

If the TXT lookup succeeds, `_createSetSpfStep` MUST iterate the returned records
in order. For each record it MUST join the record with `''`, trim it, and select
the first value that starts with the exact prefix `v=spf1 `. Later SPF records,
if any, are ignored after the first match.

When the DNS lookup failed or no SPF record was selected, the method MUST return:

| Field | Value |
|-------|-------|
| `step` | `SpfSetDnsRecord` |
| `message` | `Set a DNS TXT record for the <domain> domain to include <spfInclude>. An example for a valid SPF value would be 'v=spf1 include:<spfInclude> ~all'.` |

When an SPF record was selected, the method MUST strip the `v=spf1 ` prefix into
`spfRemaining`, build `suggestedValue` as
`v=spf1 include:<spfInclude> <spfRemaining>`, and return:

| Field | Value |
|-------|-------|
| `step` | `SpfChangeDnsRecord` |
| `message` | `Change the DNS TXT record for the <domain> domain to inclute <mailServers[0]>. Current SPF value: '<spfRecord>'. Suggested SPF value: '<suggestedValue>'` |

The spelling `inclute` and the interpolation of `mailServers[0]` rather than
`spfInclude` are part of the implemented message and MUST be preserved.

`_verifySpf(environment, domain)` MUST be asynchronous and MUST return a
verification subresult.

It MUST first destructure `{mailServers, spfInclude}` from
`this._environments[environment]`. The environment-entry read is unguarded. A
missing environment, or a present environment key whose value is `null`, rejects
through that destructuring. An entry object with no `mailServers` field reaches
`_getAllMailServersIps(undefined)`, which rejects at its `.map` call. This is
the method-level reader for the present-but-null and missing-field environment
entry axes; [config-and-resolvers.md §7] only guarantees parsed entries are
objects, not that `mailServers` is present.

After destructuring, `_verifySpf` MUST await `_getAllMailServersIps(mailServers)`.
When that subresult has any errors, `_verifySpf` MUST return exactly
`{errors: ipResults.errors, steps: ipResults.steps}`. It MUST NOT construct an
SPF validator in this branch, and the helper's `ips` array does not reach the
caller.

When all A-record lookups succeeded, `_verifySpf` MUST construct
`new spfCheck.SPF(domain)`, then check each mail-server IP record in `ips` order
by awaiting `validator.check(ipResult.ip)` sequentially.

For each SPF result whose `result` property is not exactly `'Pass'`, the method
MUST append:

```
createError(
  'SpfFailed',
  domain,
  ipResult.server,
  ipResult.ip,
  spf.result,
  spf.message
)
```

When one or more SPF errors were appended, `_verifySpf` MUST await
`_createSetSpfStep(spfInclude, mailServers, domain)` and append the single step
it returns. If that step construction rejects, `_verifySpf` rejects.

The method MUST return `{errors, steps}`. With an empty `mailServers` list, no A
records and no SPF checks are performed, and the method returns
`{errors: [], steps: []}`.

The SPF and A-record error codes named here are catalog entries of
[errors.md §3]. This file owns when they are created; the formatted messages
belong to that catalog.

## 7. Public verification methods

`fastVerify(environment, domain)` MUST be asynchronous and MUST return a boolean
when all three sub-checks settle.

It MUST run the three sub-checks sequentially in this order:

1. Await `_verifySpf(environment, domain)`.
2. Await `_verifyDkim(environment, domain)`.
3. Await `_verifyMx(environment, domain, true)`.

It MUST run all three awaits before computing the final boolean; SPF or DKIM
errors do not prevent the later checks from being attempted. If any awaited
sub-check rejects, `fastVerify` rejects and no public catch converts the failure
to a result object.

After all three sub-checks settle, `fastVerify` MUST return the exact boolean
expression:

```
mxResult &&
dkimResult.errors.length === 0 &&
spfResult.errors.length === 0
```

The MX operand is the boolean returned by `_verifyMx`'s fast branch; the SPF and
DKIM operands are based only on the length of each subresult's `errors` array.

`verify(environment, domain)` MUST be asynchronous. It MUST start
`_verifySpf(environment, domain)`, `_verifyDkim(environment, domain)` and
`_verifyMx(environment, domain, false)` together by passing them to
`Promise.all` in that order, and destructure the fulfilled results as
`spfResult`, `dkimResult` and `mxResult`.

The method has no public catch. If any sub-check rejects, `verify` rejects. When
all three fulfil, it MUST return exactly:

| Property | Value |
|----------|-------|
| `success` | `!(mxResult.errors.length > 0 || spfResult.errors.length > 0 || dkimResult.errors.length > 0)` |
| `spf` | `spfResult` |
| `dkim` | `dkimResult` |
| `mx` | `mxResult` |

The success flag reads only each subresult's `errors.length`; it does not inspect
`steps`, `records`, `targetRecords` or any SPF/DKIM detail. The property order
is `success`, `spf`, `dkim`, `mx`.

`verify` differs from `fastVerify` in two ways that are part of the contract:
`verify` starts its sub-checks concurrently through `Promise.all`, and its MX
branch asks for the full corrective report rather than the boolean fast check.

## 8. Tests checklist

The scenarios below cover the claims in this file that are not transcribed
literals or mechanical expansions of them: directory branch selection,
environment-entry guard gaps, caught versus uncaught failures, DNS failure
shapes, DKIM branch ordering, SPF iteration and the public orchestration
difference between `fastVerify` and `verify`. There is one subsection per
technical section §2-§7, and none is empty.

### 8.1 DKIM helper exports

* `getDkimDir(configDir, domain)` returns
  `<configDir>/dkim/<getDomainHashKey(domain, 2)>`, while a truthy
  `defaultDkim` returns `<configDir>/dkim/default`. This catches a description
  that treats `defaultDkim` as changing the hash input rather than the folder
  name.
* `getDkim` derives `id` from the DKIM directory basename, defaults a falsy
  `config.dkimSelector` to `main`, builds
  `<selector>._domainkey.<domain>`, reads the `txt` file as `utf8`, and returns
  the trimmed file value under `value`. This catches a description that uses the
  input domain as the returned `domain` field or the selector as the id.
* A direct `getDkim` call with missing `config` or an unreadable `txt` file
  rejects; only `_verifyDkim` maps that failure into
  `DkimGettingValueFailed`.

### 8.2 Construction

* Constructing `DomainNameVerifier(configDir)` stores `{}` as `_environments`,
  `5000` as `_dnsTimeout`, and builds no MX verifiers. This catches a
  description that requires an options object.
* A falsy `options.dnsTimeout` such as `0` is replaced by `5000`. This catches a
  defaulting rule based on key absence rather than truthiness.
* A present environment entry with value `null` raises during construction at
  the `.mailServers` read, while an entry object with no `mailServers` field
  constructs an `MxVerifier` over `[]`. This catches a description that treats
  key enumeration as proving the entry body is safe.

### 8.3 MX verification

* `verifyAnyMx` on MX DNS failure returns only an `errors` property holding
  `DnsGettingMxRecordsFailed`, with no `result` and no `steps`, and does not
  call the selected verifier. This catches a description that shares the full
  `_verifyMx` failure shape.
* `verifyAnyMx` on MX DNS success delegates to `verifier.verifyAnyMx(records)`
  and returns `{result, errors: []}`, so a missing environment raises only after
  a successful DNS lookup. This catches a description that validates the
  environment before DNS.
* `_verifyMx` with `fast = true` returns `false` on MX DNS failure without
  using the verifier, while `fast = false` calls `verifier.verify([])`, keeps
  that report's `records`, `targetRecords` and `steps`, and replaces its errors
  with `DnsGettingMxRecordsFailed`. This catches a description that gives both
  branches the same failure result.

### 8.4 DKIM verification

* A `getDkim` failure returns `DkimGettingValueFailed` plus
  `DkimAskSupport`, regardless of the caught error. This catches a description
  that lets file-read or missing-environment failures escape from `_verifyDkim`.
* TXT lookup rejection, empty or non-array TXT result, multiple TXT records and
  key mismatch each produce the distinct error/step pair stated in §5, and the
  empty-result branch uses message parameter `DNS record not found`. This catches
  a description that collapses all DNS/TXT failures into one code.
* With exactly one TXT record, `_verifyDkim` joins that record's chunks with
  `''` and compares the joined value against the twice-trimmed expected value.
  This catches a description that compares arrays directly or trims the DNS
  record after joining.

### 8.5 SPF verification

* `_getAllMailServersIps` resolves A records for every configured mail server in
  input order, returns one `{ip, server}` per fulfilled IP value, emits one
  `DnsGettingARecordsFailed` per rejected server, and adds exactly one
  `MxAskSupport` step when any lookup failed. This catches a description that
  fails fast on the first rejected A lookup.
* `_verifySpf` returns A-record lookup errors and steps before constructing
  `spfCheck.SPF`, so SPF validation does not run when any mail-server A lookup
  failed. This catches a description that always runs SPF checks after partial
  DNS success.
* SPF checks run sequentially over resolved IP records, and each non-`Pass`
  result creates one `SpfFailed` with domain, server, IP, result and message in
  that order. This catches a description that reports one SPF error per server
  rather than per resolved IP.
* `_createSetSpfStep` returns `SpfSetDnsRecord` when TXT lookup fails or no
  selected SPF record starts with `v=spf1 `, and returns `SpfChangeDnsRecord`
  using the implemented `inclute` spelling and `mailServers[0]` interpolation
  when a record exists. This catches a description that silently corrects the
  message or substitutes `spfInclude` in both places.

### 8.6 Public verification methods

* `fastVerify` awaits SPF, then DKIM, then fast MX, and computes the final value
  with the exact `mxResult && dkimResult.errors.length === 0 &&
  spfResult.errors.length === 0` expression. This catches a description that
  starts the three checks concurrently or short-circuits after SPF errors.
* `verify` starts SPF, DKIM and full MX through one `Promise.all`, returns
  `{success, spf, dkim, mx}`, and sets success only from the three
  `errors.length` values. This catches a description that inspects corrective
  steps or uses fast MX inside full verification.
* A missing environment argument has no uniform public behavior:
  `_verifySpf` rejects through an unguarded environment-entry read,
  `_verifyDkim` maps its helper failure to `DkimGettingValueFailed`, and MX
  paths depend on whether DNS fails before the missing verifier is used. This
  catches a caller contract that assumes every method returns a structured
  environment-not-found result.
