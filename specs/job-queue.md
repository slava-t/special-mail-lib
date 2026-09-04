# Job Queue Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the PostgreSQL-backed job queue exported from `index.js` through the
spread of `lib/JobQueue.js`: queue construction, item pushing, subscription,
processing, completion handling and target notification. The two exported
symbols specified here are exactly the `lib/JobQueue.js` rows whose home spec is
this file in [overview.md §3].

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here: this file uses
**Item**, **Guid**, **Environment** and **Target** as that glossary defines
them.

* **Queue item**: the object this queue sends to pg-boss as a unit of work. A
  queue item that wraps a transport carries it under the `transport` property;
  [transport-model.md §2] owns that object's fields, and [jobs.md §2] owns which
  job-class inputs use such items.
* **Job record**: the object pg-boss passes to a worker or completion handler.
  This spec names the record fields `JobQueue` reads, but pg-boss owns how the
  record is assembled.
* **Job-options object**: the object stored on `this._jobOptions` and supplied to
  job-class constructors. It combines the resolved logger, caller job options and
  the queue instance.
* **Blocked-URL pattern**: one entry of `blockNotifyUrls`, compiled or retained
  by the constructor and later tested by `_shouldNotify`.
* **Notification target**: the value passed to `notify` before normalization. It
  can be a list of per-target objects, a string address or domain, or an object
  carrying `host`.
* **Notification request**: the HTTP-request description that `notify` places on
  the queue, with `url`, `headers`, `data` and `auth` keys.
* **Fail type**: the string passed to a configured fail handler from completion
  handling. The two values are `in.job.fail.complete` and
  `in.job.fail.partial`.
* **Retry profile**: the `retryLimit`, `retryDelay` and `expireInSeconds` values
  supplied with a queued item.

## 1. Goals and non-goals

### 1.1 Goals

* Specify the construction, defaults, side effects and stored state of
  `JobQueue`.
* Specify the item shapes this file writes, the queue names it writes and the
  retry profiles it supplies.
* Specify processing, subscription and completion behavior, including the error
  paths that are logged and swallowed.
* Specify notification URL selection, direct-notification overrides, blocked URL
  handling and array fan-out.

### 1.2 Non-goals

Scoped by this spec's own subject, never by an incidental property of the current
source:

* pg-boss connection management, subscription behavior, `send` and `insert`
  semantics, retry enforcement, expiry enforcement and job-record assembly.
  [overview.md §4] names pg-boss as a dependency; this spec states only which
  calls `JobQueue` makes and what arguments it supplies.
* The transport object and the message it carries. [transport-model.md §2] owns a
  transport's fields; this spec owns only the queue item that carries one under
  `transport`.
* The conversions this file calls but does not own. [transport-model.md §10],
  [utilities.md §6], [utilities.md §8] and [config-and-resolvers.md §5] are the
  sole authorities for `extractGuid`, `urlJoin`, `allPromises` and `createUrl`.
  This spec names the calls and uses their results.
* How an environment or direct-notification option set is produced.
  [config-and-resolvers.md §9] returns an environment entry, and
  [routing-headers.md §9] specifies the `directNotification*` fields that a
  caller may pass to `notify`; this spec states what `notify` does with each.
* The job classes, job types and queue names written by job code outside
  `lib/JobQueue.js`. [jobs.md §2], [jobs.md §3] and [jobs.md §5] own the
  non-routing contracts; [routing.md §4], [routing.md §6], [routing.md §7] and
  [routing.md §8] own the routing job contracts. This spec states only the
  registry shape this file reads and the construction contract it applies.
* The other symbols exported from `lib/util.js`. [overview.md §3] routes each of
  them to another spec, and the spec that row names is the sole authority for
  that symbol.

The queue item is not a non-goal. `JobQueue` writes queued items directly in
`pushItem`, `pushTrackedItem`, `pushItems` and `notify`, and this file is the
authority for those written shapes.

## 2. The queue object

`JobQueue` MUST be exported as a class. Its constructor signature is
`constructor(options = {})`.

The constructor MUST store a shallow copy of `options` on `this._options` before
deriving any other stored value. It MUST then resolve `this._logger` by applying
`getLogger` to `this._options`, which [logging.md §3] specifies.

