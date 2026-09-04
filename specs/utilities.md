# Utilities Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the general-purpose helpers exported from `index.js` through the spread
of `lib/util.js`: end-of-line normalization, the express request helpers, random
string generation, hashing, URL joining, DNS resolution, promise settling,
stream conversion, email file persistence and inbox cleanup. The seventeen
symbols specified here are exactly the `lib/util.js` rows whose home spec is
this file in [overview.md §3]; every other symbol in that module belongs to
another spec and is out of scope (§1.2).

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here — §11 uses
**Inbox** as that glossary defines it, and §10 uses **Transport object** the
same way.

* **Nonce**: the module-level counter `lib/util.js` keeps for `saveEmail`. It
  starts at zero when the module is first required, is incremented before use by
  every call that reaches the base filename (§10), and is never reset for the
  lifetime of the loaded module instance.
* **Settled result**: the object `allPromises` resolves with in place of an
  original promise's outcome — `{status: 'fulfilled', value}` for a fulfilment
  and `{status: 'rejected', reason}` for a rejection.
* **Queue-name shard**: the single hexadecimal character `hashQueueName` appends
  to a base queue name, derived from an index. There are sixteen of them.
* **Domain hash key**: the short lowercase hexadecimal string `getDomainHashKey`
  derives from a domain name, used to name a per-domain directory.
* **EOL normalization**: the conversion `normalizeEOLs` performs, rewriting the
  line endings of a string to CRLF and deciding what becomes of a carriage
  return that is not part of one.
* **Stream buffer**: a `stream-buffers` writable or readable stream that holds
  its payload in memory, used by §9 to convert between streams and buffers.

## 1. Goals and non-goals

### 1.1 Goals

* Specify the signature, parameter defaults, return value, error behavior and
  side effects of each of the seventeen helpers this file owns.
* State the algorithms that cannot be inferred from those signatures — the
  normalization pipeline of §2, the hashing pipelines of §5, the settle latch of
  §7 and the file layout of §10 — precisely enough that compliance can be
  determined from this spec alone.

### 1.2 Non-goals

* `tests/` and `docker/`, consistent with [overview.md §1.2].
* The internals of the Node core modules these helpers call — `crypto`, `fs`,
  `path` and `dns`, and the global `URL` constructor `urlJoin` uses. Their
  contracts are Node's. This spec states only which of their calls each helper
  makes and with what arguments.
* The internals of `stream-buffers`, beyond the four option values §9
  transcribes and the fact that a stream buffer accumulates in memory. It is a
  third-party contract; the dependency is named in [overview.md §4].
* The transport object's own contract. §10 describes only the two fields
  `saveEmail` reads; [transport-model.md §2] owns the rest.
* The `inbox` object's contract beyond the `clear()` method `clearInboxes`
  calls. `test-inbox.md` owns it.
* The express `req`, `res` and `next` contract. §3 specifies only which methods
  these three helpers call and with what arguments.
* The other symbols exported from `lib/util.js`. [overview.md §3] routes each of
  them to one of four other specs, and the spec that row names is the sole
  authority for that symbol.

## 2. End-of-line normalization

`normalizeEOLs` MUST have the signature `normalizeEOLs(str, keepSingleCR =
true)`.

`normalizeEOLs` MUST return `str` unchanged, without inspecting it further, when
`str` is falsy or is not of type `string`. This applies to the empty string,
`0`, `null`, `undefined`, and to any non-string value including buffers and
objects: the guard is `str && typeof str === 'string'`, so a non-string is
returned as it arrived rather than converted.

Otherwise `normalizeEOLs` MUST apply these three replacements to `str`, in this
order, and MUST return the result:

1. Every CRLF pair and every bare LF becomes a single LF.
2. Every remaining CR — that is, every CR that was not part of a CRLF pair —
   becomes LF when `keepSingleCR` is truthy, and is deleted when it is falsy.
3. Every LF becomes CRLF.

The net effect is that all line endings become CRLF. A lone CR therefore becomes
a line break of its own under the default `keepSingleCR = true`, and vanishes
without leaving a break when `keepSingleCR` is false. The order matters: step 1
collapses CRLF before step 2 can see it, so an existing CRLF is never widened.

`normalizeEOLs` MUST NOT modify its argument in place and MUST NOT throw for any
input.

## 3. Express helpers

These three helpers adapt library code to express middleware conventions. Each
takes the express values as given and calls only the methods named below.

