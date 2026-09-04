# Routing Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers `lib/jobs/RoutingJob.js`: construction, top-level routing flow, static
route posting, dynamic environment lookup, unauthorized and bounced-message
routing, custom-domain routing, queue writes, notification calls, bounce and send
helper calls, and error behavior. `RoutingJob` is not exported directly from
`index.js`; it is reached through the built-in route entry of [jobs.md §3].

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here: this file uses
**Transport object**, **Environment**, **Route**, **Direct routing**, **Static
routing**, **Dynamic routing**, **Item** and **Guid** as that glossary defines
them. It also uses **address object**, **header map** and **log-info object** as
[transport-model.md §0] defines them, **direct routing config** as
[routing-headers.md §0] defines it, **job-options object** as [job-queue.md §0]
defines it, and **job type** and **route item** as [jobs.md §0] defines them.

* **Routing job**: an instance of `RoutingJob`, constructed for one route item
  and responsible for choosing whether that item is posted, forwarded, bounced or
  ignored.
* **Routing payload**: the shallow copy of the route item that the constructor
  stores on `_data` and then removes `job` from. It is the request data posted by
  the static, custom-domain post and bounced-message post paths.
* **Static route result**: the result of `DomainNameResolver.createUrl` whose
  `index` is at least zero, as [config-and-resolvers.md §5] builds it.
* **Dynamic environment**: the environment entry returned by `getEnvironment` for
  the route item's target domain, as [config-and-resolvers.md §9] returns it and
  [config-and-resolvers.md §12] shapes it.
* **Routing-info response**: the object returned by `fetchRoutingInfo` and read
  by `_routeWithCustomDomain`. Its routing fields are `post`, `forward` and
  `bounce`.
* **Unauthorized bounce**: the bounce produced by `_bounceUnauthorized`, using
  `DSN.sec_unauthorized('Delivery not authorized, message refused')`.
* **Bounced-message route**: the dynamic route branch selected when the target
  environment exists and the route item's sender address object has no truthy
  `user`.
* **Direct option set**: the object stored on `_directOptions`, carrying the
  route item's header map and the plugin's direct routing config for the direct
  post and notify readers.

## 1. Goals and non-goals

### 1.1 Goals

* Specify `RoutingJob` construction, including every stored field, the direct
  option set, the routing payload and the unguarded reads that can raise before
  `process()` runs.
* Specify the top-level `process()` branch order: static route, dynamic
  environment lookup, unauthorized bounce, bounced-message route and
  custom-domain routing.
* Specify every queue write made by `RoutingJob`: the item shape, queue name and
  queue helper used.
* Specify every notification type emitted by `RoutingJob`, including the
  branches that emit no notification.
* Specify the bounce, SRS reverse and outbound send calls performed by this job.
* Specify the routing-info flag interactions precisely enough that `post`,
  `forward`, `bounce` and ignore behavior can be checked independently.

### 1.2 Non-goals

* Queue mechanics, retry handling, completion handling, notification URL
  selection and blocked-notification behavior. `RoutingJob` calls queue helpers;
  [job-queue.md §11], [job-queue.md §13] and [job-queue.md §14] own what those
  helpers do.
* Job type constants, the built-in registry, `PostingJob`, `ForwardingJob` and
  outbound helper internals. This file states which job types and helpers
  `RoutingJob` uses; [jobs.md §2], [jobs.md §3], [jobs.md §6], [jobs.md §7] and
  [jobs.md §9] own their contracts.
* Direct routing header parsing. [routing-headers.md §8] and
  [routing-headers.md §9] own the direct post and notify result shapes; this file
  specifies which base requests and option sets `RoutingJob` passes to them.
* Environment lookup and routing-info HTTP behavior. [config-and-resolvers.md §9]
  owns `getEnvironment`, and [config-and-resolvers.md §11] owns
  `fetchRoutingInfo`; this file owns only the branches selected from their
  results.
* Transport, address-object, header-map and log-info construction.
  [transport-model.md §2], [transport-model.md §3], [transport-model.md §5] and
  [transport-model.md §14] are their authorities.
* The internals of `address-rfc2821` and `haraka-dsn`. [overview.md §4] names
  those dependencies; this file states only which constructors or functions
  `RoutingJob` calls.

