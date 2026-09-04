# Email Parsing Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the email parser, the per-recipient sorter and the file-parsing entry
point: how a raw RFC 822 message becomes one parsed item per recipient. The
three exported symbols specified here — `EmailParser`, `EmailSorter` and
`parseEmailFile` — are exactly the rows whose home spec is this file in
[overview.md §3]. Two unexported module-level bindings of `lib/EmailParser.js`,
`parseAddressHeader` and `parsingHeaders`, are specified with them because the
exported symbols cannot be described without them.

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here — this file uses
**Target**, **Transport object** and **`eml64`** as that glossary defines them,
and uses **header map**, **address object** and **JSON-safe email** as
[transport-model.md §0] defines them.

* **Parsed mail**: the object `simpleParser` returns for a raw RFC 822 message,
  as §3 step 1 produces it. Its `headers` is the parser's own header collection,
  read and written through `has`, `get` and `set`; it is not a header map, and
  §7 states the distinction where the two meet.
* **Transport extension**: the object §4 builds to hold the transport fields
  parsing derives. It is merged over the incoming transport when the email item
  is assembled.
* **Mail extension**: the object §5 builds to hold the mail fields parsing
  derives. It is spread into the email item.
* **Parsing-headers table**: the module-level list of `[name, transform]` pairs
  §7 specifies, applied to the parsed mail's headers after the message-id
  injection of §6.
* **Email item**: the object `EmailParser.parse` assembles in §3 step 8 and
  hands to the sorter, which holds it as `_item` (§8).
* **Sorted-out email**: the object the sorter builds for one recipient by
  spreading an email item and overriding two of its keys (§11). It is the
  element type of the list §9 returns.

An email item and a sorted-out email are both distinct from **Item**, which that
same cross-cutting glossary defines as one unit of work placed on the job queue.
An **Item** is what *wraps* a sorted-out email; it is neither of the two objects
this file names, and the wrapper is out of scope (§1.2).

## 1. Goals and non-goals

### 1.1 Goals

* Specify the signature, inputs, outputs, side effects and defaults of the three
  exported symbols this file owns — `EmailParser`, `EmailSorter` and
  `parseEmailFile` — together with the two unexported module-level bindings of
  `lib/EmailParser.js` they depend on.
* State the ordered pipelines that cannot be inferred from those signatures: the
  parse step order of §3, the two-write derivation of §4, and the per-recipient
  construction of §9, §10 and §11.
* Specify what a **parsed mail** is, and what it becomes as it passes through the
  parser and the sorter, so that every later stage reading one has a contract to
  read it against.
* Specify the four transport-field writes this file owns — `target` and
  `parsed_headers` being set, `headers` being re-written, and the second
  `rfc822_headers` write — stating when each fires and what it writes.

### 1.2 Non-goals

Scoped by this spec's own subject, never by an incidental property of the
current source:

* The internals of the parsing packages. `simpleParser`'s output shape,
  `Iconv`'s conversion and `addressparser`'s grammar are third-party contracts.
  This spec states which calls each symbol makes, with what arguments, and what
  it does with the result; the dependencies themselves are named in
  [overview.md §4].
* The transport object's own contract. [transport-model.md §2] is the authority
  on which fields a transport carries and which symbol writes each one. This
  spec specifies **when** the writes it owns fire and **what** they write, and
  does not restate that field table.
* The conversions this file calls but does not own. [transport-model.md §7],
  [transport-model.md §12], [transport-model.md §5] and
  [transport-model.md §13] are the sole authorities for `emailToTransport`,
  `getRfc822Headers`, `getRfc822Message`, `headerLinesToObject`,
  `headerListToObject` and `getJsonSafeEmail`. This spec names the call and its
  result and does not restate the conversion.
* The queue item and the jobs that consume it. [job-queue.md §0] owns queue-item
  mechanics, and [jobs.md §5] owns the job that wraps a sorted-out email into a
  route item. This spec specifies the object `EmailParser.parse` returns; what a
  consumer does with it is theirs.
* The other symbols exported from `lib/util.js`. [overview.md §3] routes each of
  them to another spec, and the spec that row names is the sole authority for
  that symbol.

## 2. The parser