`asyncWrapper` MUST have the signature `asyncWrapper(func)` and MUST return a
new function of the express middleware shape `(req, res, next)`. Calling that
returned function MUST invoke `func(req, res, next)`, wrap the value it returns
with `Promise.resolve`, and attach `next` as the rejection handler, so that a
rejected promise is forwarded to express's error path. The returned wrapper MUST
NOT return the promise it creates, and MUST NOT alter a fulfilment value: a
successful call resolves and nothing further happens.

`errorHandler` MUST have the signature `errorHandler(err, req, res, next)` — the
four-argument form express recognizes as error-handling middleware.

`errorHandler` MUST first test `res.headersSent`. When it is true, `errorHandler`
MUST forward the error by returning `next(err)` and MUST NOT write anything to
the response. Only when it is false MUST `errorHandler` set the response status
to 500 and send this body:

| Field | Value |
|-------|-------|
| `success` | `false` |
| `error.name` | `err.name` |
| `error.message` | `err.message` |
| `error.text` | `err.toString()` |
| `error.stack` | `err.stack` |

The four `error` fields are read from the argument as given. `errorHandler` MUST
NOT consult the error catalog of `errors.md`, and the body above is not the
error object that spec defines: a value created by `createError` reaches
`errorHandler` only as an ordinary argument, and is rendered by these same four
property reads.

`ok` MUST have the signature `ok(res, result)` and MUST set the response status
to 200 and send the body `{success: true, result}`, where `result` is the
argument as given. `ok` MUST NOT wrap, copy or serialize `result` itself.

## 4. Random string generation

`randomHexString` MUST have the signature `randomHexString(len)`. `len` has no
default: a call without it MUST NOT be treated as valid by this spec.

`randomHexString` MUST draw `len` random bytes from `crypto.randomBytes`, encode
them as hexadecimal — which yields `2 × len` characters — and return the first
`len` characters of that encoding. The returned string is therefore `len`
characters long and carries the entropy of `len / 2` bytes; the remaining half
of the encoding is discarded.

`randomAlphanumeric` MUST have the signature `randomAlphanumeric(len = 24,
randomFunc = crypto.randomBytes)`. The second parameter exists so a caller can
supply a deterministic byte source; it MUST be called as `randomFunc(len)` and
its result MUST be treated as a buffer.

`randomAlphanumeric` MUST compute a candidate by encoding those bytes as base64,
removing every `/` and `+` character from the encoding, and taking the first
`len` characters of what remains. Only `/` and `+` are removed; base64 padding
is not stripped separately. If the candidate is exactly `len` characters long,
`randomAlphanumeric` MUST return it. Otherwise it MUST call itself again with
the same `len` and the same `randomFunc`, drawing fresh bytes — it MUST NOT pad
the short candidate, and MUST NOT retry the filter over the bytes it already
drew.

## 5. Hashing

`hashQueueName` MUST have the signature `hashQueueName(base, index)` and MUST
return `base` concatenated with a queue-name shard. The shard MUST be computed
by taking the md5 digest of `index.toString()` in hexadecimal and indexing the
**first character** of that hexadecimal string.

Because the index is applied to the hex string rather than to the digest bytes,
the shard is one hexadecimal character and there are exactly **sixteen** distinct
shards. `index` is converted with `toString()`, so numeric and string indices
that render identically MUST produce the same shard.

`getDomainHashKey` MUST have the signature `getDomainHashKey(domain, len = 2)`
and MUST derive a domain hash key by applying these steps in order:

1. Lowercase `domain`.
2. Replace every `.` with a single space.
3. Trim leading and trailing whitespace from the result.
4. Take the sha256 digest of that normalized string in hexadecimal.
5. Return the first `len` characters of the digest, lowercased.

The dot-to-space substitution in step 2 is part of the hashed input, not
cosmetic: two domains that differ only in their dots hash differently, and any
implementation that hashes the domain without it produces different keys. Step
5's lowercasing is applied to hexadecimal digest output that is already
lowercase, so it changes nothing.

## 6. URL joining

`urlJoin` MUST have the signature `urlJoin(base, uri)`.

`urlJoin` MUST parse `base` with the global `URL` constructor, rebuild an origin
from that URL's protocol and host alone, join the URL's pathname with `uri` using
`path.join`, resolve the joined path against the rebuilt origin, and return the
resulting URL's `href`.

Three consequences MUST hold:

* Because the origin is rebuilt from protocol and host only, any **query
  string**, **fragment** or **userinfo** carried on `base` is discarded. The host
  component carries host and port, so a non-default port survives.