## 2. Construction

`RoutingJob` is the class exported by `lib/jobs/RoutingJob.js` and mapped from
the route job type by [jobs.md §3]. Its constructor signature is
`constructor(item, options)`, where `item` is a route item and `options` is the
job-options object supplied by [job-queue.md §7].

The constructor MUST perform these assignments and mutations in order:

1. Store `getLogger(options)`, specified by [logging.md §3], as `_logger`.
2. Store `options` as `_options`.
3. Store `options.queue` as `_queue`.
4. Store `options.plugin` as `_plugin`.
5. Store `options.srs` as `_srs`.
6. Store `options.resolver` as `_resolver`.
7. Store `options.environmentResolver` as `_environmentResolver`.
8. Store `options.routingConfig` as `_routingConfig`.
9. Store `item` as `_item`.
10. Store `item.transport.target` as `_mailTo`.
11. Store `item.transport.mail_from` as `_mailFrom`.
12. Store `_mailTo.host` as `_targetDomain`.
13. Store a shallow copy of `item` as `_data`.
14. Store `item.transport.headers || {}` as `_headers`.
15. Store `{headers: _headers, directRoutingConfig:
    _plugin.directRoutingConfig}` as `_directOptions`.
16. Store `transportLogInfo(item.transport)`, specified by
    [transport-model.md §14], as `_logInfo`.
17. Delete `_data.job`.

No constructor input is guarded. A missing `options`, missing `item.transport`,
missing `item.transport.target`, missing `item.transport.mail_from`, or missing
`options.plugin` raises at the first property read that needs it. The constructor
does not catch those failures.

The `_data` copy is shallow. Its nested values, including `transport`, `mail`,
`eml64` and any caller-supplied nested object, are the same values reachable from
`item`. Only `_data.job` is removed, and that deletion happens after `_logInfo`
is computed. The original route item is not modified by the deletion.

`_headers` is a header map when the route item's transport carries one, and is
`{}` only when that field is falsy. `_directOptions.headers` is the same object
as `_headers`, not a copy. `_directOptions.directRoutingConfig` is read from the
plugin at construction time; later replacement of `plugin.directRoutingConfig`
does not replace the stored direct config reference.

`_environmentResolver` and `_routingConfig` are assigned and then read by no
member of `RoutingJob`, on the axis of this class body and scoped to
`lib/jobs/RoutingJob.js`. Environment lookup in §5 passes `_options` to
`getEnvironment`; it does not read these two stored fields.

## 3. Top-level processing

`process()` MUST be asynchronous and MUST return no explicit value on success.
It MUST bind `self` to `this`, and all routing work below MUST run inside one
`try` block whose `catch` is specified at the end of this section.

Before choosing a branch, `process()` MUST log at `info` level through `_logger`
with message `--- RoutingJob start--- ` and `_logInfo` as the second argument.

It MUST then call `_resolver.createUrl(_targetDomain)`. This is an unguarded
read and call: a missing resolver, missing method or thrown resolver error is
caught by this method's `catch`, logged and rethrown.

When the resolver result is truthy and its `index` is at least zero, `process()`
MUST run the static route branch of §4 and then return. A resolver result whose
`index` is `-1` therefore does not count as static, even if it carries URL
fields.

Only after the static branch is missed, `process()` MUST log at `info` level
with message `--- RoutingJob dynamic routing start ---` and `_logInfo`, then
resolve a dynamic environment as §5 specifies.

When no environment is found, `process()` MUST log
`--- RoutingJob dynamic bounce: unauthorized ---`, await `_bounceUnauthorized()`,
and return. It MUST NOT notify for this branch.

When an environment exists but `_mailFrom.user` is falsy, `process()` MUST log
`--- RoutingJob dynamic bounce: no user ---`, await
`_routeBouncedEmail(environment)`, and return.

Only when none of the preceding branches returned, `process()` MUST await
`_routeWithCustomDomain(environment)`.

The `catch` MUST log at `error` level through `_logger`, with the message formed
by interpolating `_logInfo` directly into
`--- RoutingJob error --- ${_logInfo}`, and with the caught error as the second
argument. It MUST then rethrow the caught error. When `_logInfo` is an object,
the message interpolation produces JavaScript's object string for it; the catch
MUST NOT replace this with a fresh `transportLogInfo` call or with a structured
log object.