`EmailParser` is exported from `index.js` as a named property and is defined in
`lib/EmailParser.js`.

`EmailParser` MUST have the constructor signature `constructor(options = {})`.
The constructor MUST set `this._options` to `options`, and MUST set
`this._logger` to the result of applying `getLogger` to `options`, which
[logging.md §3] specifies. The `options = {}` default parameter means a call with
no argument is valid and MUST NOT throw.

Neither stored value is read. `_options` and `_logger` are absent as **reads**,
on the axis of the class body and scoped to `lib/EmailParser.js`: each is
assigned exactly once, in the constructor, and read at no site. Both assignments
MUST be preserved as written, and an implementation MUST NOT drop either on the
grounds that nothing consumes it.

`EmailParser` carries exactly one other member, `parse` (§3).

## 3. Parsing an email

`EmailParser.parse` MUST have the signature `parse(eml, transport)` and MUST be
asynchronous. `eml` MUST be a buffer holding a raw RFC 822 message. `transport`
is optional: a falsy value MUST cause a transport to be synthesized in step 2.

`parse` MUST perform these steps in this order:

1. Parse `eml` by awaiting `simpleParser` applied to it with `Iconv` passed in
   its options. The result is the **parsed mail** for every later step.
2. When `transport` is falsy, replace it with the result of applying
   `emailToTransport` to the parsed mail, which [transport-model.md §7]
   specifies. A truthy `transport` MUST be used unchanged as the base for the
   merge of step 8.
3. Build the **transport extension** and perform the first `rfc822_headers`
   write into it (§4).
4. Await the embedded RFC 822 message, build the **mail extension**, and perform
   the second `rfc822_headers` write (§4, §5).
5. Compute `eml64` from `eml` (§5).
6. Inject the message-id into the parsed mail's headers (§6).
7. Apply the **parsing-headers table** to the parsed mail's headers (§7).
8. Construct an `EmailSorter` and return the result of its `getSortedOutEmails`
   (§8, §9).

The **email item** assembled at step 8 MUST be
`{...mailExt, eml64, mail, transport: {...transport, ...transportExt}}` — the
mail extension spread first, then `eml64`, then the parsed mail under `mail`,
then the merged transport under `transport`. The merge MUST spread the incoming
transport before the transport extension, so that a field the extension carries
overrides the same-named field of the transport (§4).

`EmailSorter` MUST receive that email item as its first argument and the same
parsed mail as its second. The parsed mail therefore reaches the sorter twice:
once as the item's `mail`, and once as the argument §8 converts.

`parse` MUST resolve to the list §9 specifies, and MUST NOT wrap it further.

## 4. The transport extension

The **transport extension** MUST start as an empty object and MUST be merged over
the incoming transport when the email item is assembled (§3 step 8).

`EmailParser.parse` MUST perform two `rfc822_headers` writes into it, and the two
MUST guard on **different objects**:

1. The first write MUST fire only when the **incoming transport** has no truthy
   `rfc822_headers`. It MUST apply `getRfc822Headers` — which
   [transport-model.md §12] specifies — to the parsed mail, and MUST set
   `rfc822_headers` on the transport extension only when that returns a value.
2. The second write MUST fire only when an embedded RFC 822 message was found
   (§5) **and** the **transport extension** has no truthy `rfc822_headers`. It
   MUST set `rfc822_headers` on the transport extension to `headerLinesToObject`
   — which [transport-model.md §5] specifies — applied to that message's
   `headerLines`.

The second write is therefore **not** a fallback for a first write that did not
happen. It is absent a guard on the **incoming transport**, on the axis of the
two writes' guard subjects and scoped to `EmailParser.parse`: its guard reads the
transport extension alone, so it fires whenever the transport extension lacks the
field — **including** when the incoming transport already carries one.

When the incoming transport carries `rfc822_headers` and the email also carries
an embedded RFC 822 message, the first write does not fire, the second guard sees
a transport extension without the field, and the second write produces a value
that **replaces** the incoming one at the `{...transport, ...transportExt}` merge
of §3 step 8. Both guards MUST be preserved as written, and an implementation
MUST NOT rewrite the second to test the incoming transport.

