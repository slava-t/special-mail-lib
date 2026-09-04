# Transport Model Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the transport object and the conversions that build, read and project it:
address objects and address collection, header maps, the envelope and email
conversions, envelope adjustment, guid generation and extraction, message
identifiers, embedded RFC 822 content, the JSON-safe forms and the log-info
projection. The twenty-one exported symbols specified here are exactly the
`lib/util.js` rows whose home spec is this file in [overview.md §3]; two
unexported helpers of the same module, `extractAddress` and
`getRelaxedHeaderLine`, are specified with them because the exported symbols
cannot be described without them. Every other symbol in that module belongs to
another spec and is out of scope (§1.2).

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here — this file uses
**Transport object**, **Envelope**, **Guid** and **Target** as that glossary
defines them, and owns the transport object's contract rather than its name.

* **Address object**: the lowercased projection `addressToObject` returns for one
  parsed address — `original`, `host` and `user`, plus `original_host` when the
  parsed address carries one. It is the element type of `rcpt_to` and the type
  of `mail_from` (§3).
* **Header map**: a plain object keyed by header name whose value for each key is
  an array of that header's values, as §5's three conversions return it. A
  header appearing once still maps to a one-element array.
* **Relaxed header line**: the single string `getRelaxedHeaderLine` produces for
  one header name — the lowercased trimmed name, `': '`, and that header's
  values joined with CRLF after each has had its line breaks removed and its
  ends trimmed (§9).
* **Canonical guid input**: the buffer `generateEmailGuid` hashes — eight lines
  joined with CRLF and terminated with a further CRLF, being the four
  sender/recipient lines followed by four relaxed header lines, encoded
  `'binary'` (§9).
* **JSON-safe email**: the projection `getJsonSafeEmail` returns for a parsed
  mail — the mail's own enumerable properties with `headers` replaced by an array
  and `attachments` replaced by the projection §13 defines, so the result
  survives `JSON.stringify` (§13).
* **Log-info object**: the `{id, guid, to, from}` object `transportLogInfo`
  returns for a truthy transport, whose four values are preformatted strings
  (§14).

## 1. Goals and non-goals

### 1.1 Goals

* Specify the fields of the transport object, which symbol writes each one, and
  in what order those writes happen, including the writes performed outside this
  spec's source range (§2).
* Specify the signature, parameter defaults, return value, error behavior and
  side effects of each of the twenty-three symbols this file covers.
* State the ordered pipelines that cannot be inferred from those signatures —
  the coercion chain of §3, the conversion order of §6 and §7, the repair
  sequence of §8, the hashing pipeline of §9, the precedence chain of §10 and the
  projections of §13 and §14 — precisely enough that compliance can be determined
  from this spec alone.

### 1.2 Non-goals

Scoped by this spec's own subject, never by an incidental property of the
current source:

* The internals of the parsing and composing packages. `MailComposer`'s
  compilation, `simpleParser`'s output shape, `addressparser`'s grammar,
  `Headers`' accessors and `Address`'s parsing are third-party contracts. This
  spec states which calls each symbol makes, with what arguments, and what it
  does with the result; the dependencies themselves are named in
  [overview.md §4].
* The parsed-mail object's own contract. §12 and §13 take a `mail` argument and
  read `attachments` and `headers` from it; [email-parsing.md §0] owns what a
  parsed mail is.
* The routing header constants. §10 reads the guid header by the constant
  [routing-headers.md §2] owns; this file does not restate its value.
* The transport-field writes that happen outside this spec's source range. §2
  names all four — `target` and `parsed_headers` being set, `headers` being
  re-written, and `rfc822_headers`'s second write — and points at
  [email-parsing.md §4] and [email-parsing.md §10], so the object is
  describable; this spec does not specify
  when any of them fires. `guid` and `message_id` are non-goals for the same
  reason — the object stays describable without this spec naming a writer —
  though their case differs from the four above: neither is written **onto a
  transport object** by any symbol under `lib/`, `guid` is read by §10 and §14,
  and `message_id` is read only in `EmailParser.parse` (`lib/EmailParser.js`).
  §2 records both as read-only here and names no owning spec, because no spec in
  the set covers a writer for them.
* The other symbols exported from `lib/util.js`. [overview.md §3] routes each of
  them to another spec, and the spec that row names is the sole authority for
  that symbol.

## 2. The transport object

A transport object is built by §6 from an envelope, or by §7 from an email, and
is then carried through the queue and the parsing, routing and delivery stages.
This section is the authority on which fields it carries and which symbol writes
each one; the sections that follow specify the symbols themselves.