## 4. Static route posting

The static route branch MUST begin by logging at `info` level with message
`--- RoutingJob static routing start ---` and `_logInfo`.

It MUST then build a base posting request with exactly these fields:

| Field | Value |
|-------|-------|
| `url` | the static route result's `url` |
| `method` | `post` |
| `headers` | the static route result's `headers` |
| `data` | `_data` |

That base request MUST be passed as the first argument to
`getDirectPostRequestRouting`, with `_directOptions` as the second argument. The
returned request is the posting request for this branch. Direct post header
overrides and config defaults are therefore those of [routing-headers.md §8].

`process()` MUST then await:

```
_queue.pushTrackedItem({
  job: jobTypes.POST,
  request
}, hashQueueName('mail-post-', res.url))
```

The queued item has exactly `job` and `request` at construction time, with
`jobTypes.POST` as the job type. The queue name is `hashQueueName` from
[utilities.md §5] applied to base `mail-post-` and the static route result's
`url`. The queue shard is based on `res.url`, not on `request.url`; if direct
post routing changed the request URL, the queue name remains derived from the
static route result URL.

After the tracked post item is accepted, `process()` MUST await `_queue.notify`
with these arguments:

| Position | Value |
|----------|-------|
| target | `_targetDomain` |
| type | `in.queue.post` |
| content | `{transport: _item.transport}` |
| options | `getDirectNotifyRequestRouting(_directOptions)` |

The direct notify options are recomputed at the notification call. They are not
read from a stored notify-options field.

After the notification call fulfils, `process()` MUST log at `info` level with
message `--- RoutingJob static routing queued for posting ---` and an object
formed from `{url: request.url}` followed by `_logInfo` spread into it. It MUST
then return and MUST NOT enter any dynamic branch.

## 5. Dynamic environment and unauthorized bounce

The dynamic branch MUST obtain the environment by calling
`getEnvironment(_targetDomain, _options)`, whose lookup is specified by
[config-and-resolvers.md §9]. It does not call `getEnvironment` with the stored
`_environmentResolver` or `_routingConfig` fields.

When that call returns a falsy value, the job MUST run the unauthorized-bounce
path: log the branch as §3 states, await `_bounceUnauthorized()`, and return.
No queue item is written and no notification is emitted by this branch.

`_bounce(dsn)` MUST return the result of calling `bounce_email`, specified by
[jobs.md §9], with these arguments in order:

| Position | Value |
|----------|-------|
| plugin | `_plugin` |
| from | `_mailFrom.original` |
| to | `_mailTo.original` |
| headers | `_headers` |
| eml64 | `_item.eml64` |
| dsn | `dsn` |

`_bounce` does not await the helper itself; its caller receives the returned
promise or value.

`_bounceUnauthorized()` MUST return `_bounce(DSN.sec_unauthorized('Delivery not
authorized, message refused'))`. The DSN message string is exact. The DSN object
is constructed by `haraka-dsn`; this spec owns only the call and the message.

Any throw or rejection from the unauthorized-bounce path reaches `process()`'s
catch, which logs and rethrows as §3 specifies.

## 6. Bounced-message routing

The bounced-message route is selected only after an environment exists and
`_mailFrom.user` is falsy. It is implemented by `_routeBouncedEmail(environment)`,
which MUST be asynchronous.

The method MUST initialize `srsReverseValue` to `null`, then attempt
`_srs.reverse(_mailTo.user)` inside a `try` block. If that call throws, the catch
MUST log at `error` level with the caught error as the first argument and
`_logInfo` as the second, swallow the error, and continue with
`srsReverseValue` still falsy.

When `srsReverseValue` is truthy, `_routeBouncedEmail` MUST await `send_email`,
specified by [jobs.md §9], with these arguments in order:

| Position | Value |
|----------|-------|
| plugin | `_plugin` |
| from | `_mailFrom` |
| to | `new Address(srsReverseValue[0], srsReverseValue[1])` |
| eml64 | `_item.eml64` |

