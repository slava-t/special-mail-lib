# Jobs Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the job type constants, the built-in job-class registry, the non-routing
job classes, the outbound mail helpers and the library-emitted notification type
catalog. The exported symbol specified here is exactly the `jobTypes` row whose
home spec is this file in [overview.md §3]. The unexported job modules are
specified with that exported symbol because the job type contract cannot be
described without the registry and the classes that consume those types.

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here: this file uses
**Item**, **Transport object**, **Target**, **Environment**, **`eml64`** and
**Guid** as that glossary defines them. It also uses **address object**,
**log-info object** and **JSON-safe email** as [transport-model.md §0] defines
them, **direct routing config** as [routing-headers.md §0] defines it, and
**queue item**, **job-options object**, **notification target** and
**notification request** as [job-queue.md §0] defines them.

* **Job type**: one of the six string constants exported by
  `lib/jobs/job-types.js`, used as the `job` value on queue items.
* **Job-class registry**: the object exported by `lib/jobs/job-classes.js`,
  keyed by job type and consumed by `JobQueue._processJob` as [job-queue.md §6]
  and [job-queue.md §7] specify.
* **Job-class item**: the queue item object after `JobQueue._processJob` has
  deleted its `queueOptions` key and before it is passed to a job-class
  constructor.
* **Parse item**: a job-class item consumed by `EmailParsingJob`, carrying
  `transport` and `eml64`.
* **Route item**: a queue item written by `EmailParsingJob` for later routing,
  carrying a sorted-out email's `mail` and `transport` plus `job: jobTypes.ROUTE`.
* **Posting request**: the `request` object consumed by `PostingJob`; notification
  requests are one source of posting requests and are specified in
  [job-queue.md §13].
* **Outbound send**: the call from `send_email` to
  `plugin.outbound.send_email`, carrying sender, recipient, message stream,
  completion callback and options.
* **Notification type**: a string beginning with `in.` that this library passes
  either to `JobQueue.notify` or to a job-failure handler.

## 1. Goals and non-goals

### 1.1 Goals

* Specify the six job type constants and the item shapes whose `job` values use
  them.
* Specify the built-in job-class registry: which job types have built-in classes,
  which class each one maps to, and which exported job type has no built-in
  registry entry.
* Specify `EmailParsingJob`, `PostingJob`, `ForwardingJob` and `CallbackJob`:
  constructor reads, stored state, process steps, logging inputs, queue writes,
  notification calls and error behavior.
* Specify the two outbound mail helpers in `lib/plugin-util.js`, including the
  in-memory stream options and the callback return-code handling.
* Catalog every `in.*` notification or fail type emitted by the library so later
  specs can refer to the type names without rediscovering them.

### 1.2 Non-goals

Scoped by this spec's own subject, never by an incidental property of the current
source:

* Queue mechanics, pg-boss behavior, retry enforcement, completion handling and
  notification URL selection. [job-queue.md §7], [job-queue.md §10],
  [job-queue.md §11], [job-queue.md §13] and [job-queue.md §14] own those. This
  file states only what the job classes pass to the queue.
* Parser internals and the sorted-out email shape. [email-parsing.md §3],
  [email-parsing.md §9], [email-parsing.md §10] and [email-parsing.md §11] own
  those. This file starts at the job that calls the parser.
* The transport object, address objects and log-info projection.
  [transport-model.md §2], [transport-model.md §3] and [transport-model.md §14]
  are their authorities.
* Direct-routing header parsing. [routing-headers.md §8] and
  [routing-headers.md §9] own the result shapes; this file states which job uses
  the notify result.
* Environment production. [config-and-resolvers.md §9] and
  [config-and-resolvers.md §12] own environment lookup and entry fields; this file
  states `ForwardingJob`'s use of the result.
* Routing decisions, `RoutingJob` process behavior, bounced-message routing,
  `mail-post-*`, `mail-forward`, and every routing-owned notification condition.
  [routing.md §3], [routing.md §4], [routing.md §6], [routing.md §7] and
  [routing.md §8] own them. This file names `RoutingJob` only where it appears
  in the registry and where its notification type strings must be cataloged.
* Third-party HTTP, SMTP, stream and MIME parser semantics. The dependency set is
  named in [overview.md §4]; this file names only the calls made by library code.

## 2. Job type constants and item taxonomy

