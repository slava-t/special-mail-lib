# Test Inbox Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the `TestInbox` class exported from `index.js` and implemented by
`lib/TestInbox.js`: construction, generated addresses, URL fields, HTTP client
calls, response extraction, group methods, waiting, generated identifiers and
derived inboxes.

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here: this file uses
**Inbox** and **Group** as that glossary defines them.

* **Test inbox**: one `TestInbox` instance, carrying an email address and HTTP
  client methods for interacting with that address.
* **Static options**: the value of `TestInbox.options` at construction time.
  When this value is falsy, it contributes no fields to the instance's merged
  options.
* **Raw construction options**: the third constructor argument after JavaScript
  applies the `options = {}` parameter default.
* **Merged options**: the object assigned to `this.options`, built by spreading
  static options first and raw construction options second.
* **Response envelope**: an HTTP response body shape whose `data` object carries
  a `success` flag and, on success, a `result` value, or on failure an
  `error.message` value.
* **Wait target**: the integer threshold passed as `count` to
  `waitForEmailCount`.
* **Cancel flag**: the instance boolean `cancelWaitingFlag`, used by
  `waitForEmailCount` and `cancelWaiting`.
* **HTTP client**: the function returned by `axios.create` and stored on the
  instance as `this.axios`.

## 1. Goals and non-goals

### 1.1 Goals

* Specify the constructor signature, option merge order, default values and
  instance fields of `TestInbox`.
* Specify which construction values come from raw construction options and which
  come from merged options.
* Specify every HTTP client call made by the public instance methods.
* Specify the response extraction, group guard, waiting and generated-identifier
  behavior owned by `TestInbox`.
* Specify the derived-inbox option flow and override order.

### 1.2 Non-goals

* The server-side API behind the URLs this class calls. This file specifies the
  client calls and the response envelope the client requires.
* Axios, `sleep-promise`, `crypto.randomBytes`, the global clock and JavaScript
  class mechanics. [overview.md §4] names the third-party dependencies; this
  file specifies only which calls `TestInbox` makes and how it uses their
  results.
* `urlJoin` internals. [utilities.md §6] owns that helper; this file specifies
  only that `getEmailsUrl()` calls it with the instance API URL and inbox-email
  path.
* Message persistence. [mail-store.md §1.1] owns stored mail behavior, and this
  file does not specify database state.

## 2. Construction and instance fields

`TestInbox` MUST be the class exported from `lib/TestInbox.js` and re-exported
from `index.js` as `TestInbox`. It MUST be constructed with:

```
new TestInbox(localName = null, name = null, options = {})
```

The constructor MUST assign `this.options` by spreading
`TestInbox.options || {}` first and raw construction options second. Raw
construction options therefore override static options in the merged options.

The constructor MUST then set `cancelWaitingFlag` to `false`.

The constructor MUST assign these fields from the raw construction options, not
from merged options:

| Field | Rule |
|-------|------|
| `mainDomain` | `options.mainDomain || 'moment.casa'` |
| `baseUrl` | `options.baseUrl || 'http://<mainDomain>:8200'` |
| `apiUrl` | `options.apiUrl || '<baseUrl>/api/v1'` |
| `group` | `TestInbox.generateGroup(options.group)` |

The constructor MUST assign `localName` to the `localName` argument when that
argument is truthy, and otherwise MUST assign `TestInbox.generateLocalName()`.
It MUST assign `name` to the `name` argument unchanged.

The raw-option boundary in this section is required behavior. Static options
for `mainDomain`, `baseUrl`, `apiUrl` and `group` MUST NOT affect those four
fields on direct construction unless the same values also appear in the raw
construction options.

The constructor MUST assign these fields from merged options:

| Field | Rule |
|-------|------|
| `emailDomain` input | `this.options.emailDomain || this.mainDomain` |
| `auth` input | `this.options.auth || {username: 'tester', password: 'tester'}` |

Static options for `emailDomain` and `auth` therefore MUST affect direct
construction when raw construction options do not override them.

When `group` is truthy, `emailDomain` MUST be `<group>.<emailDomain input>`.
When `group` is falsy, `emailDomain` MUST be the email-domain input unchanged.
`emailAddress` MUST be `<localName>@<emailDomain>`.

The constructor MUST assign the constant fields:

| Field | Value |
|-------|-------|
| `emailsUrl` | `emails` |
| `sendUrl` | `send` |

The constructor MUST assign the inbox URL fields:

| Field | Value |
|-------|-------|
| `inboxUrl` | `inboxes/<emailAddress>` |
| `inboxEmailsUrl` | `<inboxUrl>/emails` |
| `inboxEmailCountUrl` | `<inboxUrl>/count` |
| `inboxLastEmailUrl` | `<inboxUrl>/last_email` |

No URL encoding is performed by these assignments; the interpolated values are
used as string fragments.

The constructor's `options = {}` default only applies when the third argument is
omitted or is `undefined`. A `null` third argument is not converted to `{}` by
this class before raw option properties are read.

## 3. HTTP client and URL helpers

The constructor MUST assign the group URL fields as follows:

| Field | Value |
|-------|-------|
| `groupUrl` | `groups/<group>` when `group` is truthy; otherwise `apiUrl` |
| `groupEmailsUrl` | `<groupUrl>/emails` |
| `groupLastEmailUrl` | `<groupUrl>/last_email}` |

The `groupLastEmailUrl` value includes the trailing `}` character.

The constructor MUST assign `postUrl` to:

```
http://<auth.username>:<auth.password>@<mainDomain>:8200/api/v1/<inboxEmailsUrl>
```

`postUrl` MUST use `mainDomain` and port `8200` in that string. It MUST NOT be
derived from a custom `baseUrl` or `apiUrl`.

The constructor MUST call `axios.create` once and store its return value as
`this.axios`. The options object passed to `axios.create` MUST be:

| Field | Value |
|-------|-------|
| `baseURL` | `this.apiUrl` |
| `auth` | the auth object selected in §2 |
| `maxContentLength` | `Infinity` |
| `maxBodyLength` | `Infinity` |

`getEmailsUrl()` MUST have no parameters. It MUST return
`urlJoin(this.apiUrl, this.inboxEmailsUrl)`, with `urlJoin` behavior as
specified by [utilities.md §6]. It MUST NOT use the `postUrl` field.

## 4. Response extraction and inbox methods

`_extractResult(res)` MUST examine `res.status` before the response envelope.
If `res.status` is less than `200` or greater than or equal to `300`, it MUST
throw an `Error` whose message is exactly:

```
ERROR: Status code - <status>, message -'<statusText>'
```

If the status is in the 2xx range and `res.data.success` is falsy,
`_extractResult(res)` MUST throw an `Error` whose message is exactly:

```
ERROR: Success status - false, message -'<res.data.error.message>'
```

The success guard is a JavaScript falsiness check. Any falsy `success` value,
not only the boolean `false`, MUST take this error path. When the status is in
range and `res.data.success` is truthy, `_extractResult(res)` MUST return
`res.data.result` unchanged.

`send(mail)` MUST call the HTTP client with:

| Field | Value |
|-------|-------|
| `method` | `post` |
| `url` | `send` |
| `data` | an object containing `from`, then the enumerable fields of `mail` |

The initial `from` value in `send(mail)` MUST be:

| Field | Value |
|-------|-------|
| `name` | `this.name` |
| `address` | `this.emailAddress` |

Because `mail` is spread after that `from` value, a `from` field on `mail` MUST
override the generated `from` object. `send(mail)` MUST return
`_extractResult(res)` for the HTTP response.

The inbox methods MUST make these HTTP client calls and return
`_extractResult(res)`:

| Method | HTTP method | URL | Data |
|--------|-------------|-----|------|
| `save(mail)` | `post` | `this.inboxEmailsUrl` | `mail` |
| `getEmails()` | `get` | `this.inboxEmailsUrl` | none |
| `getLastEmail()` | `get` | `this.inboxLastEmailUrl` | none |
| `clear()` | `delete` | `this.inboxUrl` | none |
| `getEmail(id)` | `get` | `` `${this.emailsUrl}/${id}` `` | none |
| `deleteEmail(id)` | `delete` | `` `${this.emailsUrl}/${id}` `` | none |

The `id` argument is interpolated into the URL string for `getEmail(id)` and
`deleteEmail(id)` without validation or encoding by this class.

`getEmailCount()` MUST call the HTTP client with method `get` and URL
`this.inboxEmailCountUrl`. When that call and `_extractResult(res)` complete
without throwing, `getEmailCount()` MUST return the extracted result unchanged.
When either the HTTP client call or `_extractResult(res)` throws,
`getEmailCount()` MUST catch that error and return a one-element array
containing the caught error. It MUST NOT rethrow that caught error.

## 5. Group methods

`getGroupEmails()`, `getLastGroupEmail()` and `clearGroup()` MUST each check
`!this.group` before making an HTTP call. When that guard is true, the method
MUST throw an `Error` whose message is exactly:

```
This inbox is not attached to any group
```

When the group guard is false, the methods MUST make these HTTP client calls
and return `_extractResult(res)`:

| Method | HTTP method | URL |
|--------|-------------|-----|
| `getGroupEmails()` | `get` | `this.groupEmailsUrl` |
| `getLastGroupEmail()` | `get` | `this.groupLastEmailUrl` |
| `clearGroup()` | `delete` | `this.groupUrl` |

For `getLastGroupEmail()`, the URL therefore includes the trailing `}` in
`this.groupLastEmailUrl`.

The group guard is based on JavaScript truthiness. A raw construction option
`group` of `null`, `false`, `0` or `''` MUST be preserved by `generateGroup`
and then treated as no attached group by these methods.

## 6. Waiting and generated identifiers

`cancelWaiting()` MUST set `this.cancelWaitingFlag` to `true` and return
`undefined`.

`waitForEmailCount(count, interval = 5000, timeout = 90000, initialDelay =
2000)` MUST execute this algorithm:

1. Set `this.cancelWaitingFlag` to `false`.
2. Await `sleep(initialDelay)`.
3. Set `endTime` to `Date.now() + timeout`.
4. Create an empty `errors` array.
5. While `Date.now() < endTime` and `this.cancelWaitingFlag` is false:
   1. Await `sleep(interval)`.
   2. Await `this.getEmailCount()`.
   3. If the result is an array, append `result[0].toString()` to `errors`.
   4. Otherwise, if the result is an integer and is greater than or equal to the
      wait target, return that result.
6. Throw an `Error` whose message is exactly
   ``Time out. Errors: [<errors joined with ','>]``.

The deadline is computed after the initial sleep, so `initialDelay` is outside
the `timeout` duration. The loop sleeps before polling. A cancellation only
prevents entering a new loop iteration; if cancellation occurs after an
iteration has already passed the loop condition, that iteration still completes
its sleep and count read before the next loop condition is checked.

Only integer count results can satisfy the wait target. A non-array,
non-integer result cannot satisfy the target, even if it is numerically
comparable to `count`.

`generateGroup(group = void(0))` MUST return `'g'` plus
`crypto.randomBytes(12).toString('hex')` when `group === void(0)`. This creates
a string with prefix `g` followed by 24 hexadecimal characters when
`crypto.randomBytes(12)` returns twelve bytes. For any other value, including
falsy values such as `null`, `false`, `0` and `''`, `generateGroup` MUST return
the argument unchanged.

`generateLocalName()` MUST return `'l'` plus
`crypto.randomBytes(12).toString('hex')`. This creates a string with prefix `l`
followed by 24 hexadecimal characters when `crypto.randomBytes(12)` returns
twelve bytes.

## 7. Derived inboxes

`createDerivedInbox(localName = null, name = null, options = {})` MUST return a
new `TestInbox` constructed with:

| Constructor argument | Value |
|----------------------|-------|
| `localName` | the method's `localName` argument |
| `name` | the method's `name` argument |
| `options` | the derived raw options object defined below |

The derived raw options object MUST be built in this order:

1. Spread the parent instance's merged options, `this.options`.
2. Set `group` to the parent instance's `this.group`.
3. Spread the method's `options` argument.

The method's `options` argument therefore overrides both the parent merged
options and the parent group. If the method's `options` argument omits `group`,
the child receives the parent instance's group as a raw construction option.

Because the parent instance's merged options become raw construction options for
the child, static options that direct construction ignores for `mainDomain`,
`baseUrl`, `apiUrl` and `group` can affect a derived child when they were
present in the parent's merged options. The caller's method options still have
last precedence.

`createDerivedInbox` MUST NOT copy the parent's `localName`, `name`, HTTP
client instance, cancel flag or computed URL fields directly. Those values are
selected or recomputed by the child constructor.

## 8. Tests checklist

### 8.1 Construction

* Direct construction with static `mainDomain`, `baseUrl`, `apiUrl` and `group`
  but no corresponding raw construction options uses the defaults or generated
  group from §2, not those static values.
* Direct construction with static `emailDomain` or `auth` and no corresponding
  raw construction option uses those static values through merged options.
* Falsy raw `mainDomain`, `baseUrl` and `apiUrl` values fall back by truthiness;
  a raw `group` value is passed through `generateGroup` and only defaults when
  it is exactly `undefined`.
* `postUrl` uses `mainDomain` and port `8200`, not a custom `baseUrl` or
  `apiUrl`.

### 8.2 URL and HTTP calls

* The constructor builds every inbox and group URL field exactly as stated,
  including the trailing `}` in `groupLastEmailUrl`.
* `getEmailsUrl()` calls `urlJoin(this.apiUrl, this.inboxEmailsUrl)` and inherits
  the URL normalization behavior of [utilities.md §6].
* `send(mail)` posts to the literal URL `send` and spreads `mail` after the
  generated `from` value, so `mail.from` overrides it.
* Each inbox and group method sends the method, URL and data shape listed in
  §4 and §5.

### 8.3 Extraction and errors

* `_extractResult(res)` rejects a non-2xx status before checking `data.success`.
* `_extractResult(res)` treats every falsy `data.success` value as failure and
  uses `res.data.error.message` in the exact success-status error string.
* `getEmailCount()` returns `[err]` for either HTTP-client failures or extraction
  failures and does not throw those caught errors.
* Group methods throw the exact group-attachment error for any falsy
  `this.group`.

### 8.4 Waiting and derivation

* `waitForEmailCount` resets the cancel flag, sleeps the initial delay before
  setting the deadline, sleeps before each poll, accumulates array-form count
  errors with `toString()`, returns only an integer count at or above the target,
  and otherwise throws the exact timeout error.
* `cancelWaiting()` causes a future loop-condition check to fail, but does not
  interrupt an already-started sleep-and-poll iteration.
* Generated group and local-name values have the `g` and `l` prefixes and 24 hex
  characters when twelve random bytes are returned.
* `createDerivedInbox` uses parent merged options, then parent group, then
  caller options, and recomputes all constructor-derived fields on the child.