`this._failHandler` MUST be read from `options.failHandler`, the original
argument, not from `this._options.failHandler`. For an argument whose
`failHandler` is an own enumerable property, the spread that created
`this._options` makes the two reads yield the same value. Inherited and
non-enumerable properties are not copied by the spread.

The constructor MUST then build, in order, the job-options object (§3), the
blocked-URL list (§4), the job-class registry (§6), the pg-boss connection (§5),
the resolver reference, and the pg-boss error listener.

The resolver reference MUST be `this._jobOptions.resolver`. A top-level
`options.resolver` is not read for this purpose unless it is also present under
`options.jobOptions.resolver`.

## 3. The job-options object

The job-options object MUST be assigned to `this._jobOptions` as:

```
{
  logger: this._logger,
  ...(options.jobOptions || {}),
  queue: this
}
```

The order above is the conflict rule. A caller-supplied
`options.jobOptions.logger` overrides the logger resolved through
[logging.md §3] in §2, because it is spread after `logger`. The `queue` key is
written last, so no caller-supplied `queue` value can displace the `JobQueue`
instance itself.

When `options.jobOptions` is falsy, the spread contributes nothing. The
constructor MUST NOT validate the object before spreading it.

Every job-class instance constructed by `_processJob` receives this same
job-options object as its second constructor argument (§7). Mutating the object
after construction is therefore visible to later job-class construction.

## 4. Blocked notification URLs

`this._blockNotifyUrls` MUST start as an empty array. When
`this._options.blockNotifyUrls` is falsy, the array remains empty and
`_shouldNotify` permits every URL.

When `this._options.blockNotifyUrls` is truthy, the constructor MUST iterate its
elements in order and append one pattern per element:

1. A `RegExp` element MUST be appended unchanged, preserving its source and
   flags.
2. A non-`RegExp` element MUST be used as given. When that value starts with `^`
   and ends with `$`, it MUST be compiled as written with the `g` flag.
3. Otherwise the value MUST have its characters `- / \ ^ $ * + ? . ( ) | [ ] {
   }` escaped, then be wrapped with `^` and `$`, and then be compiled with the
   `g` flag. A value without the string methods this construction calls raises
   during construction.

An already anchored string is therefore trusted as a regular-expression source;
its metacharacters remain live. A non-anchored string is matched literally and
against the whole URL.

`_shouldNotify(url)` MUST test the compiled patterns in stored order. It MUST
return `false` at the first pattern for which `url.match(re)` is truthy, and
MUST return `true` only when no pattern matches.

Compiled string patterns are case-sensitive because they carry `g`, not `i`.
That differs from the domain-name resolver's matching in
[config-and-resolvers.md §4], and consumers MUST NOT treat the two matching
rules as interchangeable.

## 5. The pg-boss connection

The constructor MUST load pg-boss during construction and instantiate it with one
options object. That object MUST carry exactly these keys:

| Key | Value |
|-----|-------|
| `host` | `options.host || 'localhost'` |
| `port` | `options.port || 5432` |
| `database` | `options.database || 'mailqueue'` |
| `user` | `options.user || 'mailqueue'` |
| `password` | `options.password` |
| `monitorStateIntervalSeconds` | `options.monitorStateIntervalSeconds || 600` |
| `maintenanceIntervalSeconds` | `options.maintenanceIntervalSeconds || 600` |

All defaults except `password` apply on any falsy value, not only on an absent
key. `password` is passed through as read, so an absent password contributes
`undefined`.

The resulting pg-boss instance MUST be stored on `this._queue`.

The constructor MUST register one `error` listener on `this._queue`. The listener
MUST log at `error` level through `this._logger`, with message
`An error occurred in pg-boss` and the error object as the second argument. The
listener MUST NOT rethrow and MUST NOT otherwise report the event.

## 6. The job-class registry

The constructor MUST assign `this._jobClasses` as:

```
{
  ...jobClasses,
  ...(options.jobClasses || {})
}
```

A caller entry whose key matches a built-in key replaces that entry wholesale.
The replacement is not a merge of nested fields.

An entry is read by this file as an object that may carry:

| Field | Consumed as |
|-------|-------------|
| `JobClass` | the constructor used by `_processJob` |
| `optionsField` | the third argument passed to that constructor |

This spec does not specify which job types are built in or which class each type
uses. That mapping belongs to [jobs.md §3]. It does specify the consequence of
any entry shape that reaches `_processJob` (§7).

## 7. Processing a job

`JobQueue._processJob` MUST have the signature `_processJob(job)` and MUST be
asynchronous.

When `job.data` is falsy, `_processJob` MUST log at `error` level with message
`Invalid job: no data field in the job` and MUST return without further work.

Otherwise it MUST destructure `JobClass` and `optionsField` from
`this._jobClasses[job.data.job]` before checking whether `JobClass` is truthy.
An unregistered job type therefore raises before the invalid-type log can run:
destructuring `undefined` throws. A registered entry with a falsy `JobClass`
does reach the guard; in that case `_processJob` MUST log at `error` level with
message `Invalid job type: ` and `job.data` as the second argument, then return.

When `JobClass` is truthy, `_processJob` MUST bind `item` to `job.data` itself
and delete `item.queueOptions`. This mutates the job record's data object rather
than a copy.

It MUST then construct `new JobClass(item, this._jobOptions, optionsField)` and
await the constructed instance's `process()` method. The fulfilment value of
`process()` is ignored. A rejection from `process()` is not caught here.

## 8. Starting and stopping

`JobQueue.start` MUST have the signature `start(options)` and MUST be
asynchronous. It MUST await `this._queue.start(options)` and return no explicit
value. The argument reaches pg-boss uninspected and unmodified.

`JobQueue.stop` MUST have the signature `stop()` and MUST be asynchronous. It
MUST await `this._queue.stop()` and return no explicit value.

Neither method catches; a rejection from the underlying pg-boss call reaches the
caller.

## 9. Subscribing

`JobQueue.subscribe` MUST have the signature `subscribe(options)` and MUST be
asynchronous. The parameter has no default. A call without an argument raises on
the first property read.

The method MUST resolve its subscription values before registering handlers:

| Local value | Resolution |
|-------------|------------|
| `queuename` | `options.queuename || this._options.queuename || 'mail-*'` |
| `teamSize` | `options.teamSize || this._options.teamSize || 100` |
| `teamConcurrency` | `options.teamConcurrency || this._options.teamConcurrency || 100` |
| `newJobCheckInterval` | `options.newJobCheckInterval || this._options.newJobCheckInterval || 2` |
| `teamRefill` | `options.teamRefill`, defaulted to `true` only when its type is `undefined` |

The first four values advance through the `||` fallback chain on any falsy
method-level value. An explicit `0` — and an empty `queuename` — is therefore
replaced by the constructor-level value when that value is truthy, and by the
literal default only when the constructor-level value is also falsy.
`teamRefill` uses a different operator: `false`, `0` and `null` survive because
only `undefined` is replaced.

`teamRefill` also uses a different source. It reads `options.teamRefill` alone;
`this._options.teamRefill` is never consulted. A value supplied only to the
constructor therefore does not affect a later `subscribe({})` call.

The method MUST await `this._queue.work` with `queuename`, an options object, and
a worker. The options object MUST carry `teamSize`, `teamConcurrency`,
`teamRefill` and `newJobCheckIntervalSeconds`, where the last key receives the
local `newJobCheckInterval`. The worker MUST await
`this._processJob(job)`.

After the worker registration, `subscribe` MUST await `this._queue.onComplete`
with the same `queuename` and the completion handler specified in §10.

## 10. Completion handling

The completion handler registered by `subscribe` MUST be asynchronous and MUST
read the pg-boss completion record as `job`.

It MUST begin by constructing `item` as a shallow copy of
`job.data.request.data`. This is a read from the completion record; the handler
does not branch on a job type and does not require the copied data to have a
POST-specific shape.

It MUST then bind `queueOptions` to `item.queueOptions || {}`. When
`job.data.failed` is falsy, the handler performs no further action.

When `job.data.failed` is truthy, the handler MUST start with fail type
`in.job.fail.complete`. If `queueOptions.pushIfFail` is truthy, it MUST delete
`queueOptions.pushIfFail`, read `job.data.request.name` as the queue name, call
`this.pushItem(item, queueName)` and set the fail type to
`in.job.fail.partial`.