`jobTypes` MUST be exported from `index.js` as a named property and MUST be the
object exported by `lib/jobs/job-types.js`.

That object MUST contain exactly these six own properties, in this order:

| Property | Value |
|----------|-------|
| `PARSE` | `parse` |
| `ROUTE` | `route` |
| `POST` | `post` |
| `NOTIFY` | `notify` |
| `FORWARD` | `forward` |
| `CALLBACK` | `callback` |

The property names are uppercase and the values are lowercase. A consumer MUST
NOT infer a built-in job class merely from the presence of a type constant:
`NOTIFY` is exported but has no built-in registry entry (§3).

The queue item property that carries a job type is named `job`. `JobQueue` owns
how that property is read and how invalid entries fail ([job-queue.md §7]); this
section owns the built-in type values that can be placed there.

The job-class item shapes consumed or written by this file are:

| Item kind | Required fields read or written here | Consumer or writer |
|-----------|--------------------------------------|--------------------|
| Parse item | `job: jobTypes.PARSE`, `transport`, `eml64`; additional fields are preserved when route items are created | Consumed by `EmailParsingJob` (§4, §5) |
| Route item | all fields of the parse item after `JobQueue` deletes `queueOptions`, with `mail`, `transport` and `job: jobTypes.ROUTE` overlaid | Written by `EmailParsingJob` (§5) |
| Posting item | `job: jobTypes.POST`, `request` | Consumed by `PostingJob` (§6); one writer is [job-queue.md §13] |
| Forwarding item | `job: jobTypes.FORWARD`, `transport`, `eml64` | Consumed by `ForwardingJob` (§7) |
| Callback item | `job: jobTypes.CALLBACK`, `arg` | Consumed by `CallbackJob` (§8) |

The parse, route and forwarding items carry the transport object directly under
`transport`. The posting item does not have to carry `transport` at top level:
`PostingJob` reads it from request data as §6 specifies. The callback item does
not require a transport object.

## 3. Built-in job-class registry

`lib/jobs/job-classes.js` MUST export one object, the built-in job-class
registry. Its keys MUST be computed from the job type constants of §2, and it
MUST contain exactly these five entries:

| Job type value | Registry entry |
|----------------|----------------|
| `parse` | `{JobClass: EmailParsingJob}` |
| `route` | `{JobClass: RoutingJob}` |
| `post` | `{JobClass: PostingJob}` |
| `forward` | `{JobClass: ForwardingJob}` |
| `callback` | `{JobClass: CallbackJob}` |

The registry MUST NOT contain an entry for `jobTypes.NOTIFY`. A queue item whose
`job` value is `notify` therefore has no built-in registry entry; the consequence
of an unregistered type belongs to [job-queue.md §7].

Every built-in registry entry MUST contain only `JobClass`. No built-in entry
MUST carry `optionsField`; when `JobQueue._processJob` passes that field as the
third constructor argument, the built-in value is `undefined`.

The `route` entry imports `RoutingJob` and maps `jobTypes.ROUTE` to it. That
mapping is a registry requirement only; routing decision behavior remains owned
by `routing.md`.

## 4. EmailParsingJob construction

`EmailParsingJob` MUST be the class exported by `lib/jobs/EmailParsingJob.js`.
Its constructor signature is `constructor(item, options)`.

The constructor MUST perform these assignments in order:

1. Store `getLogger(options)`, specified by [logging.md §3], as `this._logger`.
2. Store the `item` argument itself as `this._item`.
3. Store `options.plugin` as `this._plugin`.
4. Store `options.queue` as `this._queue`.
5. Compute direct-notification options by applying
   `getDirectNotifyRequestRouting` ([routing-headers.md §9]) to an object whose
   `headers` is `item.transport.headers` and whose `directRoutingConfig` is
   `this._plugin.directRoutingConfig`; store the result as `this._notifyOptions`.
6. Store `transportLogInfo(item.transport)`, specified by [transport-model.md §14],
   as `this._logInfo`.
7. Construct `new EmailParser()` and store it as `this._emailParser`.

The constructor does not copy `item`, `plugin` or `queue`. Later reads of
`this._item`, `this._plugin` and `this._queue` use the same objects supplied at
construction.

The direct-notification reader receives the parse item's transport headers, not
the parsed mail's headers and not a route item's later transport. A parse item
whose `transport` is absent, or whose `plugin` is absent, raises during
construction rather than during `process()`.