[transport-model.md §2] is the authority on which fields a transport carries and
which symbol writes each one; this section specifies when the second
`rfc822_headers` write fires and what it writes.

## 5. The mail extension

The **mail extension** MUST start as an empty object and MUST be spread first
into the email item (§3 step 8).

`EmailParser.parse` MUST await `getRfc822Message` — which
[transport-model.md §12] specifies — applied to the parsed mail, and MUST set
`rfc822_message` on the mail extension to that result **only** when it is
truthy. The key MUST be absent otherwise, rather than present and `undefined`.

That same result decides whether §4's second `rfc822_headers` write is reached:
both writes sit inside the one truthiness test, so the second `rfc822_headers`
write MUST NOT be performed when no embedded message was found.

`eml64` MUST be `eml.toString('base64')`, computed from the buffer `parse`
received. It is **not** part of the mail extension: §3 step 8 sets it as its own
key on the email item, after the mail extension is spread.

## 6. Message-id injection

`EmailParser.parse` MUST read `message_id` from the transport in scope after §3
step 2, and MUST set a `message-id` header on the parsed mail when **both** of
these hold:

* the parsed mail's headers do not already carry `message-id`, tested with the
  parsed mail's own `has`; and
* that `message_id` is truthy.

The write MUST use the parsed mail's own `set`, with the header name
`'message-id'` and that value. Both parts of the guard MUST be preserved: a
parsed mail already carrying the header MUST NOT have it overwritten, and a
transport carrying no `message_id` MUST NOT cause the header to be set.

This is a **mutation of the parsed mail**, not of the transport or of either
extension. The mutated parsed mail is the object §3 step 8 carries into the email
item and passes to the sorter, so the injected header is visible to every later
reader of that object.

A transport synthesized at §3 step 2 never triggers the injection.
[transport-model.md §2] records `message_id` as written onto a transport object
by no symbol under `lib/`, so a transport `emailToTransport` builds carries none
and the second part of the guard cannot hold for it. The injection therefore
fires only for a transport the caller supplied.

## 7. The parsing-headers table

`parsingHeaders` is an unexported module-level binding of `lib/EmailParser.js`.
It MUST be a list whose elements are `[name, transform]` pairs: a header name,
and a function applied to that header's current value. It MUST currently carry
exactly one entry, `['x-loop', parseAddressHeader]`.

The table is extensible by construction, and the mechanism is specified
separately from its contents: adding an entry MUST NOT change how §3 step 7
applies the table, and this section's statement of that step holds for any entry.

`parseAddressHeader` is the other unexported module-level binding of
`lib/EmailParser.js`. It MUST have the signature
`parseAddressHeader(headerValue)`, and MUST return `{value, text}` when
`headerValue` is a string — `value` being `addressparser` applied to it and
`text` being the string itself — and MUST return `undefined` for every other
argument, including a value already transformed.

§3 step 7 MUST iterate `parsingHeaders` in list order and, for each entry, MUST
read the named header from the parsed mail with its own `get`, apply the entry's
transform to that value, and set the named header to the result with the parsed
mail's own `set` **only** when the result is truthy. A falsy result MUST leave
the header as it was; this is the path a non-string value takes, and it MUST be
preserved as written rather than replaced by an unconditional set.

The two pair shapes in play MUST NOT be conflated. `parsingHeaders` holds
`[name, transform]` pairs, which are not the `[name, value]` pair list that
[transport-model.md §5]'s `headerListToObject` consumes; nothing in this file
passes `parsingHeaders` to a header-map conversion. The `headers` this step
reads and writes is the **parsed mail's** own collection, reached through `has`,
`get` and `set` (§0), and is not a header map either. The parsed mail's headers
become a header map only in §10, and only for the transport.

## 8. The sorter

`EmailSorter` is exported from `index.js` as a named property and is defined in
`lib/EmailSorter.js`.

`EmailSorter` MUST have the constructor signature `constructor(item, mail)`,
where `item` is an **email item** (§3) and `mail` is the parsed mail that item
carries.

The constructor MUST set exactly three properties, in this order:

1. `_item` to `item` itself, held without copying.
2. `_mail` to `getJsonSafeEmail` applied to `mail`, which
   [transport-model.md §13] specifies. The sorter calls that conversion **once**,
   here in its constructor, and every later use of `_mail` reads the one value it
   produced.