A transport object MUST carry every enumerable property of the envelope it was
built from, because §6 spreads that envelope into its result before adding its
own fields. The named fields below are the ones this library writes or reads by
name.

| Field | Type | Written by, in write order |
|-------|------|----------------------------|
| `mail_from` | address object, or `''` | `envelopeToTransport` (§6). Overrides any same-named envelope property. |
| `rcpt_to` | array of address objects | `envelopeToTransport` (§6). Overrides any same-named envelope property. |
| `headers` | header map | `envelopeToTransport` (§6), from the envelope's `Headers` instance; then **re-written** by `EmailSorter._getTransportInfo` (`lib/EmailSorter.js`) from the parsed mail's header list. Overrides any same-named envelope property. |
| `rfc822_headers` | header map | `emailToTransport` (§7), only when the email carries a `text/rfc822-headers` attachment; then **written again** by `EmailParser.parse` (`lib/EmailParser.js`), from a different derivation and with a value that can replace the one §7 produced. |
| `target` | address object | `EmailSorter._getTransportInfo` (`lib/EmailSorter.js`). |
| `parsed_headers` | `true` | `EmailSorter._getTransportInfo` (`lib/EmailSorter.js`). |
| `guid` | string | Read only, no writer here: written onto a transport object by no symbol under `lib/`. Read by §10's precedence chain and, through it, by §14. |
| `message_id` | string | Read only, no writer here: written onto a transport object by no symbol under `lib/`. Read only in `EmailParser.parse` (`lib/EmailParser.js`). |

The four writes performed outside this spec's source range — `target` and
`parsed_headers` being set, `headers` being re-written, and `rfc822_headers`'s
second write — belong to [email-parsing.md §4] and [email-parsing.md §10],
which own both symbols that perform them. Readers of a transport MUST NOT
assume the `headers` or `rfc822_headers` a transport carries downstream is the
value §6 or §7 produced:
each has a second writer, and the second `rfc822_headers` write can replace the
first.

`guid` and `message_id` have no owning spec, because no spec in the set covers a
symbol that writes either of them onto a transport object. A transport §6 or §7
builds from an envelope carrying neither field — for §7, the envelope its step 2
takes from the compiled message — carries neither.

A transport object is not itself the unit of work on the queue.
[job-queue.md §0] and [jobs.md §2] own the item that wraps it, where the
transport is the item's `transport` property; this spec describes only the object
under that key.
`routing.md` **reads** `transport.target.host`, `transport.target.user` and
`transport.target.original` and does not write `transport.target`. The value
`EmailSorter._getTransportInfo` writes is address-object shaped, as
[email-parsing.md §10] states; it is not the named destination glossed as
**Target** in [overview.md §0].

## 3. Address objects

`addressToObject` MUST have the signature `addressToObject(address)` and MUST
return an address object built from an `address-rfc2821` `Address` instance.

`addressToObject` MUST set `original`, `host` and `user` unconditionally, each
from the same-named property of `address` lowercased. It MUST set
`original_host` only when `address.original_host` is truthy, also lowercased, and
MUST omit the key entirely otherwise. The result therefore has three keys or
four, never a fourth key holding `undefined`.

`extractAddress` MUST have the signature `extractAddress(source)` and MUST return
either an address string or `undefined`. It is not exported from `lib/util.js`;
§8 reads its result and this section specifies it so that §8 is describable.

`extractAddress` MUST coerce `source` in this order, and MUST return `undefined`
at any step that cannot continue:

1. When `source` is an array, `extractAddress` MUST return `undefined` if the
   array has fewer than one element, and otherwise MUST replace `source` with its
   first element.
2. When `source` is then a string, `extractAddress` MUST replace it with the
   result of parsing it with `addressparser`. When that result is an array,
   `extractAddress` MUST return `undefined` if it has fewer than one element, and
   otherwise MUST replace `source` with its first element.
3. When `source` is then a non-null object, `extractAddress` MUST return
   `source.address` if that is truthy, and `source.value` otherwise.
4. `extractAddress` carries a trailing branch returning `source` when `source` is
   a truthy string. This branch is **unreachable**: every path through steps 1
   and 2 that could leave `source` a string replaces it with the result of
   `addressparser`, which returns an array, after which the function either
   returns at step 2 or holds an object that step 3 claims. It MUST be preserved
   as written; an implementation MUST NOT drop it on the grounds that its effect
   is already achieved.

The empty-array early return fires at **both** places an array is inspected — the
argument itself in step 1, and the parse result in step 2 — so an empty parse of
a non-empty string yields `undefined` rather than falling through to step 3.

## 4. Address collection