## 5. EmailParsingJob process

`EmailParsingJob.process` MUST be asynchronous and MUST return no explicit value
on success.

It MUST initialize local `emails` to the empty array and local `transport` to
`this._item.transport`. It MUST then attempt to parse the message by converting
`this._item.eml64` with `Buffer.from(this._item.eml64, 'base64')` and awaiting
`this._emailParser.parse(eml, transport)`, whose parse result is specified by
[email-parsing.md §3] and whose sorted-out email elements are specified by
[email-parsing.md §9], [email-parsing.md §10] and [email-parsing.md §11].

When that parse attempt throws or rejects, `process` MUST:

1. log at `error` level through `this._logger`, with message
   `An error occurred while parsing the email`, `this._logInfo`, and the caught
   error, in that order;
2. await `this._queue.notify(transport['rcpt_to'], 'in.job.parse.fail.parse',
   this._item.transport)`; and
3. return.

The parse-failure notification target is `transport['rcpt_to']`, so array-target
behavior belongs to [job-queue.md §13] and [job-queue.md §14]. For an ordinary
recipient list of address objects, the parse failure is logged, notification is
attempted and the parse job does not rethrow the parser error.

After a successful parse, `process` MUST log at `info` level through
`this._logger`, with message `--- EmailParsingJob parsed---` and
`this._logInfo`.

It MUST then iterate the parsed `emails` in order. For each sorted-out email, it
MUST enter a per-email `try` block and build a new route item:

```
{
  ...this._item,
  mail: email.mail,
  transport: email.transport,
  job: jobTypes.ROUTE
}
```

The spread runs before the three explicit keys, so the sorted-out `mail`,
sorted-out `transport` and route job type override any same-named fields from the
parse item. This route item MUST then be queued by awaiting
`this._plugin.queue.pushItem(newItem, 'mail-route')`. The queue name
`mail-route` is written by `EmailParsingJob`; `JobQueue` owns the behavior of
`pushItem` itself in [job-queue.md §11].

After queuing the route item, `process` MUST await
`this._queue.notify(email.transport.target, 'in.queue.route', {transport:
email.transport}, this._notifyOptions)`. It MUST then log at `info` level with
message `--- EmailParsingJob queued---` and `transportLogInfo(email.transport)`.

If any statement inside the per-email `try` block throws or rejects, the catch
MUST:

1. log at `error` level through `this._logger`, with the message produced by
   interpolating `transportLogInfo(this._logInfo)` into the template
   `--- EmailParsingJob error--- ${...}`, and with the caught error as the second
   log argument;
2. await `this._queue.notify(email.transport.target, 'in.queue.fail.route',
   email.transport)`; and
3. perform no explicit rethrow of the caught error. When the failure notification
   call fulfils, iteration continues with the next sorted-out email.

The error-message interpolation performs a second `transportLogInfo` call, this
time on the stored log-info object rather than on a transport object. The result
is interpolated as an object into the string; an implementation MUST NOT replace
this with a fresh call on `email.transport` or `transport`.

## 6. PostingJob

`PostingJob` MUST be the class exported by `lib/jobs/PostingJob.js`. Its
constructor signature is `constructor(item, options)`.

The constructor MUST resolve `this._logger` from `getLogger(options)` and MUST
build `this._request` from `item.request` as follows:

| Stored request field | Value |
|----------------------|-------|
| `url` | `item.request.url` |
| `method` | `item.request.method || 'post'` |
| `headers` | a shallow copy of `item.request.headers || {}` |
| `auth` | `item.request.auth` |
| `maxContentLength` | `Infinity` |
| `maxBodyLength` | `Infinity` |
| `data` | a shallow copy of `item.request.data || {}` |

The constructor MUST derive `this._logInfo` from request data before assigning
`this._request`: first read `data.transport`; when that value is falsy and
`data.content` is truthy, read `data.content.transport` instead. The resulting
value, including `undefined`, MUST be passed to `transportLogInfo`
([transport-model.md §14]).

The constructor MUST NOT mutate `item.request.headers` or `item.request.data`.
The copies are shallow: nested values remain shared.