No fifth `options` argument is supplied, so [jobs.md §9]'s default `{}` reaches
the outbound helper. The `from` argument is the sender address object itself, not
`_mailFrom.original`; the `to` argument is an `address-rfc2821` `Address`
instance, not its `original` string.

After the SRS branch is skipped or completes, `_routeBouncedEmail` MUST build
`url` as `urlJoin(environment.baseUrl, environment.emailPostUri)`, where
`urlJoin` is specified by [utilities.md §6] and the environment fields are
specified by [config-and-resolvers.md §12]. It MUST read `headers` from
`environment.emailPostHeaders`.

It MUST then await:

```
_queue.pushTrackedItem({
  job: jobTypes.POST,
  request: {
    method: 'post',
    url,
    headers,
    data: _data
  }
}, hashQueueName('mail-post-', url))
```

This tracked post write is not guarded on SRS success or on the presence of a
reverse value. It runs after the optional send path completes, unless a thrown or
rejected `send_email` call has already escaped. This branch MUST NOT call
`getDirectPostRequestRouting`, MUST NOT call `getDirectNotifyRequestRouting`, and
MUST NOT emit a notification.

## 7. Custom-domain routing

`_fetchRoutingInfo(environment)` MUST be asynchronous, MUST await
`fetchRoutingInfo(environment, _item.transport)`, and MUST return that result
unchanged. `fetchRoutingInfo` itself is specified by [config-and-resolvers.md §11].

`_routeWithCustomDomain(environment)` MUST be asynchronous. It MUST begin by
logging at `info` level with message
`--- RoutingJob route with custom domain start ---` and an object formed by
spreading `_logInfo`.

It MUST then await `_fetchRoutingInfo(environment)`, store the result as
`routingInfo`, and log at `info` level with message
`--- RoutingJob dynamic routing ---` and an object formed from `{routingInfo}`
followed by `_logInfo` spread into it.

The method MUST initialize local `ignore` to `true`, then evaluate the
`routingInfo` fields in this order: `post`, then `forward`, then `bounce`, then
the ignore fallback.

### 7.1 Post branch

When `routingInfo.post` is truthy, `_routeWithCustomDomain` MUST set `ignore` to
`false`, build `url` as `urlJoin(environment.baseUrl,
environment.emailPostUri)`, read `headers` from `environment.emailPostHeaders`,
and pass this base request to `getDirectPostRequestRouting` with `_directOptions`
as the second argument:

| Field | Value |
|-------|-------|
| `method` | `post` |
| `url` | the joined environment post URL |
| `headers` | `environment.emailPostHeaders` |
| `data` | `_data` |

It MUST then await `_queue.pushTrackedItem({job: jobTypes.POST, request},
hashQueueName('mail-post-', url))`. The queue shard is based on the joined
environment post URL, not on `request.url`; if direct post routing changed the
request URL, the queue name remains derived from the environment URL.

After the tracked post item is accepted, the method MUST await `_queue.notify`
with target `_targetDomain`, type `in.queue.post`, content
`{transport: _item.transport}`, and options
`getDirectNotifyRequestRouting(_directOptions)`. The direct notify options are
recomputed at this call.

It MUST then log at `info` level with message
`--- RoutingJob dynamic routing queued for posting ---` and an object formed from
`{url: request.url}` followed by `_logInfo` spread into it.

### 7.2 Forward branch

When `routingInfo.forward` is truthy, `_routeWithCustomDomain` MUST set `ignore`
to `false` and await `_queue.pushItem({..._item, job: jobTypes.FORWARD},
'mail-forward')`.

The forwarding item is a shallow copy of `_item` with `job` overlaid after the
spread, so the job type is `jobTypes.FORWARD` even when the route item carried
another `job` value. The queue name is the literal `mail-forward`.

The notification type MUST be `in.queue.forward` when `routingInfo.post` is
truthy, and `in.queue.forward.close` otherwise. The method MUST then await
`_queue.notify(_targetDomain, forwardingType, {transport: _item.transport},
getDirectNotifyRequestRouting(_directOptions))`, recomputing direct notify
options at the call.

After that notification fulfils, the method MUST log at `info` level with
message `--- RoutingJob dynamic routing queued for forwarding ---` and `_logInfo`.

### 7.3 Bounce branch