3. `_transport` to `item.transport` — the merged transport §3 step 8 built, read
   off the item rather than taken as a separate argument.

The parsed mail the constructor converts is the same object the email item
carries under `mail`, so the sorter holds both forms: the raw parsed mail inside
`_item`, and the JSON-safe projection in `_mail`. §11 specifies which of the two
reaches a returned item.

## 9. Sorted-out emails

`EmailSorter.getSortedOutEmails` MUST have the signature
`getSortedOutEmails()` and MUST return an array holding one **sorted-out email**
per entry of `_transport.rcpt_to`, in `rcpt_to` order.

`getSortedOutEmails` MUST iterate `_transport.rcpt_to` directly and MUST build
each element by applying §11's construction to that entry. It MUST return the
empty array when `rcpt_to` is present and empty.

The iteration is **unguarded**. `getSortedOutEmails` is absent a guard on
`_transport.rcpt_to`, on the axis of the `for…of` iterable and scoped to this
method: a transport carrying no `rcpt_to`, or carrying a value that is not
iterable, MUST raise rather than yield an empty list. This MUST be preserved as
written; an implementation MUST NOT add a guard that turns the raise into an
empty result.

`getSortedOutEmails` is synchronous and performs no conversion of its own beyond
§10's per-recipient call.

## 10. Per-recipient transport info

`EmailSorter._getTransportInfo` MUST have the signature
`_getTransportInfo(address)`, where `address` is the current `rcpt_to` entry of
§9's iteration. It MUST return a new object built by spreading `_transport` and
then setting exactly three keys, in this order: `headers`, `parsed_headers` and
`target`.

* `headers` MUST be `headerListToObject` — which [transport-model.md §5]
  specifies — applied to `this._mail.headers || []`.
* `parsed_headers` MUST be the literal `true`.
* `target` MUST be `address`.

These are the three writes [transport-model.md §2] attributes to this symbol;
`headers` is a **re-write** of a field the transport already carried, while
`parsed_headers` and `target` are set here and nowhere else.

**The `|| []` fallback.** Two statements hold about it, and neither is a ground
for the other:

* **It can never be taken.** `_mail` is the JSON-safe projection §8 built, and
  [transport-model.md §13] requires `getJsonSafeEmail` to set `headers` from
  `getJsonSafeHeaders`, which returns `mail.headers` spread into a new array. So
  `this._mail.headers` is an array on every call, and every array is truthy, the
  empty array included.
* **It would change nothing if it could fire.** [transport-model.md §5] requires
  `headerListToObject` to treat a falsy argument as the empty list, so both
  branches would yield the same header map.

The first is a statement about **reachability** and the second about
**consequence**; the second MUST NOT be read as evidence for the first. The
expression MUST be preserved as written, including the fallback.

**Which sense of `headers` this write produces.** The value this symbol writes is
a **header map** built from the parsed mail's header **list**, which is a
different derivation from the header map [transport-model.md §2] records
`envelopeToTransport` as writing for the same field. Both are header maps; a
reader MUST NOT assume the value a transport carries downstream is the one the
envelope conversion produced.

**Which form `target` receives.** `target` is set to the `rcpt_to` entry itself,
which is an **address object** as [transport-model.md §3] types them. It is
therefore neither of the two other shapes the name carries elsewhere in the spec
set: it is not the named destination [overview.md §0] glosses as **Target**, and
it does not carry the `guid` that [transport-model.md §10] step 3 reads from
`content.transport.target`. This statement is about the value this symbol writes;
it makes no claim about what a reader elsewhere expects.

## 11. The sorted-out email shape

`EmailSorter._createEmailData` MUST have the signature
`_createEmailData(address, mail)` and MUST return
`{...this._item, mail, transport: this._getTransportInfo(address)}` — the email
item spread first, then `mail`, then `transport` from §10.

The two later keys therefore **override** the same-named keys the email item
carried. §9 passes `_mail` as the `mail` argument on every call, so the raw
parsed mail the item carries under `mail` never reaches a returned item: every
sorted-out email carries the JSON-safe projection instead. The `transport` key
likewise carries §10's per-recipient object, not the merged transport `_item`
holds.