`extractAddressObjects` MUST have the signature `extractAddressObjects(source)`
and MUST return an array of `{name, address}` objects, empty when `source` is
falsy.

`extractAddressObjects` MUST walk `source` as follows:

* When `source` is an array, it MUST recurse into every element and concatenate
  the results in element order.
* When `source` is an object, it MUST read `source.address`. When that value is
  truthy **and** is a string or a `String` instance, it MUST push a single
  `{name, address}` object, where `name` is `source.name` or `''` when
  `source.name` is falsy, and `address` is the value it read. Otherwise it MUST
  recurse into `Object.values(source)` and concatenate the results.
* Any other type contributes nothing.

The `Object.values` recursion is what allows a container object — a map of
addresses, or a parsed field holding them under arbitrary keys — to be flattened
without the caller naming its shape.

`parseAddresses` MUST have the signature `parseAddresses(source)` and MUST return
`extractAddressObjects` applied to the result of a four-branch dispatch:

1. A falsy `source` MUST return the empty array **without** calling
   `extractAddressObjects`.
2. An array MUST be mapped through `parseAddresses` recursively and the results
   concatenated in order.
3. A non-array object MUST become the single-element array `[{name:
   source.name, address: source.address}]`. This branch does not default `name`;
   an absent `source.name` reaches `extractAddressObjects` as `undefined` and is
   defaulted to `''` there.
4. Anything else MUST be parsed with `addressparser`.

`getAddressesFromEmail` MUST have the signature `getAddressesFromEmail(email)`
and MUST return an object with nine properties: `from`, `to`, `cc`, `bcc`,
`envelopeFrom`, `envelopeTo`, `envelopeCc`, `envelopeBcc` and `recipients`.

The first four MUST be `parseAddresses` applied to the same-named properties of
`email`. The next four MUST be `parseAddresses` applied to the `from`, `to`,
`cc` and `bcc` properties of `email.envelope`, in that order, treated as `{}`
when absent.

`recipients` MUST be the de-duplicated list of address **strings** taken from
`to`, `cc`, `bcc`, `envelopeTo`, `envelopeCc` and `envelopeBcc` concatenated in
that order. De-duplication MUST be by address string alone, so two entries with
the same address and different names collapse to one, and the result MUST be an
array of strings rather than of `{name, address}` objects. `from` and
`envelopeFrom` MUST NOT contribute to `recipients`.

## 5. Header maps

`headerListToObject` MUST have the signature `headerListToObject(headers)` and
MUST return a header map built from a list of `[name, value]` pairs, treating a
falsy argument as the empty list.

For each pair, `headerListToObject` MUST create the key's array on first
appearance only, using an own-property check rather than a truthiness test, and
MUST then append to that array. When the pair's value is an array,
`headerListToObject` MUST append its elements individually; otherwise it MUST
append the value whole. A header name appearing more than once therefore
accumulates into one array in list order.

`headersToObject` MUST have the signature `headersToObject(headers)` and MUST
return a header map built from a `mailsplit` `Headers` instance.

`headersToObject` MUST iterate the instance's `getList()` result and, for each
key not already present, MUST set that key to the decoded values obtained by
calling `getDecoded(key)` on the instance and taking each entry's `value`. The
own-property check means `getDecoded` MUST be called at most once per distinct
key: a key that appears several times in the list is processed on its first
appearance, and `getDecoded` returns all of that key's values at once, so a
repeated header is neither processed twice nor truncated to its first value.

`headerLinesToObject` MUST have the signature
`headerLinesToObject(headerLines)` and MUST return `headersToObject` applied to a
new `Headers` instance constructed from `headerLines`.

## 6. Envelope to transport

`envelopeToTransport` MUST have the signature `envelopeToTransport(envelope)` and
MUST return a transport object.

`envelopeToTransport` MUST derive the recipients from `envelope.to`. When
`envelope.to` is an array, it MUST first be joined with `','` into a single
string; otherwise it is used as it stands. The resulting string MUST be parsed
with `addressparser`, and each parsed entry's `address` MUST be converted to an
address object by constructing an `address-rfc2821` `Address` from it and passing
that to §3's `addressToObject`.

`envelopeToTransport` MUST derive the sender from `envelope.from` by parsing it
with `addressparser`. When that yields a non-empty array, the sender MUST be the
address object built from the **first** entry's `address` by the same
`Address`-then-`addressToObject` conversion. When it yields no entries, the
sender MUST remain the empty string `''` — not `undefined`, and not an address
object with empty parts.