`PostingJob.process` MUST be asynchronous and MUST run its request in one
`try`/`catch`. Before the HTTP call it MUST log at `info` level with message
`--- PostingJob requesting ---` and an object containing `url: this._request.url`
spread together with `this._logInfo`.

It MUST then await `axios(this._request)`. On fulfilment it MUST log at `info`
level with message `--- PostingJob response---` and an object containing the
response's `status` and `statusText`, `url: this._request.url`, and
`this._logInfo`.

When the request throws or rejects, the catch MUST JSON-stringify
`this._request.headers || {}` into `headersText`, log at `error` level with
message `--- PostingJob error ---` and an object carrying `url`, `headers:
headersText`, `error: err.message`, and `this._logInfo`, and then rethrow the
caught error.

## 7. ForwardingJob

`ForwardingJob` MUST be the class exported by `lib/jobs/ForwardingJob.js`. Its
constructor signature is `constructor(item, options)`.

The constructor MUST perform these assignments in order:

1. Store `getLogger(options)` as `this._logger`.
2. Store `options` as `this._options`.
3. Store `options.plugin` as `this._plugin`.
4. Store `options.srs` as `this._srs`.
5. Store `item` as `this._item`.
6. Store `item.transport.target` as `this._mailTo`.
7. Store `this._mailTo.host` as `this._targetDomain`.
8. Store `getEnvironment(this._targetDomain, this._options) || {}` as
   `this._environment`; [config-and-resolvers.md §9] owns the lookup and
   [config-and-resolvers.md §12] owns the entry fields.
9. Store `this._environment.emailDomain` as `this._emailDomain`.
10. Store `transportLogInfo(item.transport)` as `this._logInfo`.

The fallback to `{}` means a missing environment does not by itself stop
construction. In that case `this._emailDomain` is `undefined`, and that value
reaches the later `Address` construction unless a caller prevents it.

`ForwardingJob.process` MUST be asynchronous. In its `try` block it MUST read
`mailFrom` from `this._item.transport.mail_from` and `mailTo` from
`this._item.transport.target`, then log at `info` level with messages
`--- ForwardingJob start ---` and `--- ForwardingJob log mail from/to ---`; the
second log object MUST carry `mailFrom` and `mailTo`.

It MUST construct `sender` as `new Address(this._srs.rewrite(mailFrom.user,
mailFrom.host), this._emailDomain)`. It MUST then log at `info` level with
message `--- ForwardingJob got sender ---` and an object carrying `sender:
sender.original` plus `this._logInfo`.

It MUST await `send_email(this._plugin, sender.original, mailTo.original,
this._item.eml64)`. The original envelope sender value `mailFrom.original` is
not passed to `send_email`; the SRS-rewritten `sender.original` is. On fulfilment
it MUST log at `info` level with message `--- ForwardingJob done ---` and
`this._logInfo`.

If any statement in the `try` block throws or rejects, the catch MUST log at
`error` level with a message produced by interpolating `this._logInfo` directly
into `--- ForwardingJob error --- ${...}`, pass the caught error as the second
log argument, and rethrow the caught error.

## 8. CallbackJob

`CallbackJob` MUST be the class exported by `lib/jobs/CallbackJob.js`. Its
constructor signature is `constructor(item, options)`.

The constructor MUST store `getLogger(options)` as `this._logger`, `item.arg` as
`this._arg`, and `options.callback` as `this._callback`.

`CallbackJob.process` MUST be asynchronous and MUST await
`this._callback(this._arg)` inside a `try` block.

When the callback throws or rejects, the catch MUST log at `error` level with
message `--- CallbackJob error ---` and an object carrying exactly `arg:
this._arg` and `callback: this._callback`. The caught error is not included in
the logged object and is not logged as a separate argument. The catch MUST NOT
rethrow, so a callback failure is swallowed after that log call.

## 9. Plugin outbound helpers

`lib/plugin-util.js` MUST export two functions, `send_email` and `bounce_email`.
It also contains a module-private `sendEmailCallBack` helper because `send_email`
cannot be specified without the callback it passes to the plugin.

`sendEmailCallBack(plugin, resolve, reject)` MUST return a function with
signature `(code, msg)`. That returned function MUST dispatch on `code`:

| Code branch | Behavior |
|-------------|----------|
| `plugin.DENY` | reject with `new Error(\`Queueing outbound mail failed: ${msg}\`)` |
| `plugin.OK` | resolve with no value |
| any other value | reject with `new Error(\`Unrecognized return code from sending email: ${msg}\`)` |