Identity and per-recipient variation are **two independent questions**, and each
of the three keys §10 writes is classified on both:

| Key | Object identity | Varies per recipient |
|---|---|---|
| `headers` | a new object on every call, built by `headerListToObject` | no — the same content for every recipient, since `_mail` is one value |
| `parsed_headers` | the literal `true` | no |
| `target` | **not** fresh — the loop's current `rcpt_to` entry, and therefore the very address object that entry of the input transport carries | yes |

`target` is the one key that is both an alias into the input transport and
per-recipient; being an alias and varying per recipient do not imply each other,
and the table states each separately.

The spread of `_transport` in §10 is **shallow**. Its result is absent a copy of
the values it spreads, on the axis of object identity and scoped to
`EmailSorter`: for any nested value the caller's transport carries — the address
objects inside `rcpt_to`, `mail_from` — the same object is reachable from every
returned item. Callers MUST NOT mutate a returned item's transport in the belief
that the change is local to that recipient.

The `mail` every returned item carries is likewise **one shared object**.
`getSortedOutEmails` is absent a per-recipient copy of the JSON-safe mail, on the
axis of the `mail` property across the returned items and scoped to that method:
every returned item's `mail` is the single value §8's constructor produced.

## 12. Parsing an email file

`parseEmailFile` is exported from `index.js` through the spread of
`lib/parse-email-file.js`. It MUST have the signature
`parseEmailFile(emlPath, transportPath)` and MUST be asynchronous.

`parseEmailFile` MUST perform these steps in this order:

1. Read `emlPath` with `fs.readFileSync`, with no encoding argument, so the
   result is a buffer.
2. Initialize the transport to `null`. When `transportPath` is truthy, read that
   path with `fs.readFileSync` as `'utf8'`, parse the result with `JSON.parse`,
   and take the parsed value's `transport` property as the transport.
3. Construct an `EmailParser` **with no argument**.
4. Await that parser's `parse` (§3) applied to the buffer and the transport, and
   return its result.

Both reads are **synchronous** despite the enclosing function being `async`, and
this MUST be preserved as written.

The transport `parse` receives is `null` when `transportPath` is falsy, and
`undefined` when the sidecar JSON carries no `transport` property. Both are
falsy, so §3 step 2 synthesizes the transport in each case; only a sidecar
carrying the property supplies one.

The `EmailParser` construction is absent an argument, on the axis of the
constructor call and scoped to `lib/parse-email-file.js`. Its consequence is what
makes the absence matter: the parser `parseEmailFile` builds resolves the default
logger of [logging.md §3] — §2's `options = {}` default supplies an empty object,
and that rule returns the default logger for a falsy `options.logger` — and no
caller of `parseEmailFile` can supply another. A caller needing a different
logger MUST construct an `EmailParser` directly.

## 13. Tests checklist

### 13.1 The parser

* Constructing `EmailParser` with no argument does not throw, stores `{}` as
  `_options`, and stores the default logger of [logging.md §3] as `_logger`.
* Constructing it with an `options` carrying a truthy `logger` stores that
  logger, while a falsy `options.logger` falls back to the default.
* A sweep of the class body in `lib/EmailParser.js` finds `_options` and
  `_logger` assigned once each in the constructor and read at no site, and both
  assignments are still present.

### 13.2 Parsing an email

* `parse` called with a truthy `transport` uses it unchanged as the base of the
  step 8 merge, and does not synthesize one.
* `parse` called with a falsy `transport` synthesizes one from the parsed mail
  before step 3, and the rest of the pipeline runs against that value.
* The email item carries the mail extension's keys, `eml64`, `mail` and
  `transport`, with the merged transport spreading the incoming transport before
  the transport extension.
* `EmailSorter` receives the email item first and the same parsed mail second,
  and `parse` resolves to the sorter's list itself rather than to a wrapper
  around it.

### 13.3 The transport extension

* An incoming transport without `rfc822_headers`, for an email carrying a
  `text/rfc822-headers` attachment, takes the first write and carries that value
  through the merge.