`envelopeToTransport` MUST return the envelope's own enumerable properties
spread first, and MUST then set `mail_from`, `rcpt_to` and `headers`, in that
order, so that these three **override** any same-named property the envelope
carried rather than merging with it. `headers` MUST be §5's `headersToObject`
applied to `envelope.headers`, which is a `Headers` instance at this point.

## 7. Email to transport

`emailToTransport` MUST have the signature `emailToTransport(email)` and MUST
return a transport object built from a `nodemailer` mail definition.

`emailToTransport` MUST perform these steps in this order:

1. Compile the email by constructing a `MailComposer` from it and calling
   `compile()`.
2. Take the envelope from the compiled message with `getEnvelope()`.
3. Build the header string from the compiled message with `buildHeaders()`, and
   construct a `mailsplit` `Headers` instance from it.
4. **Replace** `envelope.headers` with that `Headers` instance before any
   conversion, so §6 converts the compiled headers rather than whatever the
   envelope carried.
5. Convert the envelope with §6's `envelopeToTransport`.
6. Read the RFC 822 headers with §12's `getRfc822Headers` and, **only** when that
   returns a value, set `rfc822_headers` on the transport.

`emailToTransport` MUST NOT set `rfc822_headers` when the email carries no
`text/rfc822-headers` attachment; the key is absent in that case rather than
present and empty.

## 8. Envelope adjustment

`adjustEnvelope` MUST have the signature `adjustEnvelope(envelope)`. It MUST
return an empty object on success and MUST **mutate** the envelope it is given;
the repairs it performs are its whole effect, and the return value carries no
result data.

`adjustEnvelope` MUST return `{}` immediately, performing **no** repair and no
inspection of the headers, when `envelope.interface` is the string `'bounce'`.

Otherwise `adjustEnvelope` MUST convert `envelope.headers` with §5's
`headersToObject` and extract two addresses from that map with §3's
`extractAddress`: the `from` header's value, and the `reply-to` header's value.

`adjustEnvelope` MUST then apply these repairs in this order:

1. When `extractAddress(envelope.from)` yields nothing, the envelope has no
   usable sender. If the `from` **header** yielded nothing either,
   `adjustEnvelope` MUST return `{error}` where `error` is a **native `Error`**
   with the message `Missing 'from' field in envelope`. This is a native `Error`
   instance, not the plain object the `createError` factory produces —
   `errors.md` owns that factory and its catalog, and its object shape does not
   apply here. Otherwise `adjustEnvelope` MUST set `envelope.from` to the address
   extracted from the header.
2. When the `from` **header** yielded nothing, `adjustEnvelope` MUST adopt
   `envelope.from` as the sender, then MUST `remove` the `from` header from the
   envelope's `Headers` instance and `add` it back with that value. The removal
   and the addition are both required: the repair replaces the header rather than
   appending a second one.
3. When the `reply-to` header yielded nothing, `adjustEnvelope` MUST `remove` the
   `reply-to` header and `add` it back with the sender value the preceding steps
   left in hand: the address extracted from the `from` **header** when that
   header yielded one, and `envelope.from` when it did not and step 2 adopted
   it. These two differ on an envelope whose `from` property and `from` header
   both yield an address and the two addresses are not the same; the header's
   address is the one this step uses there.

Step 2's condition is the state of the `from` header, not of `envelope.from`: an
envelope whose `from` header parsed successfully keeps its header untouched even
when step 1 has just written `envelope.from`.

On success `adjustEnvelope` MUST return `{}`, with the repairs visible only
through the mutated envelope.

## 9. Guid generation

`generateGuid` MUST have the signature `generateGuid(prefix = 'email_', len =
24)` and MUST return `prefix`, coerced with `toString()`, followed by a random
alphanumeric string of length `len`.

The random part MUST be obtained from `randomAlphanumeric`, which
[utilities.md §4] owns, and MUST then have `'I'` replaced with `'T'` and `'l'`
replaced with `'L'`. Both replacements use **string** patterns, so each replaces
the **first** occurrence only: a candidate containing two `I`s keeps the second.
This MUST be preserved as written.

`getRelaxedHeaderLine` MUST have the signature `getRelaxedHeaderLine(headers,
headerName)` and MUST return a relaxed header line. It is not exported from
`lib/util.js`; `generateEmailGuid` builds four of its lines from it and this
section specifies it so that the canonical guid input is describable.

`getRelaxedHeaderLine` MUST read `headers[headerName]`, defaulting to the empty
array when absent, and MUST wrap a non-array value in a one-element array so a
scalar header value is handled identically to a single-element list.