That `pushItem` call MUST NOT be awaited. Because `pushItem` is asynchronous, the
send is issued if `pushItem` reaches it, but the completion handler need not
wait for pg-boss to accept the re-queued item. A send failure is handled by
`pushItem`'s own catch, not by this completion handler.

The copy of `item` is shallow. If `job.data.request.data.queueOptions` is an
object, `queueOptions` and `item.queueOptions` are that same object. Deleting
`pushIfFail` therefore removes the marker from the re-queued item as well as
from the local `queueOptions` binding.

If `this._failHandler` is truthy after the re-queue decision, the handler MUST
call and await `this._failHandler(failType, job)` inside its own `try` block. A
throw or rejection from the fail handler MUST be caught and logged at `error`
level with message
`ERROR: unexpected error occured while processing a job failure` and the error
object. The completion handler MUST NOT rethrow that failure.

## 11. Pushing items

`pushItem`, `pushTrackedItem` and `pushItems` are asynchronous and return `true`
on successful queue submission. On a caught submission error, each logs and
returns no explicit value, so the returned promise fulfils with `undefined`.

`pushItem(item, queueName = 'mail-main')` MUST await `this._queue.send` with:

| Key | Value |
|-----|-------|
| `name` | `queueName` |
| `data` | `item` |
| `options.retryLimit` | `288` |
| `options.retryDelay` | `600` |
| `options.expireInSeconds` | `1800` |

If the send throws or rejects, `pushItem` MUST log at `error` level with message
`ERROR: unexpected error occurred while queueing an item` and the error object.

`pushTrackedItem(item, queueName = 'mail-main')` MUST await `this._queue.send`
with the same `name` key and an `options` object whose `retryDelay` is `600` and
whose `expireInSeconds` is `1800`, but whose `retryLimit` is `3`. Its `data`
MUST be a shallow copy of `item` with `queueOptions` replaced by
`{pushIfFail: true}`. A caller-supplied `item.queueOptions` is therefore
overwritten rather than merged.

If the tracked send throws or rejects, `pushTrackedItem` MUST log at `error`
level with message
`ERROR: unexpected error occured while queueing a two staged item` and the error
object.

`pushItems(items, queueName = 'mail-main')` MUST map `items` in order to job
objects and await `this._queue.insert(jobs)`. Each job object MUST carry:

| Key | Value |
|-----|-------|
| `name` | `queueName` |
| `data` | the current input item |
| `retryLimit` | `288` |
| `retryDelay` | `600` |
| `expireInSeconds` | `1800` |

The three retry fields are top-level keys for `pushItems`, not nested under
`options` as they are for the two `send` paths.

If the insert throws or rejects, `pushItems` MUST log at `error` level with
message `ERROR: unexpected error occurred while queueing the items` and the error
object.

## 12. Queue names

`lib/JobQueue.js` writes exactly three queue-name strings:

| Name | Written by |
|------|------------|
| `mail-*` | `subscribe`'s default subscription name |
| `mail-main` | the default `queueName` for `pushItem`, `pushTrackedItem` and `pushItems` |
| `mail-notify` | the queue name used by `notify` when it enqueues a notification request |

Every other `mail-` queue name under `lib/` is written outside this file and
belongs to [jobs.md §5] or [routing.md §8]: `mail-route` is written by
`EmailParsingJob`, while routing-owned queue names remain outside this file.

`jobTypes.POST` is not a queue name. It is the job type written into the
notification queue item (§13), and the job-types mapping belongs to [jobs.md §2].

## 13. Notification

`JobQueue.notify` MUST have the signature
`notify(target, type, content, options = {}, guid)` and MUST be asynchronous.
All work after entry runs inside one outer `try` block except asynchronous
settlement of an array fan-out that is returned without being awaited (§14).

When `target` is an array, `notify` MUST return the result of
`this._notifyAll(target, type, content, options)` immediately. It MUST NOT await
that result inside its own `try` block.

For a non-array string target, `notify` MUST split the string on `@` and keep the
last segment as the normalized target. For any other non-array target, it MUST
replace `target` with `target.host`. A `null` or `undefined` target therefore
raises on the property read and is caught by the outer catch before the explicit
invalid-target error can be constructed.