When neither `routingInfo.post` nor `routingInfo.forward` is truthy and
`routingInfo.bounce` is truthy, `_routeWithCustomDomain` MUST set `ignore` to
`false`, log at `info` level with message
`--- RoutingJob dynamic routing start bouncing ---` and `_logInfo`, await
`_bounceUnauthorized()`, and then await `_queue.notify(_targetDomain,
'in.queue.bounce', {transport: _item.transport},
getDirectNotifyRequestRouting(_directOptions))`.

The bounce branch is therefore suppressed whenever `post` or `forward` is
truthy, even if `bounce` is also truthy.

### 7.4 Ignore fallback

When `ignore` remains true after the post, forward and bounce checks,
`_routeWithCustomDomain` MUST log at `info` level with message
`--- RoutingJob dynamic routing ignoring ---` and `_logInfo`, then await
`_queue.notify(_targetDomain, 'in.ignore', {transport: _item.transport},
getDirectNotifyRequestRouting(_directOptions))`.

The fallback is controlled by the local `ignore` variable, not by rechecking the
raw routing-info response at the end.

### 7.5 Flag interaction table

The three routing-info flags MUST interact as follows, using JavaScript
truthiness for each field:

| `post` | `forward` | `bounce` | Required actions |
|--------|-----------|----------|------------------|
| truthy | truthy | any | post branch and forward branch; forward notification type `in.queue.forward`; no bounce; no ignore |
| truthy | falsy | any | post branch only; no bounce; no ignore |
| falsy | truthy | any | forward branch only; forward notification type `in.queue.forward.close`; no bounce; no ignore |
| falsy | falsy | truthy | unauthorized bounce and `in.queue.bounce` notification; no ignore |
| falsy | falsy | falsy | `in.ignore` notification only |

The post and forward checks are independent `if` statements, so both branches run
when both flags are truthy. The bounce check is guarded by the absence of both
post and forward. The ignore fallback runs only when none of the preceding
branches changed `ignore` to `false`.

Any throw or rejection in `_routeWithCustomDomain`, including failures from
fetching routing info, URL joining, queue writes, bounce, notification or
logging-adjacent object construction, is not caught there and reaches
`process()`'s catch.

## 8. Queue names and notifications

`RoutingJob` writes two queue-name families:

| Queue name | Written by | Item shape |
|------------|------------|------------|
| `hashQueueName('mail-post-', res.url)` | static route branch (§4) | `{job: jobTypes.POST, request}` via `pushTrackedItem` |
| `hashQueueName('mail-post-', url)` | bounced-message route (§6) and custom-domain post branch (§7.1) | `{job: jobTypes.POST, request}` via `pushTrackedItem` |
| `mail-forward` | custom-domain forward branch (§7.2) | `{..._item, job: jobTypes.FORWARD}` via `pushItem` |

The `mail-post-` names are sharded by [utilities.md §5]. `mail-route` is written
by `EmailParsingJob` and belongs to [jobs.md §5]. `mail-notify` is written by
`JobQueue.notify` and belongs to [job-queue.md §13].

`RoutingJob` emits exactly five notification types, all through `_queue.notify`:

| Type | Emitted by | Target | Content | Options |
|------|------------|--------|---------|---------|
| `in.queue.post` | static route branch (§4) and custom-domain post branch (§7.1) | `_targetDomain` | `{transport: _item.transport}` | `getDirectNotifyRequestRouting(_directOptions)` |
| `in.queue.forward` | custom-domain forward branch when `routingInfo.post` is truthy (§7.2) | `_targetDomain` | `{transport: _item.transport}` | `getDirectNotifyRequestRouting(_directOptions)` |
| `in.queue.forward.close` | custom-domain forward branch when `routingInfo.post` is falsy (§7.2) | `_targetDomain` | `{transport: _item.transport}` | `getDirectNotifyRequestRouting(_directOptions)` |
| `in.queue.bounce` | custom-domain bounce branch (§7.3) | `_targetDomain` | `{transport: _item.transport}` | `getDirectNotifyRequestRouting(_directOptions)` |
| `in.ignore` | custom-domain ignore fallback (§7.4) | `_targetDomain` | `{transport: _item.transport}` | `getDirectNotifyRequestRouting(_directOptions)` |