`getRelaxedHeaderLine` MUST then map each value through `.replace(/\r?\n/g, '')`
**twice** and `.trim()`. The second replacement is a no-op — the first is global
and leaves no match — and MUST be preserved as written: the guid input is
byte-exact, and an implementation MUST NOT simplify the pair to a single call.

`getRelaxedHeaderLine` MUST return the header name lowercased and trimmed,
followed by `': '`, followed by the cleaned values joined with CRLF.

`generateEmailGuid` MUST have the signature `generateEmailGuid(from, to, headers,
prefix = 'email_', len = 24)` and MUST return `prefix` followed by a hash of the
canonical guid input.

The canonical guid input MUST be built as exactly eight lines, in this order:

1. `from-user: ` followed by `from.user`, or the empty string when that is falsy.
2. `from-host: ` followed by `from.host`, or the empty string when that is falsy.
3. `to-user: ` followed by `to.user`, or the empty string when that is falsy.
4. `to-host: ` followed by `to.host`, or the empty string when that is falsy.
5. The relaxed header lines for `message-id`, `from`, `to` and `subject`, in
   **that** order, each produced by `getRelaxedHeaderLine` from `headers`.

The eight lines MUST be joined with CRLF, MUST be terminated with a further
CRLF, and MUST be encoded into a buffer with the `'binary'` encoding.

`generateEmailGuid` MUST then apply this pipeline to that buffer, in this order,
and MUST NOT reorder its steps:

1. A `crypto` sha512 hash, updated with the buffer.
2. `digest('base64')`.
3. `.replace(/[/+=]/g, '')`, removing every `/`, `+` and `=`.
4. `.replace('I', 'T')` and `.replace('l', 'L')`, each replacing the **first**
   occurrence only, as `generateGuid`'s do.
5. `.substr(0, len)`.
6. `.padEnd(len, 'd')`, which fires only when step 3 removed enough characters to
   leave the digest shorter than `len`.

The result MUST be `prefix` concatenated with that string. The prefix is not
included in the `len` count.

## 10. Guid extraction

`extractGuidFromHeaders` MUST have the signature
`extractGuidFromHeaders(headers)` and MUST return a guid string or `undefined`.

`extractGuidFromHeaders` MUST return `undefined` for a falsy `headers`, and MUST
otherwise read the header named by the guid header constant
[routing-headers.md §2] owns. When that value is an array,
`extractGuidFromHeaders` MUST return its first element **only** when the array
has exactly one element; an array of two or more values yields `undefined` rather
than the first value, and this MUST be preserved as written. When the value is a
string, `extractGuidFromHeaders` MUST return it. Any other value yields
`undefined`.

`extractGuid` MUST have the signature `extractGuid(content, fromHeaders = true)`
and MUST return a guid string or `undefined`.

`extractGuid` MUST return `undefined` for a falsy `content`, and MUST otherwise
apply this precedence chain, returning at the first step that yields a truthy
value:

1. `content.guid`.
2. `content.transport.guid`. When `content.transport` is falsy, `extractGuid`
   MUST return `undefined` here rather than continuing.
3. `content.transport.target.guid`, when `transport.target` is present. The
   target this library writes in [email-parsing.md §10] is address-object shaped
   and carries no `guid` unless the address object itself carries such an extra
   property; this step still reads the property as written.
4. `extractGuidFromHeaders(transport.headers)`.

Step 4 MUST be reached only when `fromHeaders` is true. A caller passing
`fromHeaders = false` therefore stops after step 3 and receives `undefined` for a
transport whose guid is carried only on the guid header.

## 11. Message identifiers

`generateMessageId` MUST have the signature `generateMessageId(domain, prefix =
'id.')` and MUST return a message identifier of the form
`<{prefix}{timestamp}.{random}@{domain}>`, where the angle brackets are literal,
`timestamp` is `Date.now()`, and `random` is `randomHexString(24)` from
[utilities.md §4].

The length argument is the literal `24`; `randomHexString` returns a string of
that many characters, as [utilities.md §4] specifies.

## 12. Embedded RFC 822 content

`getRfc822Headers` MUST have the signature `getRfc822Headers(mail)` and MUST
return a header map or `undefined`.

`getRfc822Headers` MUST scan `mail.attachments`, treated as the empty list when
absent, and MUST select the **first** attachment whose `contentType` is exactly
`text/rfc822-headers`. It MUST construct a `mailsplit` `Headers` instance from
that attachment's `content` and MUST return §5's `headersToObject` applied to it.
It MUST return `undefined` when no attachment matches; a later matching
attachment MUST NOT be considered once an earlier one has matched.

`getRfc822Message` MUST have the signature `getRfc822Message(mail)`, MUST be
asynchronous, and MUST resolve to a JSON-safe email or `undefined`.

