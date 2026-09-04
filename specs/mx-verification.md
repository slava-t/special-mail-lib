# MX Verification Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the `MxVerifier` class exported from `index.js`: configured-server
normalization, MX-record normalization, boolean verification, the full
corrective report, priority rewriting, emitted error codes and corrective step
messages.

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here: this file uses
**In-exchange** and **Out-exchange** as that glossary defines them.

* **MX record**: an object supplied to `MxVerifier` whose `exchange` property is
  an MX host name and whose `priority` property is compared numerically.
* **Normalized MX record**: the shallow copy of an MX record whose `exchange`
  has been lowercased and whose other enumerable properties are preserved.
* **Configured mail server**: a lowercased server name stored by the
  constructor as an expected in-exchange.
* **In record**: a record whose normalized `exchange` is one of the configured
  mail servers.
* **Out record**: a record whose normalized `exchange` is not one of the
  configured mail servers.
* **Target record**: an entry in the desired record sequence returned by
  `verify`; it is either an in record in configured-server order or an out
  record in normalized MX order, and it may carry `newPriority`.
* **Corrective step**: an object in a `verify` report's `steps` list, carrying
  `step`, `record` and `message`.
* **Fast verification**: the boolean predicate `fastVerify` computes from the
  normalized record order, without constructing a corrective report.

## 1. Goals and non-goals

### 1.1 Goals

* Specify construction of `MxVerifier`, including lowercasing, duplicate removal
  and configured-server order.
* Specify normalization and comparison of MX records.
* Specify `verifyAnyMx`, `fastVerify` and `verify`, including the respect in
  which the two boolean methods differ from the corrective report.
* Specify priority rewriting, the target record sequence, and the circumstances
  under which MX error codes and corrective steps are emitted.

### 1.2 Non-goals

* DNS lookup. This file consumes MX records already supplied by a caller.
  `dnsResolve` is specified by [utilities.md §7], and domain-level MX lookup is
  owned by `domain-verification.md`.
* Error message-template ownership. This file names the MX error codes and when
  they are raised; [errors.md §3] owns the templates formatted by `createError`.
* SPF, DKIM and domain verification. Those are separate domain-verification
  concerns, even though their errors share the catalog of [errors.md §3].
* Consumer user interfaces. Corrective steps are plain data; rendering them is
  outside this library contract.

## 2. Construction and comparison

`MxVerifier` MUST be exported from `index.js` as a named property and MUST be
the class defined by `lib/MxVerifier.js`.

The constructor MUST have the signature `constructor(mailServers)`. It MUST
initialize `_mailServers` as an empty array and `_mailServerSet` as an empty
`Set`, then iterate `mailServers` in order.

For each configured value, the constructor MUST lowercase it by calling
`toLowerCase()`. If the lowercased value is not already present in
`_mailServerSet`, the constructor MUST append it to `_mailServers` and add it
to `_mailServerSet`. If the lowercased value is already present, the duplicate
MUST be skipped. The ordered array therefore preserves the first occurrence of
each normalized configured server, while the set mirrors the same membership for
constant-time lookup.

The constructor does not guard `mailServers` or its elements. A missing or
non-iterable `mailServers` value raises before construction can complete, and an
element without a callable `toLowerCase` raises at that element.

`_mxExchangeCompare(r1, r2)` MUST compare `r1.exchange` and `r2.exchange` with
JavaScript `>` and `<` and return `1`, `-1` or `0` through the expression
`(r1.exchange > r2.exchange) - (r1.exchange < r2.exchange)`.

`_mxPriorityCompare(r1, r2)` MUST return `r1.priority - r2.priority`.

`_mxFullCompare(r1, r2)` MUST return the priority comparison when it is truthy,
and otherwise MUST return the exchange comparison. Sorting by the full
comparison is therefore priority ascending, then exchange ascending.

## 3. Record normalization