* An incoming transport that **already** carries `rfc822_headers`, for an email
  that also carries an embedded RFC 822 message, does not take the first write,
  does take the second, and the merged transport carries the second value —
  the incoming one is replaced, not preserved. A spec or implementation that
  describes the second write as a fallback for the first fails this scenario.
* An incoming transport without `rfc822_headers`, for an email with an embedded
  RFC 822 message but no `text/rfc822-headers` attachment, takes the second
  write from that message's header lines.
* An email carrying neither source leaves the transport extension empty, and the
  merged transport carries exactly what the incoming transport carried.

### 13.4 The mail extension

* An email carrying an embedded RFC 822 message sets `rfc822_message` on the
  mail extension, and the email item carries it.
* An email carrying none leaves the key absent from the email item rather than
  present and `undefined`, and the second `rfc822_headers` write is not
  performed.
* `eml64` is the base64 encoding of the buffer `parse` received, and is a key of
  the email item rather than of the mail extension.

### 13.5 Message-id injection

* A parsed mail whose headers do not carry `message-id`, with a transport
  carrying a truthy `message_id`, has the header set on the parsed mail itself,
  and the sorter sees the mutated object.
* A parsed mail already carrying `message-id` keeps its own value, whatever the
  transport carries.
* A transport synthesized at §3 step 2 carries no `message_id`, so the injection
  does not fire for it; only a caller-supplied transport can trigger it.

### 13.6 The parsing-headers table

* An `x-loop` header carrying a string is replaced by `{value, text}`, where
  `text` is the original string.
* An `x-loop` header that is absent, or carries a non-string, leaves the header
  as it was, because the transform returns `undefined` and the set is skipped.
* Applying the table to a parsed mail whose `x-loop` has already been
  transformed leaves it unchanged, since the transformed value is not a string.
* `parsingHeaders`' `[name, transform]` pairs are never passed to a header-map
  conversion, and the headers this step reads and writes are reached through the
  parsed mail's own `has`, `get` and `set`.

### 13.7 The sorter

* The constructor sets `_item`, `_mail` and `_transport`, and `_transport` is
  the email item's own `transport` rather than a separate argument.
* The sorter applies `getJsonSafeEmail` once, in its constructor, and every
  later read of `_mail` sees that one value.
* `_item` is the object passed in, held without copying.

### 13.8 Sorted-out emails

* A transport with several `rcpt_to` entries yields one sorted-out email per
  entry, in `rcpt_to` order.
* A transport with an empty `rcpt_to` yields an empty array.
* A transport with no `rcpt_to`, or with a non-iterable one, raises rather than
  yielding an empty array.

### 13.9 Per-recipient transport info

* The returned object carries the transport's spread fields, plus `headers`,
  `parsed_headers` set to `true`, and `target`.
* `this._mail.headers` is an array on every call, because
  [transport-model.md §13] makes it one, so the `|| []` fallback is never taken;
  the expression is nonetheless still present.
* The `headers` this symbol writes is built from the parsed mail's header list,
  and a transport carrying it downstream no longer carries the value the
  envelope conversion produced.
* `target` is the `rcpt_to` entry itself and is address-object shaped. A spec or
  implementation that treats the written value as a named destination, or that
  expects to read a `guid` from it, fails this scenario.

### 13.10 The sorted-out email shape

* Each returned item spreads the email item and then overrides `mail` and
  `transport`, so both come from the sorter rather than from the item.
* No returned item carries the raw parsed mail: every one carries the JSON-safe
  projection instead.
* Every returned item's `mail` is the same object, not a per-recipient copy.
* Mutating a nested value of one returned item's transport — an `rcpt_to`
  address object, or `mail_from` — is visible from the others, and each item's
  `target` is both an alias into the input transport and different per recipient.

### 13.11 Parsing an email file

* `parseEmailFile` called without a `transportPath` passes `null` as the
  transport, and a sidecar JSON carrying no `transport` property passes
  `undefined`; both cause the transport to be synthesized, while a sidecar
  carrying the property supplies it.
* Both file reads are synchronous, and the returned promise resolves to the list
  §3 specifies.
* The `EmailParser` it constructs receives no argument, so it resolves the
  default logger §2 specifies, and no caller of `parseEmailFile` can supply
  another.