`getRfc822Message` MUST scan `mail.attachments`, treated as the empty list when
absent, and MUST select the **first** attachment whose `contentType` is exactly
`message/rfc822`. It MUST parse that attachment's `content` with `simpleParser`,
passing `Iconv` in its options, and MUST return §13's `getJsonSafeEmail` applied
to the parse result — the JSON-safe projection, not the raw parsed mail. It MUST
resolve to `undefined` when no attachment matches.

## 13. JSON-safe forms

`extractAttachments` MUST have the signature `extractAttachments(mail)` and MUST
return an array holding one projection per attachment of `mail.attachments`,
treated as the empty list when absent, in attachment order.

Each projection MUST carry exactly these **ten** fields: `filename`,
`contentType`, `contentDisposition`, `checksum`, `content`, `size`, `headers`,
`contentId`, `cid` and `related`. All but two are copied from the attachment
unchanged.

`content` MUST be the attachment's content encoded as a base64 **string** when
that content is truthy, and the empty string `''` otherwise. `headers` MUST be
the attachment's headers spread into a **new** array, so the projection does not
alias the attachment's own collection.

`getJsonSafeHeaders` MUST have the signature `getJsonSafeHeaders(mail)` and MUST
return `mail.headers` spread into a new array.

`getJsonSafeEmail` MUST have the signature `getJsonSafeEmail(mail)` and MUST
return the mail's own enumerable properties spread first, and MUST then set
`headers` and `attachments` from `getJsonSafeHeaders` and `extractAttachments`,
in that order, so that these two **override** the mail's own same-named
properties rather than merging with them.

## 14. Transport log info

`transportLogInfo` MUST have the signature `transportLogInfo(transport,
guidFromHeaders = true)`.

`transportLogInfo` MUST return the **string** `''` when `transport` is falsy, and
a **log-info object** otherwise. The return type therefore differs by argument,
and callers MUST NOT assume an object: this MUST be preserved as written.

For a truthy transport, `transportLogInfo` MUST build the four values as follows:

* `to` MUST be built from `transport.target` when that is present, as the
  one-element list `[transport.target]`, and from `transport.rcpt_to` otherwise,
  defaulting to the empty list when `rcpt_to` is absent. The target therefore
  takes **precedence** over the recipients rather than being appended to them.
  Each element's `original` MUST be taken and the results joined with `','`.
* `from` MUST be ` from: ` followed by `transport.mail_from.original` when
  `mail_from` is truthy, and the empty string otherwise.
* `id` MUST be ` id: ` followed by the **first** value of the transport's
  `message-id` header when `transport.headers` is present and carries that
  header, and the empty string otherwise. This reads the `message-id` **header**
  from the header map, not the transport's `message_id` field (§2).
* `guid` MUST be §10's `extractGuid` applied to `{transport}`, passing
  `guidFromHeaders` through as its second argument, so a caller can suppress the
  header step of §10's chain.

`id` and `from` MUST carry a **leading space** before their labels, while `to`
and `guid` carry none. The four values are preformatted for concatenation into a
log line, and this asymmetry MUST be preserved as written.

## 15. Tests checklist

The scenarios below cover the claims in this file that are not transcribed
literals or mechanical expansions of them: the field ownership of §2, the ordered
pipelines, the guards, the precedence chains and the projections, each stated so
that a plausible-sounding but wrong description fails it. There is one subsection
per technical section §2–§14; §15.10 carries none, and says so.

### 15.1 The transport object

* A transport built by §6 from an envelope that already carries `mail_from`,
  `rcpt_to` and `headers` properties comes back with those three replaced by the
  values §6 derived, not merged with the envelope's own. This catches a
  description of §6 as "the envelope plus some extra fields", which is false for
  every envelope whose own properties collide with the three §6 writes.
* A transport `envelopeToTransport` has just built **from an envelope carrying
  none of the four** carries no `target`, no `parsed_headers`, no `guid` and no
  `message_id`: §6 writes none of the four, and none of the four is among the
  three fields it overrides, so an envelope that does carry one passes it
  through the spread. `target` and `parsed_headers` are attached later by
  `EmailSorter._getTransportInfo` (`lib/EmailSorter.js`), while `guid` and
  `message_id` are written onto a transport object by **no** symbol under `lib/`
  at all. This catches a description that treats §2's field list as the shape §6
  returns, and one that assumes some symbol in this library puts a `guid` on a
  transport.