`_normalizeMxRecords(mxRecords)` MUST return a new array of normalized MX
records. It MUST map the input array in order and, for each element, create a
shallow copy of that element with `exchange` replaced by
`x.exchange.toLowerCase()`.

All enumerable properties other than `exchange` MUST be preserved on each
normalized record. The input array's record objects MUST NOT be mutated by
normalization.

After mapping, `_normalizeMxRecords` MUST sort the new array in place with
`_mxFullCompare` and return it. The sorted normalized array is the `records`
field returned by `verify`.

The normalizer does not guard `mxRecords`, individual records, `exchange`, or
`priority`. A missing `mxRecords` value raises at the `map` call; a record
whose `exchange` lacks `toLowerCase` raises while mapping; priority values reach
numeric subtraction as given.

## 4. Any-MX verification

`verifyAnyMx(mxRecords)` MUST normalize `mxRecords` as §3 specifies, then scan
the normalized records in sorted order.

It MUST return `true` immediately when any normalized record's `exchange` is a
member of `_mailServerSet`. If the scan completes without a member, it MUST
return `false`.

`verifyAnyMx` is a membership predicate only. It MUST NOT check priority order,
MUST NOT require any out record, MUST NOT build target records, and MUST NOT
create errors or corrective steps.

An empty configured-server set always makes `verifyAnyMx` return `false` after
normalization, because no exchange can be a member of the set.

## 5. Fast verification

`fastVerify(mxRecords)` MUST normalize `mxRecords` as §3 specifies and return a
boolean. It MUST NOT call `verify`, and MUST NOT build a corrective report.

It MUST return `false` when the normalized record count is less than or equal to
the configured-server count. This guarantees that any `true` result has at
least one out record after the configured-server block.

When the count precondition passes, `fastVerify` MUST walk `_mailServers` in
configured order while reading the normalized records at the same indexes. For
each configured server at index `i`, it MUST return `false` when either:

1. the configured server is not exactly equal to `records[i].exchange`; or
2. `i` is greater than zero and `records[i - 1].priority` is greater than or
   equal to `records[i].priority`.

After that configured-server block, `fastVerify` MUST inspect the next
normalized record. It MUST return `false` when that record's exchange is still
in `_mailServerSet`, or when at least one configured server was checked and the
last configured record's priority is greater than or equal to the next record's
priority.

Only when all checks pass MUST `fastVerify` return `true`.

For an empty configured-server set, one or more records make the count
precondition pass, the configured-server loop does not run, and the final set
membership check passes because the set is empty. Such input returns `true`.
With no configured servers and no records, the count precondition returns
`false`.

## 6. Full verification and priority rewriting

`verify(mxRecords)` MUST normalize `mxRecords`, classify those normalized
records, rewrite priorities in the classified target records, and return the
report of §7. It MUST perform those operations in this order:

1. Set `records` to `_normalizeMxRecords(mxRecords)`.
2. Set `{inRecords, outRecords}` to `_classifyRecords(records)`.
3. Compute `{upperPriority, upperPriorityDelta}` with
   `_getUpperPriorityProps(outRecords, inRecords.length)`.
4. Mutate `inRecords` with `_setInPriorities(inRecords, upperPriority)`.
5. Mutate `outRecords` with
   `_setOutPriorities(outRecords, upperPriority, upperPriorityDelta)`.
6. Return `_createReport(records, inRecords, outRecords)`.

### 6.1 Classification

`_classifyRecords(mxRecords)` MUST first copy each normalized record down to a
new object with exactly `exchange` and `priority`.

It MUST select every copied record whose `exchange` is in `_mailServerSet` as an
in record, then build a `Map` from exchange to that copied record. When more
than one normalized record has the same configured exchange, the map keeps the
last matching copied record in normalized order.

The returned `inRecords` list MUST be in `_mailServers` configured order. For
each configured server, the list MUST contain the matching mapped record when
one exists, or `{priority: -1, exchange: <server>}` when none exists. These
placeholder records are how missing configured servers are represented.