* Because the paths are joined with `path.join`, the result is normalized as a
  filesystem-style path: a `uri` containing `..` segments removes preceding
  segments of `base`'s pathname rather than appearing literally, and duplicate
  separators are collapsed.
* The return value is a normalized absolute URL string produced by the `URL`
  constructor, not a concatenation of its inputs.

`urlJoin` MUST NOT catch parse failures: an invalid `base` propagates the `URL`
constructor's own error to the caller.

## 7. DNS resolution

`dnsResolve` MUST have the signature `dnsResolve(hostname, recordType, timeout =
20000)` and MUST return a promise.

Each call MUST create its own `dns.Resolver` instance and MUST NOT use the module
level resolver or share one between calls. It MUST then start a timer of
`timeout` milliseconds and issue `resolve(hostname, recordType, callback)` on
that resolver.

The promise MUST settle exactly once. A single latch guards both paths:

1. **Timeout path.** When the timer fires, it clears its own handle, and — only
   if the promise has not already settled — marks it settled, rejects with an
   `Error` whose message is exactly `The dns resolve request timed out`, and then
   calls `cancel()` on the resolver.
2. **Resolver path.** When the resolver callback runs, it clears the timer if the
   timer has not already fired, and — only if the promise has not already
   settled — marks it settled and either rejects with the resolver's error or
   resolves with its records.

A resolver callback that arrives after the timeout has fired MUST therefore be
discarded: the timer's rejection stands, and neither the error nor the records
from that late callback reach the caller. Conversely, a timer that fires after
the resolver has settled the promise MUST have no effect.

`dnsResolve` MUST NOT retry, MUST NOT set custom name servers, and MUST NOT
inspect or transform the records: they are passed to the caller exactly as the
resolver produced them.

## 8. Promise settling

`allPromises` MUST have the signature `allPromises(promises)` and MUST return a
new array of the same length, in the same order, with one promise per input
promise.

Each returned promise MUST fulfil with a settled result and MUST NOT reject:

| Outcome of the input promise | Settled result |
|------------------------------|----------------|
| fulfils with `value` | `{status: 'fulfilled', value}` |
| rejects with `err` | `{status: 'rejected', reason: err}` |

The status strings are exactly `'fulfilled'` and `'rejected'`.

This never-rejects property is the point of the helper: passing the returned
array to `Promise.all` MUST behave as passing the original array to
`Promise.allSettled`, which is what the function exists to stand in for.
`allPromises` MUST NOT modify the input array and MUST NOT settle any input
promise itself.

## 9. Stream conversion

`copyStream` MUST have the signature `copyStream(source, dest)` and MUST return a
promise that:

* resolves, with no value, when `dest` emits `finish`;
* rejects with the emitted error when `dest` emits `error`;
* rejects with the emitted error when `source` emits `error`.

All three listeners MUST be attached before `copyStream` pipes `source` into
`dest`. Completion is keyed on `dest` finishing, not on `source` ending.

`streamToBuffer` MUST have the signature `streamToBuffer(source)`, MUST be
asynchronous, and MUST create a `stream-buffers` writable stream buffer with
`initialSize` and `incrementAmount` both set to 64 KiB (`64 * 1024`). It MUST
copy `source` into that stream buffer with `copyStream`, await the copy, and
return the stream buffer's contents as produced by its `getContents()` method.
The value that method returns for an empty stream is `stream-buffers`' contract
(§1.2), and `streamToBuffer` returns it unchanged.

`streamToBase64` MUST have the signature `streamToBase64(source)`, MUST be
asynchronous, and MUST return the base64 encoding of the value `streamToBuffer`
returns for the same `source`.

`bufferToStream` MUST have the signature `bufferToStream(buffer, dest)`, MUST be
asynchronous, and MUST create a `stream-buffers` readable stream buffer with
`frequency` set to `10` and `chunkSize` set to 64 KiB (`64 * 1024`).

`bufferToStream` MUST then perform these steps in this order:

1. Start copying the stream buffer into `dest` with `copyStream`, retaining the
   promise without awaiting it yet.
2. Put `buffer` into the stream buffer.
3. Stop the stream buffer, so that it ends once its contents are drained.
4. Await the copy promise from step 1.

The order is required: the copy is started before data is put so the consumer is
attached before the stream flows, and the stream is stopped so that `dest`
reaches `finish` and the awaited promise resolves. `bufferToStream` MUST resolve
with no value, and a failure on either stream MUST reach the caller as the
rejection of the awaited copy promise.

## 10. Email file persistence

`saveEmail` MUST have the signature `saveEmail(baseDir, eml, transport, moreData
= {})`, MUST be synchronous, and MUST return nothing.