After normalization, a falsy target MUST raise a native `Error` whose message is
`Invalid notification target: ${target}`. The error is caught by the outer catch.

When `guid` is falsy, `notify` MUST replace it with the result of applying
`extractGuid` to `content`, which [transport-model.md §10] specifies.

Notification URL selection MUST then run in this order:

1. Initialize `headers` to `{}` and `auth` to `undefined`.
2. Call `this._resolver.createUrl(target)`. This call is unguarded: a queue whose
   job-options object supplies no `resolver` raises here for every non-array
   notification that reaches URL selection. The outer catch logs and swallows
   that failure.
3. When the result exists and its `index` is at least zero, set `url` to the
   result's `notificationUrl` and `headers` to the result's `headers`. The
   result fields are those of [config-and-resolvers.md §5]. The `index >= 0`
   half can fail only for a result from the `defaultTarget` branch
   [config-and-resolvers.md §4] describes; no assignment under `lib/` makes that
   branch live, but a consumer can assign the property on a resolver instance.
4. Otherwise call `getEnvironment(target, this._jobOptions)`, which
   [config-and-resolvers.md §9] specifies. If it returns no environment, raise a
   native `Error` whose message is `Could not find and environment for ${target}`.
5. For an environment result, set `url` to `urlJoin(environment.baseUrl,
   environment.notificationPostUri)`, where `urlJoin` is specified by
   [utilities.md §6]. The `baseUrl`, `notificationPostUri`,
   `notificationPostHeaders` and `notificationPostAuth` fields are environment
   entry fields of [config-and-resolvers.md §12], not resolver-result fields.
   Set `headers` to `environment.notificationPostHeaders || {}` and `auth` to
   `environment.notificationPostAuth`.
6. When `options.directNotificationUrl` is truthy, replace `url` with it,
   replace `headers` with `options.directNotificationHeaders`, and replace
   `auth` with `options.directNotificationAuth`. These names are the direct
   notification result fields specified by [routing-headers.md §9]. The override
   assigns `headers` unconditionally, with no `|| {}`; a direct-notification
   options object carrying a URL but no headers field produces a notification
   request whose `headers` is `undefined`. A present direct-routing config entry
   that supplies those fields has the shape [routing-headers.md §10] specifies.

The `baseUrl` in the environment branch is the environment entry field, while
the static-route branch reads a resolver result built by `createUrl`. A consumer
MUST NOT derive one from the other.

The local `headers` variable is the outgoing HTTP header object placed on a
notification request. It is not a transport header map, the parsed-mail header
list projection, or the direct-routing config entry field; it may be sourced
from a resolver result, an environment entry or a direct-notification override.

Before checking the block list, `notify` MUST log at `info` level with message
`--- JobQueue notify request ready ---` and an object carrying `url`, `target`
and `guid`.

If `_shouldNotify(url)` returns true, `notify` MUST build a notification request:

| Key | Value |
|-----|-------|
| `url` | the selected URL |
| `headers` | the selected outgoing headers value |
| `data.notificationType` | `type` |
| `data.guid` | `guid` |
| `data.content` | `content` |
| `data.target` | `target` |
| `auth` | the selected auth value |

It MUST then await `pushItem({job: jobTypes.POST, request}, 'mail-notify')`.
The queue item has exactly `job` and `request` keys at construction time; the
`POST` type value and built-in class mapping belong to [jobs.md §2] and
[jobs.md §3].

If `_shouldNotify(url)` returns false, `notify` MUST log at `info` level with
message `notification to ${url} is blocked by options` and MUST NOT enqueue the
request.

Any error caught by the outer catch MUST be logged at `error` level with message
`Notifying ${target} failed` and the error object. The method MUST NOT rethrow.

## 14. Notifying many targets

`JobQueue._notifyAll` MUST have the signature
`_notifyAll(targetDomains, type, content, options)` and MUST be asynchronous.

The method MUST map `targetDomains` in order. For each element `x`, the mapping
callback MUST call `this.notify(x.host, type, content, options, x.guid)` and
collect the returned promise.