The returned `outRecords` list MUST contain each copied record whose `exchange`
is not in `_mailServerSet`, preserving the normalized record order.

### 6.2 Upper priority and in-record priorities

`_getUpperPriorityProps(outRecords, minPriority)` MUST set `upperPriority` to
the first out record's priority when at least one out record exists, and to
`10 * minPriority` when no out record exists.

It MUST set `upperPriorityDelta` to `minPriority - upperPriority` only when the
first `upperPriority` value is below `minPriority`; otherwise it MUST set the
delta to `0`. It MUST then add the delta to `upperPriority` and return both
values.

`_setInPriorities(records, upperPriority)` MUST mutate the records it receives.
It MUST walk them in order with a local priority counter initialized to `0`.

For each record at index `i`:

1. When `record.priority < 0`, the record is a missing configured server. The
   method MUST set `record.newPriority` to the current counter value and then
   increment the counter.
2. When `record.priority < upperPriority - i`, the existing priority is
   preserved. The method MUST NOT set `newPriority` on that record and MUST set
   the counter to `record.priority + 1`.
3. Otherwise the record is present but too late in the desired configured-server
   block. The method MUST set `record.newPriority` to the current counter value
   and then increment the counter.

### 6.3 Out-record priorities

`_setOutPriorities(records, upperPriority, upperPriorityDelta)` MUST mutate the
out records it receives only when `upperPriorityDelta` is positive. When the
delta is `0`, it MUST leave all out records unchanged.

When the delta is positive, the method MUST walk the out records in order with
`prevPriority` initialized to `-1`. For each record, it MUST set
`record.newPriority` to `record.priority + upperPriorityDelta` and update
`prevPriority` to that new value when either:

1. `record.priority < upperPriority`; or
2. `record.priority <= prevPriority`.

At the first out record satisfying neither condition, the method MUST stop and
MUST leave that record and all later out records unchanged.

The priority examples below are requirements of the implemented arithmetic:

| Configured servers | Input records | Target consequence |
|--------------------|---------------|--------------------|
| none | none | `verify` returns empty `records` and `targetRecords`, plus `MxMissingOutExchange` and `MxAddOutRecord`; `fastVerify` returns `false`. |
| none | `10 test.mail` | `verify` returns no errors and no steps; `fastVerify` returns `true`. |
| `test.mail` | none | The missing in-record receives `newPriority: 0`; `MxMissingInExchange`, `MxMissingOutExchange`, `MxAddInRecord` and `MxAddOutRecord` are emitted. |
| `test1.com`, `test2.com`, `test3.com` | `40 out1.com`, `50 out2.com`, `60 out3.com` | The three missing in-records receive `newPriority` values `0`, `1` and `2`; the out records do not receive `newPriority`. |
| `test1.com`, `test2.com`, `test3.com` | `2 out1.com`, `3 out2.com`, `10 out3.com` | The three missing in-records receive `0`, `1` and `2`; `out1.com` shifts to `3`, `out2.com` shifts to `4`, and `out3.com` is unchanged. |
| `test1.com`, `test2.com`, `test3.com` | `0 out1.com`, `1 out2.com`, `2 out3.com`, `20 test2.com`, `30 test3.com` | `test1.com` receives `0`, `test2.com` receives `1`, `test3.com` receives `2`, and all three out records shift to `3`, `4` and `5`. |

## 7. Report, errors and steps

`_createReport(records, inRecords, outRecords)` MUST build a report object with
exactly these four own properties:

| Property | Value |
|----------|-------|
| `records` | the normalized records array from §3 |
| `targetRecords` | `inRecords.concat(outRecords)` |
| `errors` | an array of error objects produced by `createError` |
| `steps` | an array of corrective steps |

The `targetRecords` entries are the same objects held by `inRecords` and
`outRecords`; any `newPriority` mutations from §6 are visible in the report.

The report builder MUST scan `targetRecords` in order. For each record whose
`priority < 0`, it MUST append `createError('MxMissingInExchange',
record.exchange)` to `errors`, and MUST append this corrective step:

| Step field | Value |
|------------|-------|
| `step` | `MxAddInRecord` |
| `record` | the same target record object |
| `message` | `Add new MX record '{newPriority} {exchange}' (priority={newPriority}, exchange={exchange})`, formatted with the record through `string-template` |

For each record whose `priority` is not below zero and that has an own
`newPriority` property, the builder MUST append one priority error and one
priority-change step. The error code MUST be `MxPriorityTooLow` when
`record.priority < record.newPriority`, and `MxPriorityTooHigh` otherwise. The
error MUST be created as `createError(code, record.exchange, record.priority)`.

The priority-change step MUST be:

| Step field | Value |
|------------|-------|
| `step` | `MxChangePriority` |
| `record` | the same target record object |
| `message` | `In the MX record '{priority} {exchange}' change the priority from {priority} to {newPriority}`, formatted with the record through `string-template` |

After scanning `targetRecords`, when `outRecords.length === 0`, the builder MUST
append `createError('MxMissingOutExchange')` to `errors`, and MUST append this
corrective step:

| Step field | Value |
|------------|-------|
| `step` | `MxAddOutRecord` |
| `record` | `{}` |
| `message` | `Add at least one MX record for a target server.` |

The four MX error codes named in this section are catalog entries of
[errors.md §3]. This file owns when `MxVerifier` creates them, not the formatted
message templates returned by `createError`.

`verify` returns the report object exactly as this section builds it. It MUST
NOT add a success flag, MUST NOT omit empty `errors` or `steps` arrays, and MUST
NOT call `fastVerify` to decide whether to skip report construction.

## 8. Tests checklist

### 8.1 Construction and normalization

* Constructing with duplicate configured servers differing only by case stores
  one lowercased name in `_mailServers`, preserves the first normalized
  occurrence order, and records the same membership in `_mailServerSet`.
* Normalizing records lowercases `exchange`, preserves non-`exchange`
  enumerable properties on the copied records, sorts by priority then exchange,
  and leaves the caller's record objects unchanged.
* Missing constructor input, missing `mxRecords`, or a record whose `exchange`
  has no `toLowerCase` raises rather than being converted into an empty result.

### 8.2 Boolean verification

* `verifyAnyMx` returns `true` when any normalized exchange is configured,
  regardless of priority order or out-record presence, and returns `false` when
  the configured set is empty.
* `fastVerify` returns `false` when record count is less than or equal to the
  configured-server count, when the leading records are not the configured
  servers in order, when configured priorities are not strictly increasing, when
  the first out record is still configured, or when that first out priority is
  not greater than the last configured priority.
* With no configured servers, `fastVerify([])` is `false` and `fastVerify` with
  one or more normalized records is `true`.

### 8.3 Classification and priority rewriting

* Duplicate in-record exchanges are classified by the last matching normalized
  record in map insertion order, while missing configured servers produce
  `{priority: -1, exchange}` placeholders.
* A present in record below `upperPriority - index` keeps its existing priority
  and receives no `newPriority`; missing or too-late in records receive the
  sequential counter values of §6.2.
* When `upperPriorityDelta` is positive, leading out records below the adjusted
  upper priority, or not greater than the prior shifted priority, receive
  shifted `newPriority` values until the first already-adequate record stops the
  loop.

### 8.4 Report shape

* `verify` returns `{records, targetRecords, errors, steps}` on both success and
  failure; successful verification has empty `errors` and `steps` arrays rather
  than omitting those fields.
* Missing configured servers emit `MxMissingInExchange` and `MxAddInRecord`;
  too-low and too-high priorities emit `MxPriorityTooLow` or
  `MxPriorityTooHigh` plus `MxChangePriority`; absence of all out records emits
  `MxMissingOutExchange` and `MxAddOutRecord`.
* The three corrective step messages in §7 match `lib/MxVerifier.js`
  character-for-character after `string-template` formatting.