The direct notify reader is called separately for each notification. A failure in
that reader prevents the notification call from being made and reaches
`process()`'s catch.

The dynamic no-environment unauthorized-bounce branch (§5) and the
bounced-message route (§6) emit no notification. This is a routing-job behavior,
not a `JobQueue.notify` rule.

## 9. Tests checklist

### 9.1 Construction

* Constructing `RoutingJob` stores the fields of §2 in order, creates `_data` as
  a shallow copy, deletes `_data.job`, and leaves the original item unchanged.
* `_mailTo` is `item.transport.target`, `_mailFrom` is
  `item.transport.mail_from`, and `_targetDomain` is `_mailTo.host`. This catches
  a description that resolves the target domain from recipients or from a named
  route destination.
* `_directOptions.headers` is the same object as `_headers`, and
  `_directOptions.directRoutingConfig` is read from `_plugin.directRoutingConfig`
  during construction.
* `_environmentResolver` and `_routingConfig` are assigned but read by no member
  of `RoutingJob`; environment lookup passes `_options` to `getEnvironment`.

### 9.2 Top-level processing

* A resolver result with `index >= 0` takes the static route branch and returns
  before dynamic routing starts.
* A resolver result with `index: -1`, or no resolver result, starts dynamic
  routing rather than being treated as static.
* Dynamic routing checks no environment before it checks for an empty sender
  user, so a missing environment bounces unauthorized even when `_mailFrom.user`
  is falsy.
* Any error caught by `process()` is logged with `_logInfo` interpolated into the
  message and is rethrown.

### 9.3 Static route posting

* The static post request starts from `res.url`, `post`, `res.headers` and
  `_data`, then passes through `getDirectPostRequestRouting` with `_directOptions`.
* The static post queue name is `hashQueueName('mail-post-', res.url)`, even
  when the direct post reader changes `request.url`.
* The static success notification uses type `in.queue.post`, target
  `_targetDomain`, content `{transport: _item.transport}` and freshly computed
  direct notify options.

### 9.4 Unauthorized bounce

* A missing dynamic environment calls `_bounceUnauthorized()`, returns and emits
  no notification.
* `_bounce` passes `_plugin`, `_mailFrom.original`, `_mailTo.original`,
  `_headers`, `_item.eml64` and the DSN object to `bounce_email` in that order.
* `_bounceUnauthorized` constructs its DSN with the exact message `Delivery not
  authorized, message refused`.

### 9.5 Bounced-message routing

* An SRS reverse throw is logged with the error as the first argument and
  `_logInfo` second, then swallowed.
* A truthy SRS reverse value sends mail with `_mailFrom` as the `from` argument
  and a new `Address` instance as the `to` argument, not their string
  projections.
* The bounced-message route writes a tracked post item to
  `hashQueueName('mail-post-', url)` after building `url` from the environment
  post fields, without calling the direct post reader and without notifying.

### 9.6 Custom-domain routing

* `_fetchRoutingInfo` delegates to `fetchRoutingInfo(environment,
  _item.transport)` and returns its response unchanged.
* When both `routingInfo.post` and `routingInfo.forward` are truthy, both queue
  writes happen, the forward notification type is `in.queue.forward`, and
  `routingInfo.bounce` is ignored.
* When only `routingInfo.forward` is truthy, the forwarding item is
  `{..._item, job: jobTypes.FORWARD}`, the queue name is `mail-forward`, and the
  notification type is `in.queue.forward.close`.
* When neither post nor forward is truthy and bounce is truthy, the job performs
  the unauthorized bounce and emits `in.queue.bounce`.
* When none of post, forward or bounce acts, the job emits `in.ignore`.
* The custom-domain post queue name is based on the joined environment URL, not
  on a direct post override that changes `request.url`.

### 9.7 Queue names and notifications

* A source sweep under `lib/jobs/RoutingJob.js` finds the two queue-name families
  of §8 and no other queue name written by the class.
* A source sweep under `lib/jobs/RoutingJob.js` finds exactly the five `in.*`
  notification type strings in §8, each emitted through `_queue.notify`.
* The dynamic no-environment unauthorized-bounce branch and bounced-message
  route emit no notification.