* §2's writer column carries a **second** writer for `headers` and for
  `rfc822_headers`, and the second `rfc822_headers` write can replace the value
  §7 produced. A transport that has passed through parsing therefore need not
  carry the values this spec's own symbols wrote. This catches a reader who takes
  the `headers` or `rfc822_headers` a transport carries downstream to be the one
  §6 or §7 built — a distinct failure from the one above, which is about fields
  **absent** at construction rather than a field **present** and later replaced.

### 15.2 Address objects

* `addressToObject` lowercases `original`, `host` and `user` unconditionally, and
  emits `original_host` only when the source address carries one — the key is
  absent, not `undefined`, for an address without it. This catches a description
  that states a fixed four-field result.
* `extractAddress` follows its coercion chain in written order for an array
  argument, a string argument and an object argument, and returns `undefined` for
  an empty array at **both** places one can appear: the argument itself, and the
  result of parsing a string that yields no addresses. This catches a description
  that names only the argument-level guard.
* `extractAddress`'s trailing string branch is unreachable and is specified as
  written rather than dropped. This catches a "simplification" that removes it,
  and pins that its unreachability follows from `addressparser` returning an
  array — not from any check inside `extractAddress`.
* `extractAddress` prefers `source.address` over `source.value` for an object
  argument, returning `value` only when `address` is falsy. This catches a
  description that names either property alone.

### 15.3 Address collection

* `extractAddressObjects` recurses into `Object.values(source)` when the object's
  `address` is absent or is not a string, so a container object holding addresses
  under arbitrary keys is flattened. This catches a description that says the
  function reads `address` and stops.
* `extractAddressObjects` defaults a missing `name` to `''`, while
  `parseAddresses`' own object branch does not — an object reaching that branch
  without a `name` is defaulted downstream rather than at the branch. This
  catches a description that places the default in the wrong function.
* `parseAddresses` dispatches on falsy, array, object and other in that order,
  and every branch except the falsy one passes through `extractAddressObjects`.
  This catches a description that returns the object branch's array directly.
* `getAddressesFromEmail`'s `recipients` de-duplicates **by address string
  alone**, is an array of strings rather than of `{name, address}` objects, and
  excludes `from` and `envelopeFrom`. This catches a description that says
  "all addresses on the email", which is wrong on all three counts.

### 15.4 Header maps

* `headerListToObject` flattens an array value with a spread but appends a scalar
  value whole, so a pair whose value is `['a', 'b']` contributes two entries and
  a pair whose value is `'a'` contributes one. This catches a description that
  says the values are collected, which loses the distinction.
* `headerListToObject` accumulates repeated header names into one array in list
  order, creating the array on first appearance with an own-property check. This
  catches a description in which a repeated name overwrites the earlier value.
* `headersToObject` calls `getDecoded` at most **once per distinct key** and
  takes all of that key's values from the one call, so a key listed three times
  is neither decoded three times nor truncated to its first value. This catches a
  description that decodes per list entry.

### 15.5 Envelope to transport

* An array `envelope.to` is joined with `','` **before** parsing, so the parse
  sees one string rather than being applied per element. This catches a
  description that maps the parser over the array, which differs for any element
  that itself parses to several addresses.
* `mail_from` stays the empty string `''` when `envelope.from` parses to no
  addresses, rather than becoming `undefined` or an address object with empty
  parts. This catches a description promising an address object.
* The envelope is spread **before** `mail_from`, `rcpt_to` and `headers` are
  set, so those three win over same-named envelope properties. This catches an
  implementation that spreads the envelope last.

### 15.6 Email to transport

* `emailToTransport` performs compile, `getEnvelope`, `buildHeaders` and
  `new Headers` in that order, and **replaces** `envelope.headers` with the new
  instance before converting, so the transport's `headers` derive from the
  compiled header string rather than from whatever the envelope carried. This
  catches a description that omits the replacement.
* `rfc822_headers` is attached **only** when the email carries a
  `text/rfc822-headers` attachment, and the key is absent otherwise rather than
  present and empty. This catches a description that always sets the field.

### 15.7 Envelope adjustment

* An envelope whose `interface` is `'bounce'` comes back with `{}` and is
  **unmodified**: no header is removed, added or inspected. This catches a
  description that states the repairs unconditionally.
* An envelope with neither a usable `from` property nor a usable `from` header
  yields `{error}` carrying a **native `Error`** with the message
  `Missing 'from' field in envelope`, not the plain object shape the error
  factory produces. This catches a description that routes the failure through
  that factory.
* An envelope with no usable `from` property but a usable `from` header has
  `envelope.from` filled in from the header, and the header itself is left
  untouched. This catches a description in which the repair also rewrites the
  header it just read.