`transport` is a transport object as [overview.md §0] defines the term;
[transport-model.md §2] is the authority on its contract, and this section
specifies only the two fields `saveEmail` reads. Structurally, it requires
`transport.rcpt_to` to be an array whose elements each expose a `host`, and
`transport.mail_from` to be an object exposing a `host`.

This `saveEmail` is the function `lib/util.js` exports, which [overview.md §3]
routes to this file. `lib/MailStore.js` defines an unrelated method of the same
name, specified by `mail-store.md`; nothing in this section applies to it.

`saveEmail` MUST compute the target directory as the path join of, in this
order:

1. `baseDir` as given.
2. The date segment: the first ten characters of the current time in ISO 8601
   form, that is `YYYY-MM-DD`.
3. The from segment: `transport.mail_from.host`, or the literal `bounced` when
   that value is falsy.
4. The to segment: the `host` of each element of `transport.rcpt_to`, joined
   with `_`, or the literal `invalid` when that join produces an empty string.

The from segment precedes the to segment. The `bounced` and `invalid`
substitutions are not interchangeable: `bounced` stands in for an absent sender
host, `invalid` for an empty joined recipient list.

`saveEmail` MUST create that directory recursively, so that missing ancestors are
created and an existing directory is not an error.

The base filename MUST be the remainder of the same ISO 8601 timestamp after the
date and the `T` separator — that is `HH:MM:SS.sssZ` — with every `:` replaced by
`_`, followed by `-` and the nonce. The nonce MUST be incremented before it is
used, so the first save performed by a loaded module instance uses `1`, and MUST
continue to increase across calls for the lifetime of that instance (§0). Both
files written below share this base filename.

`saveEmail` MUST always write `<base filename>.json` into the target directory,
containing the JSON serialization of an object built by spreading `moreData`
first and then setting `transport`, indented with two spaces. Because `moreData`
spreads first, a `transport` key supplied in `moreData` is overwritten by the
`transport` argument rather than merged with it. `moreData` defaults to `{}`, so
a call that omits it writes an object carrying `transport` alone.

`saveEmail` MUST write `<base filename>.eml` containing `eml` as given **only
when `eml` is truthy**. A falsy `eml` MUST leave no `.eml` file: the `.json` is
unconditional and the `.eml` is not, so the two are not a pair.

Every step above MUST run inside one try block. Any throw from it — a failure to
create the directory, to serialize, or to write either file, and equally a
missing `rcpt_to` or `mail_from` — MUST be caught, logged at `error` level
through the module-level logger of [logging.md §2] with the message `Fail to
save email.` and the caught error, and then swallowed. `saveEmail` MUST NOT
rethrow and MUST NOT report failure to its caller by any other means; a
partially written save, such as a `.json` written before an `.eml` write fails,
is left as it is.

## 11. Inbox cleanup

`clearInboxes` MUST have the signature `clearInboxes(inboxes)`, MUST be
asynchronous, and takes an array of inboxes as [overview.md §0] defines the
term. Only the `clear()` method is used here; `test-inbox.md` owns the rest of
the contract (§1.2).

`clearInboxes` MUST loop while the array is non-empty, and on each iteration MUST
remove the last element with `pop` and await its `clear()`. The caller's array is
therefore **emptied in place**: after the call it has length zero, and a second
call with the same array is a no-op. Inboxes are cleared in reverse order.

Each `clear()` rejection MUST be caught and logged at `error` level through the
module-level logger of [logging.md §2], with the caught error as the only
argument, and the loop MUST continue to the next inbox. One failing inbox
therefore MUST NOT prevent the others from being cleared.

`clearInboxes` maintains an error counter that is initialized to zero and never
incremented. The final branch guarded by that counter — which would reset it and
throw an `Error` with the message `There are errors during inboxes cleanup.` —
is therefore never entered, and `clearInboxes` never throws that error. A
rejection from `inbox.clear()` is logged and does not reach the caller, so the
returned promise fulfils whenever the loop completes.

## 12. Tests checklist

The scenarios below cover the claims in this file that are not transcribed
literals or mechanical expansions of them: the ordered pipelines, the guards,
the latches and the file layout, each stated so that a plausible-sounding but
wrong description fails it.

### 12.1 End-of-line normalization

* A string mixing CRLF, bare LF and lone CR normalizes to CRLF throughout under
  the default `keepSingleCR = true`, and the same input with `keepSingleCR =
  false` loses its lone CR entirely rather than gaining a line break there. This
  catches a description that states only the net effect ("normalizes to CRLF")
  while performing a different pipeline, and pins §2's ordering: an input
  already containing CRLF is returned with those CRLFs unchanged, not widened.