The property reads occur before each per-element `notify` call. A string element
therefore supplies `undefined` as the target and no guid; that per-element call
enters `notify`, fails during its own non-array object normalization, is logged
by `notify` and fulfils with no notification enqueued. A `null` or `undefined`
element is different: reading `x.host` throws inside the mapping callback before
any per-element `notify` call exists, so `_notifyAll` returns a rejected promise
and no `notify` catch logs that element.

After building the promise array, `_notifyAll` MUST call `allPromises(promises)`,
which [utilities.md §8] specifies as returning an array of promises, and MUST
await that returned array itself. It MUST NOT pass the array to `Promise.all`.
An array is not a thenable, so this await does not wait for any per-target
notification promise to settle, and the settled-result objects are discarded.

## 15. The factory

`createJobQueue` MUST be exported as an asynchronous function with the signature
`createJobQueue(options)`. The parameter has no default.

The function MUST construct `new JobQueue(options)`, await `queue.start()` with
no argument, await `queue.subscribe(options)` with the original argument, and
return the queue.

A call with no argument constructs the queue because the constructor defaults
its parameter, then raises when `subscribe` reads its undefaulted parameter. The
function catches nothing, so a failure from construction, `start` or `subscribe`
rejects the returned promise.

## 16. Tests checklist

The scenarios below cover the claims in this file that are not transcribed
literals or mechanical expansions of them: defaulting rules, missing guards,
branch ordering, shallow-copy consequences, the queue item shapes, the
notification URL sources and the async gaps. There is one subsection per
technical section §2-§15, and none is empty.

### 16.1 The queue object

* Constructing `JobQueue` with no argument succeeds through the constructor
  defaults and stores a shallow copy of `{}`.
* A truthy `options.logger` reaches `getLogger` through `this._options`, while a
  caller `jobOptions.logger` later overrides it for job classes. This catches a
  description that treats the resolved logger as final for all consumers.
* A `failHandler` supplied as an own enumerable property is the same value on the
  original argument and on `this._options`; an inherited `failHandler` is not
  copied by the spread but is still read from the original argument.
* A top-level `resolver` option is not enough for notification URL selection; it
  must be supplied through `jobOptions.resolver` to reach `this._resolver`.

### 16.2 The job-options object

* A caller `jobOptions.logger` wins over the logger resolved in §2, because the
  caller object is spread after `logger`.
* A caller `jobOptions.queue` does not win: the stored `queue` key is the
  `JobQueue` instance because it is written last.
* Mutating `this._jobOptions` after construction is visible to later
  `_processJob` calls because the same object is passed to every job-class
  constructor.

### 16.3 Blocked notification URLs

* A `RegExp` entry is stored unchanged, preserving flags and pattern.
* An anchored string such as `^https://a.example/.*$` is compiled as written, so
  its metacharacters remain active.
* A non-anchored string is escaped and wrapped, so it matches the whole URL
  literally rather than as a substring or regular expression.
* Matching is case-sensitive for compiled strings. This catches an
  implementation that silently copies the domain-name resolver's case-insensitive
  matching behavior.

### 16.4 The pg-boss connection

* Falsy `host`, `port`, `database`, `user`, `monitorStateIntervalSeconds` and
  `maintenanceIntervalSeconds` values are replaced by their literal defaults,
  while `password` is passed through unchanged.
* The pg-boss instance is stored before notification and subscription methods can
  use it.
* An emitted pg-boss `error` event is logged with the fixed message and the
  error object, and is not rethrown by the listener.

### 16.5 The job-class registry

* A caller registry entry under a built-in key replaces the whole entry rather
  than merging a new `optionsField` into the built-in entry.
* A falsy `options.jobClasses` contributes nothing and leaves the built-in
  registry as the source of entries.
* An entry's `optionsField` is passed through to job-class construction even
  when it is absent, rather than defaulted by `JobQueue`.

### 16.6 Processing a job

* A job record with no `data` field logs `Invalid job: no data field in the job`
  and returns before any registry lookup.
* An unregistered job type raises before the invalid-type guard, because
  destructuring happens before the guard. A registered entry with falsy
  `JobClass` reaches the guard and logs.