No branch validates `msg`. The returned function returns the result of the
settlement call it takes.

`send_email(plugin, from, to, eml64, options = {})` MUST return a new promise. In
the promise executor it MUST create a `stream-buffers` `ReadableStreamBuffer`
with `frequency: 10` and `chunkSize: 64 * 1024`, put `Buffer.from(eml64,
'base64')` into it, stop it, and call:

```
plugin.outbound.send_email(
  from,
  to,
  emailStream,
  sendEmailCallBack(plugin, resolve, reject),
  options
)
```

The argument order is part of the contract. The message body reaches the plugin
as a readable stream, not as the original base64 string or as a buffer. An
omitted `options` argument reaches the plugin as `{}`.

`bounce_email(plugin, from, to, headers, eml64, dsn)` MUST build:

```
{
  notes: {
    bounce: {
      dsn,
      from,
      to,
      headers
    }
  }
}
```

It MUST then return `exports.send_email(plugin, from, to, eml64, options)` with
that object as `options`. The bounce helper does not construct a stream itself
and does not call `plugin.outbound.send_email` directly.

## 10. Notification type catalog

The library emits exactly these `in.*` type strings under `lib/`, counted by
string value:

| Type | Emitted by | Owning behavior |
|------|------------|-----------------|
| `in.job.parse.fail.parse` | `EmailParsingJob.process` | §5 |
| `in.queue.route` | `EmailParsingJob.process` | §5 |
| `in.queue.fail.route` | `EmailParsingJob.process` | §5 |
| `in.queue.post` | `RoutingJob.process` and `RoutingJob._routeWithCustomDomain` | [routing.md §4] and [routing.md §7]; cataloged here only |
| `in.queue.forward` | `RoutingJob._routeWithCustomDomain` | [routing.md §7]; cataloged here only |
| `in.queue.forward.close` | `RoutingJob._routeWithCustomDomain` | [routing.md §7]; cataloged here only |
| `in.queue.bounce` | `RoutingJob._routeWithCustomDomain` | [routing.md §7]; cataloged here only |
| `in.ignore` | `RoutingJob._routeWithCustomDomain` | [routing.md §7]; cataloged here only |
| `in.job.fail.complete` | `JobQueue` completion handling | [job-queue.md §10] |
| `in.job.fail.partial` | `JobQueue` completion handling | [job-queue.md §10] |

The three `EmailParsingJob` entries are emitted through `JobQueue.notify`; their
notification request construction, URL selection, block-list behavior and
array-target behavior are owned by [job-queue.md §13] and [job-queue.md §14].

The two job-completion entries are fail types passed to a configured fail handler
by [job-queue.md §10]. They are cataloged here with the other `in.*` strings, but
they are not notification requests unless a consumer's fail handler makes them
one.

`in.enter`, `in.queue.parse` and strings beginning with `out.` are not emitted by
any symbol under `lib/` in this version. A consumer or plugin may use such values,
but this library provides no built-in emission site for them.

Retry-relevant process outcomes are:

| Unit | Caught failure | Rethrows? |
|------|----------------|-----------|
| `EmailParsingJob.process` parse attempt | parser call or base64 conversion path | no rethrow after the parse-failure notification attempt for ordinary recipient arrays (§5) |
| `EmailParsingJob.process` per-email block | route-item queueing, route notification or queued log | no explicit rethrow; logs, attempts `in.queue.fail.route`, then continues if that notification call fulfils (§5) |
| `PostingJob.process` | HTTP request path | yes (§6) |
| `ForwardingJob.process` | forwarding path | yes (§7) |
| `CallbackJob.process` | callback invocation | no (§8) |
| `JobQueue` completion handling | completed job marked failed | owned by [job-queue.md §10] |

## 11. Tests checklist

The scenarios below cover the claims in this file that are not transcribed
literals or mechanical expansions of them: registry absence, shallow copies,
spread precedence, swallow/rethrow behavior, queue-reference differences,
notification type ownership and outbound helper argument order. There is one
subsection per technical section §2-§10, and none is empty.

### 11.1 Job type constants and item taxonomy

* The object exported as `jobTypes` has exactly the six §2 properties, in order,
  with lowercase values. `NOTIFY` exists as a constant even though §3 has no
  built-in registry entry for it.