* `normalizeEOLs` returns its argument unchanged for `''`, `0`, `null`,
  `undefined` and a non-string such as a buffer. This catches a description that
  says the function returns a normalized string, which is false for every one of
  those inputs.

### 12.2 Express helpers

* `errorHandler` sends the 500 body only when `res.headersSent` is false; called
  after the response has started it writes nothing and passes the error to
  `next`. This catches a description stating the 500 response unconditionally,
  which reads plausibly and is false for every call made once headers are out.

### 12.3 Random string generation

* `randomHexString(len)` returns a string of exactly `len` characters, not the
  `2 × len` characters that hex-encoding `len` bytes produces. This catches a
  description that says "`len` random bytes, hex-encoded" and omits the
  truncation.
* `randomAlphanumeric` recurses with fresh bytes when removing `/` and `+`
  leaves fewer than `len` characters, rather than padding the short candidate or
  re-filtering the bytes it already drew. A `randomFunc` returning bytes whose
  base64 encoding is rich in `/` and `+` exercises the retry, and the injected
  function is called again. This catches a description that promises `len`
  alphanumeric characters without stating how the shortfall is handled.

### 12.4 Hashing

* `hashQueueName` appends exactly one hexadecimal character, so the base name
  maps onto sixteen distinct queue names as the index varies. This catches the
  reading that the first **byte** of the md5 digest is used, which would give
  256.
* `getDomainHashKey` applies the dot-to-space substitution before hashing:
  hashing the lowercased domain without it yields a different key for the same
  input. This catches "sha256 of the lowercased domain", which reads plausibly
  and silently drops a step of the pipeline.

### 12.5 URL joining

* `urlJoin` drops a query string, a fragment and userinfo carried on `base`,
  keeps a non-default port, normalizes `..` segments through `path.join` — so
  joining `../c` onto a base path `/a/b` yields `/a/c` — and returns a
  normalized absolute href rather than a concatenation. This catches "appends
  `uri` to `base`'s path", which hides all three.

### 12.6 DNS resolution

* Exactly one of the timeout and the resolver settles the promise: a resolver
  callback arriving after the timeout is discarded, a timer firing after the
  resolver has settled has no effect, and the timeout path calls `cancel()` on
  the resolver. This catches a description that specifies the two paths
  independently and so permits a double settle.

### 12.7 Promise settling

* Every promise `allPromises` returns fulfils, including for inputs that reject,
  so `Promise.all` over the returned array resolves with one settled result per
  input in input order. This catches a description that gives only the two result
  shapes and omits the property the shim exists for.

### 12.8 Stream conversion

* `bufferToStream` starts the copy before putting the buffer and stops the
  stream afterwards, so `dest` receives the payload and reaches `finish`. This
  catches a description listing the three calls without their order, under which
  data could be put before a consumer is attached or the stream never stopped.

### 12.9 Email file persistence

* The directory is `<baseDir>/<YYYY-MM-DD>/<mail_from host>/<rcpt_to hosts
  joined with underscores>`, with the from segment before the to segment. This
  catches a description that swaps the two, which still reads plausibly.
* The base filename is the time-of-day part of the ISO timestamp with `:`
  replaced by `_`, followed by `-` and a nonce that increments across calls and
  is never reset within the loaded module instance. Two saves in the same
  millisecond produce different filenames. This catches a description that omits
  the nonce or treats it as per-call.
* An empty joined recipient host list produces the `invalid` segment and an
  absent sender host produces the `bounced` segment, each in its own position.
  This catches an implementation or description that swaps the two fallbacks.
* The `.json` file is written on every successful save and the `.eml` file only
  when `eml` is truthy. This catches a description that says the two are written
  as a pair, which is false for every call made without a message body.
* The JSON body spreads `moreData` first and then `transport`, so a `transport`
  key inside `moreData` is overwritten rather than merged, and an omitted
  `moreData` yields an object carrying `transport` alone. This catches "the
  transport plus any extra data", which hides the merge order.

### 12.10 Inbox cleanup

* `clearInboxes` empties the caller's array: after the call its length is zero
  and a second call clears nothing. This catches "clears each inbox", which
  misses that the array is consumed by `pop`.
* No `inbox.clear()` rejection makes `clearInboxes` throw — each is logged and
  the loop continues — and the cleanup error of §11 is never raised. This catches
  a reading of the source that records that throw as reachable.