* The deletion of `queueOptions` mutates the job record's data object itself.
* The job-class constructor receives the item, the shared job-options object and
  `optionsField`, and `_processJob` awaits `process()` without catching its
  rejection.

### 16.7 Starting and stopping

* `start(options)` passes its argument to pg-boss unchanged and awaits the call.
* `stop()` awaits the pg-boss stop call and catches nothing.

### 16.8 Subscribing

* Calling `subscribe()` with no argument raises on the first property read,
  unlike the constructor and `notify`.
* An explicit `teamSize: 0`, `teamConcurrency: 0`, `newJobCheckInterval: 0` or
  empty `queuename` is replaced by the next fallback, while
  `teamRefill: false` survives.
* A constructor-level `teamRefill` does not reach a later `subscribe({})` call,
  because only `options.teamRefill` is read.
* The worker awaits `_processJob(job)`, and the completion handler is registered
  only after the worker registration has been awaited.

### 16.9 Completion handling

* A successful completion record with `failed` falsy produces no re-queue and no
  fail-handler call.
* A failed completion without `queueOptions.pushIfFail` uses fail type
  `in.job.fail.complete` and does not re-queue.
* A failed completion with `queueOptions.pushIfFail` deletes the marker,
  re-queues to `job.data.request.name` and changes the fail type to
  `in.job.fail.partial`.
* The re-queue call is not awaited, so the handler can return before pg-boss has
  accepted the replacement item.
* A fail-handler rejection is logged with the fixed message and does not escape
  the completion handler.

### 16.10 Pushing items

* `pushItem` sends `data: item` with retry limit `288`; `pushTrackedItem` sends a
  shallow copy with `queueOptions: {pushIfFail: true}` and retry limit `3`.
* `pushItems` maps inputs in order and inserts job objects whose retry fields are
  top-level keys, not nested under `options`.
* All three push methods default `queueName` to `mail-main`.
* A caught send or insert failure logs the method-specific message and resolves
  with `undefined`, rather than rejecting.
* A caller-supplied `queueOptions` on a tracked item is overwritten, not merged.

### 16.11 Queue names

* This file writes `mail-*`, `mail-main` and `mail-notify`, and no other
  `mail-` queue name. A source sweep distinguishes the `mail-route` write owned
  by [jobs.md §5] from routing-owned queue names specified in [routing.md §8].
* `jobTypes.POST` is written as a job type in the notification item and is not a
  queue name.

### 16.12 Notification

* A string target keeps only the text after the last `@`; an object target uses
  its `host`; and `null` or `undefined` is caught before the explicit
  invalid-target error can be thrown.
* A queue without `jobOptions.resolver` logs and swallows every non-array
  notification that reaches URL selection before environment lookup can run.
* A static-route result with `index >= 0` uses `headers` from
  [config-and-resolvers.md §4]'s resolver result and `notificationUrl` added by
  [config-and-resolvers.md §5]; a `defaultTarget` result fails that guard and
  falls through.
* The environment branch builds the URL with `urlJoin` and the environment-entry
  fields, not from the resolver result's `baseUrl`.
* A direct-notification options object shaped like [routing-headers.md §9]'s
  URL-only result overrides `headers` to `undefined`, not `{}`.
* A blocked URL logs the blocked message and does not enqueue; an allowed URL
  enqueues `{job: jobTypes.POST, request}` to `mail-notify`.

### 16.13 Notifying many targets

* Array input to `notify` returns `_notifyAll`'s promise without awaiting it
  inside `notify`'s catch.
* A bare string element in the target list produces no notification: its `host`
  read yields `undefined`, and the per-element `notify` call logs and swallows
  the failure.
* A `null` or `undefined` element makes `_notifyAll` return a rejected promise
  that no per-element `notify` call logs.
* `_notifyAll` awaits the array returned by [utilities.md §8]'s `allPromises`,
  not `Promise.all` of that array, so it does not wait for per-target
  notification promises to settle.
* The settled-result objects that `allPromises` creates are discarded.

### 16.14 The factory

* `createJobQueue(options)` constructs, starts with no start options, subscribes
  with the original argument and returns the queue.
* `createJobQueue()` constructs successfully, then rejects when `subscribe`
  reads its missing argument.