* A parse item consumed by `EmailParsingJob` needs `transport` and `eml64`, while
  a posting item consumed by `PostingJob` needs `request`; a check that treats
  every job-class item as transport-carrying fails.
* The route item written by `EmailParsingJob` overrides `mail`, `transport` and
  `job` after spreading the parse item.

### 11.2 Built-in job-class registry

* The registry contains exactly five keys: `parse`, `route`, `post`, `forward`
  and `callback`; no `notify` key is present.
* Each built-in entry contains `JobClass` only, so the built-in `optionsField`
  passed by [job-queue.md §7] is `undefined`.
* The `route` entry maps to `RoutingJob`, but that fact alone does not make this
  file the owner of routing decision behavior.

### 11.3 EmailParsingJob construction

* The direct-notification options are computed from `item.transport.headers` and
  `this._plugin.directRoutingConfig`, and a missing parse-item transport or
  plugin fails during construction.
* `new EmailParser()` receives no argument, so the parser's own default logger
  behavior is the one [email-parsing.md §2] specifies.
* The constructor stores `item`, `plugin` and `queue` by reference rather than
  copying them.

### 11.4 EmailParsingJob process

* A parser failure logs `An error occurred while parsing the email`, attempts
  `in.job.parse.fail.parse` to `transport['rcpt_to']`, and returns without
  rethrowing the parser error for an ordinary recipient array.
* A successful parse queues one route item per sorted-out email to `mail-route`
  through `this._plugin.queue.pushItem`, not through `this._queue.pushItem`.
* The route success notification uses `this._queue.notify` and the previously
  computed direct-notification options.
* A per-email failure logs with `transportLogInfo(this._logInfo)` interpolated
  into the message, attempts `in.queue.fail.route`, and continues to later
  sorted-out emails when that notification call fulfils.

### 11.5 PostingJob

* A missing `item.request.method` defaults to `post`, while `url` and `auth` are
  passed through from `item.request`.
* Request `headers` and `data` are shallow copies. Replacing a top-level key on
  the copy does not mutate the caller's object, but nested objects remain shared.
* The log-info source is `data.transport` when truthy and `data.content.transport`
  only when the first is falsy and `data.content` exists.
* A request failure logs JSON-stringified headers and rethrows, so
  [job-queue.md §7]'s await of `process()` observes the rejection.

### 11.6 ForwardingJob

* Construction tolerates a missing environment by storing `{}`, but then
  `this._emailDomain` is `undefined` and reaches `new Address` if nothing else
  stops it.
* The sender passed to `send_email` is the SRS-rewritten `sender.original`, not
  `mailFrom.original`.
* A forwarding failure logs a message with `this._logInfo` interpolated directly
  and rethrows, so the queue processing path observes the rejection.

### 11.7 CallbackJob

* `process()` awaits `this._callback(this._arg)` exactly once.
* A callback failure logs only the stored `arg` and `callback`; the caught error
  is absent from both the object and the argument list.
* A callback failure is swallowed after logging and does not reject `process()`.

### 11.8 Plugin outbound helpers

* `send_email` base64-decodes `eml64` into a readable stream buffer configured
  with `frequency: 10` and `chunkSize: 64 * 1024`, then stops the stream before
  calling the plugin.
* The `plugin.outbound.send_email` argument order is `from`, `to`, stream,
  callback, `options`; an omitted options argument becomes `{}`.
* The callback resolves only on `plugin.OK`, rejects with the queueing message on
  `plugin.DENY`, and rejects with the unrecognized-code message for every other
  code.
* `bounce_email` wraps `dsn`, `from`, `to` and `headers` under `notes.bounce` and
  delegates to `exports.send_email` rather than duplicating the stream logic.

### 11.9 Notification type catalog

* A source sweep under `lib/` finds exactly the ten `in.*` values in §10; the
  five emitted by `RoutingJob` are catalog-only here and have behavior owned by
  [routing.md §8].
* `EmailParsingJob` emits exactly three notification types: parse failure, route
  queued, and route queue failure.
* `in.job.fail.complete` and `in.job.fail.partial` are completion fail-handler
  types from [job-queue.md §10], not built-in notification requests.
* A source sweep finds no built-in emission of `in.enter`, `in.queue.parse` or
  any `out.*` type under `lib/`.