* The `from` and `reply-to` repairs each **remove** the header and **add** it
  back rather than appending, and the `reply-to` repair adds the `from`
  **header's** extracted address whenever that header yielded one — including on
  an envelope whose `from` property carries a different address — and
  `envelope.from` only when the header yielded nothing. This catches a
  description that adds without removing, which leaves two headers, and one that
  reads the `reply-to` sender as `envelope.from` in both branches.

### 15.8 Guid generation

* `generateGuid` replaces only the **first** `I` and the **first** `l`, because
  both replacements use string patterns. A random part containing two `I`s comes
  back still holding the second. This catches a description that says the
  characters are removed or replaced throughout.
* The canonical guid input is exactly four sender/recipient lines followed by
  four relaxed header lines for `message-id`, `from`, `to` and `subject` in that
  order, joined with CRLF and terminated with a further CRLF. This catches a
  description that reorders the headers or omits the trailing terminator, both of
  which change every guid.
* The buffer is encoded `'binary'`, not `'utf8'`. This catches a description
  omitting the encoding, which silently changes the digest for any non-ASCII
  header value.
* The hash pipeline runs sha512, base64, strip `/+=`, first-occurrence `I`→`T`
  and `l`→`L`, `substr` to `len`, then `padEnd` to `len` with `'d'` — in that
  order. Reordering the strip and the truncation changes the result whenever the
  digest's first `len` characters contain a stripped character. This catches a
  net-effect description such as "a truncated base64 sha512".
* `getRelaxedHeaderLine` applies its line-break replacement **twice** with the
  second call a no-op, coerces a non-array header value to a one-element array,
  and joins values with CRLF after trimming each. This catches a simplification
  that drops the doubled call, and a description that mishandles a scalar value.

### 15.9 Guid extraction

* `extractGuid` follows the precedence `content.guid`, then
  `content.transport.guid`, then `content.transport.target.guid`, then the guid
  header — returning at the first truthy value. A content object carrying a guid
  at two of those places yields the earlier one, while an
  `EmailSorter._getTransportInfo` target contributes no guid unless its address
  object carries such an extra property. This catches a description that names
  the sources without their order, and one that treats the library-written target
  as a named destination.
* `extractGuid` called with `fromHeaders = false` stops **before** the header
  step and returns `undefined` for a transport whose guid is carried only on the
  guid header. This catches a description treating the flag as advisory.
* `extractGuidFromHeaders` accepts an array guid header only when it has exactly
  one element, so a header appearing twice yields `undefined` rather than the
  first value. This catches a description that says the first value is taken.

### 15.10 Message identifiers

Nothing derived here. `generateMessageId` is a single template literal whose
parts are transcribed literals, so §11 states it without a scenario.

### 15.11 Embedded RFC 822 content

* `getRfc822Headers` and `getRfc822Message` each select the **first** attachment
  matching their exact content type and return `undefined` when none matches, so
  a second matching attachment is never considered. This catches a description
  that merges matches or that returns an empty value instead of `undefined`.
* `getRfc822Message` re-parses the attachment with `simpleParser` and `Iconv` and
  returns the **JSON-safe projection** of that parse, not the raw parsed mail.
  This catches a description that returns the parse result, whose `headers` is a
  map rather than an array and does not survive `JSON.stringify`.

### 15.12 JSON-safe forms

* `extractAttachments` emits exactly the **ten** fields §13 names, with `content`
  a base64 string or `''` for an attachment with no content. This catches a
  description that says the attachment is copied, and one that leaves `content`
  as a buffer — which is the whole point of the projection.
* Each projection's `headers` is a **new** array spread from the attachment's
  own, so mutating the projection does not reach the attachment. This catches a
  description that assigns the collection through.
* `getJsonSafeEmail` sets `headers` and `attachments` **after** spreading the
  mail, so its two projections win over the mail's own same-named properties.
  This catches an implementation that spreads the mail last and silently returns
  the unprojected values.

### 15.13 Transport log info

* `transportLogInfo` returns the string `''` for a falsy transport and a
  `{id, guid, to, from}` object otherwise. This catches a description promising
  an object, which is false for every falsy-transport call and breaks any caller
  that reads a property off the result.
* `transport.target` takes **precedence** over `rcpt_to` — a transport carrying
  both yields the target alone, not both joined — and `rcpt_to` defaults to the
  empty list when absent. This catches a description that concatenates the two.
* `id` and `from` carry a leading space before their labels while `to` and `guid`
  carry none, and `id` reads the `message-id` **header** rather than the
  transport's `message_id` field. This catches a description that normalizes the
  spacing, and one that conflates the header with the field.
