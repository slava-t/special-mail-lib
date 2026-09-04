# Routing Headers Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the routing and special header-name constants, the module-level lists
that group them, and the helpers that detect, copy, encode and decode the
routing decisions a message carries on its own headers. The eighteen exported
symbols specified here are exactly the `lib/util.js` rows whose home spec is this
file in [overview.md §3]; three unexported bindings of the same module,
`specialHeaders`, `routingHeaders` and `specialHeadersSet`, are specified with
them because the exported symbols cannot be described without them. Every other
symbol in that module belongs to another spec and is out of scope (§1.2).

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here — this file uses
**Direct routing** and **Guid** as that glossary defines them, and **header map**
as [transport-model.md §0] defines it, which is the representation §5, §7, §8 and
§9 all read.

* **Special header**: a header whose name is a member of the special-header list
  (§3). A message carrying one is *special* in the sense §4 tests.
* **Routing header**: a header whose name is a member of the routing-header list
  (§3) — the special headers together with the guid header. These are the headers
  §5 copies.
* **Header pair list**: a list whose elements are `[name, value]` pairs, as §4
  reads them. It is not a header map: a pair list preserves the order and the
  original case of each name and may carry the same name more than once, where a
  header map keys by name and collects that name's values into one array. §4 is
  the only symbol here that takes a pair list; §5, §7, §8 and §9 all take header
  maps.
* **Direct routing config**: the object §10 specifies, mapping a config name to
  the `headers` and `auth` that apply under it.
* **Config name**: the value of the direct-routing config header, used as the key
  into a direct routing config.
* **JSON64**: the encoding §6 defines — JSON serialization followed by base64
  encoding — by which a structured value is carried on a single header.

## 1. Goals and non-goals

### 1.1 Goals

* Specify the eleven header-name constants with their exact values, and for each
  one, every symbol under `lib/` that reads a header by it.
* Specify the two module-level lists and the set derived from one of them: their
  members, their order, and which constants are **not** members.
* Specify special-header detection and routing-header copying, including the
  respects in which the two disagree.
* Specify the JSON64 encoding pair and the direct-MX header reader built on it.
* Specify the two direct-routing readers — the post-request reader and the
  notify-request reader — as written, including the branch structure that decides
  which fields their results carry.
* Specify the shape of the direct routing config as these readers consume it.

### 1.2 Non-goals

* The header representations themselves. This file specifies how its symbols
  *read* a header map and a header pair list; the helpers that build a header map
  — `headerListToObject`, `headersToObject` and `headerLinesToObject` — are
  [transport-model.md §5]'s.
* Configuration loading. §10 specifies the *shape* consumed here;
  [config-and-resolvers.md §8] owns loading it, and [config-and-resolvers.md §11]
  owns `fetchRoutingInfo`'s use of the dynamic-routing header.
* The callers. What `lib/jobs/EmailParsingJob.js` does with §9's result belongs
  to [jobs.md §4] and [jobs.md §5]. What `lib/jobs/RoutingJob.js` does with the
  results of §8 and §9 belongs to [routing.md §4], [routing.md §7] and
  [routing.md §8].
* The `destination` object's own contract. §5 requires a call to
  `update(name, value)` on the object it is handed; what implements that method
  is not this file's.
* The base64 and merge libraries' internals. [overview.md §4] pins the dependency
  set; this file names only which behavior of each it relies on.

## 2. Header-name constants

`lib/util.js` MUST declare the eleven header-name constants below, each with the
exact value given, and MUST export all eleven.

The **Read by, under `lib/`** column names every symbol that reads a header
**through that constant**. Its axis is the identifier, not the header name: where
two constants hold the same string, a symbol reading that string through the
other identifier is not an entry here.

| Constant | Value | Read by, under `lib/` |
|----------|-------|-----------------------|
| `DIRECT_CONFIG_HEADERNAME` | `x-debuggex-direct-routing-config` | `getDirectPostRequestRouting` (§8), `getDirectNotifyRequestRouting` (§9) |
| `DIRECT_POST_URL_HEADERNAME` | `x-debuggex-direct-routing-post-url` | `getDirectPostRequestRouting` (§8) |
| `DIRECT_FORWARD_URL_HEADERNAME` | `x-debuggex-direct-routing-post-url` | Read by no symbol under `lib/` through this constant. |
| `DIRECT_NOTIFY_URL_HEADERNAME` | `x-debuggex-direct-routing-notify-url` | `getDirectNotifyRequestRouting` (§9) |
| `DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME` | `x-debuggex-direct-dynamic-routing-url` | `fetchRoutingInfo` (`lib/util.js`), whose behavior [config-and-resolvers.md §11] owns |
| `JSON64_DIRECT_MX` | `x-debuggex-json64-direct-mx` | `getMxFromHeaders` (§7) |
| `JSON64_DATA_HEADERNAME` | `x-postboy-json64-data` | Read by no symbol under `lib/` through this constant. |
| `MOMENT_POST_URL_HEADERNAME` | `x-momentcrm-mail-post-to-url` | Read by no symbol under `lib/` through this constant. |
| `MOMENT_NOTIFY_URL_HEADERNAME` | `x-momentcrm-notification-post-to-url` | Read by no symbol under `lib/` through this constant. |
| `MOMENT_ROUTING_RESPONSE_HEADERNAME` | `x-momentcrm-mail-routing-response` | Read by no symbol under `lib/` through this constant. |
| `GUID_HEADERNAME` | `x-debuggex-guid` | `extractGuidFromHeaders` (`lib/util.js`), specified in [transport-model.md §10] |

`DIRECT_POST_URL_HEADERNAME` and `DIRECT_FORWARD_URL_HEADERNAME` MUST hold the
**same** string, `x-debuggex-direct-routing-post-url`. This MUST be preserved as
written. There is therefore no distinct forward-URL header on the wire: a
consumer MUST NOT treat forwarding as separately addressable by header name, and
a message carrying that header is indistinguishable from one carrying the
post-URL header.

Five of the eleven constants are read by no symbol under `lib/` through the
constant itself: `DIRECT_FORWARD_URL_HEADERNAME`, `JSON64_DATA_HEADERNAME` and
the three `MOMENT_*` constants. Four of those five appear under `lib/` only in
their declarations, the list literals of §3, and the module's export surface.
The fifth, `DIRECT_FORWARD_URL_HEADERNAME`, appears in neither list literal (§3),
so it is reached only by its declaration and its export — though the header
**name** it holds is read, through `DIRECT_POST_URL_HEADERNAME`, by §8. All five
MUST nonetheless be exported: they are part of the library's published contract
for consumers that set these headers on outgoing messages.

The two symbols in the table that are not specified in this file —
`fetchRoutingInfo` and `extractGuidFromHeaders` — are both inside `lib/util.js`.
This spec is the authority on the constants they read, not on what they do with
them.

## 3. The special-header and routing-header lists

`lib/util.js` MUST declare three module-level bindings that group the constants
of §2. All three are module-internal: they MUST be exposed by **no** export of
`lib/util.js`, so a consumer cannot read or modify the lists directly and reaches
their content only through §4 and §5.

`specialHeaders` MUST be the list of exactly these **eight** constants, in this
order:

1. `DIRECT_CONFIG_HEADERNAME`
2. `DIRECT_POST_URL_HEADERNAME`
3. `DIRECT_NOTIFY_URL_HEADERNAME`
4. `DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME`
5. `JSON64_DATA_HEADERNAME`
6. `MOMENT_POST_URL_HEADERNAME`
7. `MOMENT_NOTIFY_URL_HEADERNAME`
8. `MOMENT_ROUTING_RESPONSE_HEADERNAME`

`routingHeaders` MUST be `specialHeaders` followed by `GUID_HEADERNAME`, giving
**nine** entries in that order, and MUST contain no other member. It is the list
§5 iterates.

`specialHeadersSet` MUST be the set of `specialHeaders`' members — the eight
above, and not the guid header. It is what §4 tests membership against.

Each of the three is a **module-level binding of `lib/util.js`**. `routingHeaders`
in particular MUST be understood as that binding: the same name is also read as a
property of an environment object elsewhere in that file, in a symbol this spec
does not specify, and the bare name therefore does not identify one thing.

Two constants of §2 are **absent from both lists** — from `specialHeaders` and
from `routingHeaders` alike — **as a constant reference**, and the consequence
differs between them because they differ on the value axis:

* `JSON64_DIRECT_MX` is absent from **both lists as a constant reference and as a
  value**: no entry of either list holds the string
  `x-debuggex-json64-direct-mx`. A message carrying only the direct-MX header is
  therefore **not** special under §4 and its header is **not** copied by §5 —
  although §7 still decodes that header, which is a requirement of its own.
* `DIRECT_FORWARD_URL_HEADERNAME` is absent from **both lists as a constant
  reference only**. The header name it holds is `DIRECT_POST_URL_HEADERNAME`'s
  string (§2), which is the **second** entry of both lists, so on the value axis
  that header name **is** a member. A message carrying the forward-URL header
  therefore **is** special under §4 and **is** copied by §5. A consumer MUST NOT
  read the identifier's absence from the lists as meaning the header it names is
  not routed.

Both absences MUST be preserved as written.

## 4. Special-header detection

`hasSpecialHeaders` MUST have the signature `hasSpecialHeaders(mail)` and MUST
return a boolean.

`hasSpecialHeaders` MUST read `mail.headers` as a **header pair list**, treating
a falsy value as the empty list, and MUST iterate that list taking element `[0]`
of each entry as the header name.

For each name, `hasSpecialHeaders` MUST **lowercase** the name and test that
lowercased form for membership of `specialHeadersSet` (§3). Detection is
therefore case-insensitive on the header name: a header written
`X-Debuggex-Direct-Routing-Config` is detected exactly as the lowercase form is.

`hasSpecialHeaders` MUST return `true` at the **first** entry whose lowercased
name is a member, without examining the remaining entries, and MUST return
`false` when no entry matches. It reads only the name: an entry's value plays no
part in the test.

Because the set is `specialHeadersSet` and not `routingHeaders`, a message whose
only routing header is the guid header is **not** special (§3, §5).

## 5. Routing-header copying

`copyRoutingHeaders` MUST have the signature
`copyRoutingHeaders(source, destination)` and MUST return nothing. It
communicates its result solely through calls on `destination`.

`copyRoutingHeaders` MUST iterate `routingHeaders` (§3) **in list order** and, for
each name in turn, MUST read `source[name]`. `source` is therefore consumed as a
**header map**, not as a header pair list, and the read is an exact-key lookup:
the name is used in the constant's own case, with **no** lowercasing. A source key
differing from the constant in case is not found, which is the respect in which
copying is stricter than the detection of §4.

Iteration is over `routingHeaders` and not `specialHeaders`, so the guid header
**is** copied although it is not special.

For each name, `copyRoutingHeaders` MUST skip a falsy value, and MUST otherwise
call `destination.update(name, value[0])` — the name in the constant's own case,
and **only the first element** of the value. A header carried in the source with
more than one value therefore reaches the destination with its later values
dropped.

Neither argument is guarded. A `source` of `undefined` or `null` raises a
`TypeError` on the first read rather than copying nothing, and `destination` is
reached only when a value is found, so a `destination` that cannot take an
`update` call raises only for a source carrying at least one routing
header **with a truthy value**. A caller that must tolerate either MUST guard
the call itself.

The order of the calls MUST be the list order of `routingHeaders`; a caller
observing `destination` between calls sees the headers arrive in that order. What
`update` does with each pair is `destination`'s own contract (§1.2).

## 6. JSON64 encoding and decoding

`toJson64` MUST have the signature `toJson64(data)` and MUST return the base64
encoding of `JSON.stringify(data)`, in that order: serialize, then encode.

`fromJson64` MUST have the signature `fromJson64(data)` and MUST return
`JSON.parse` applied to the base64 decoding of its argument, in that order:
decode, then parse.

Base64 encoding and decoding MUST be performed by `js-base64`, which
[overview.md §4] pins as a dependency of `lib/util.js`.

Neither symbol guards its input, and neither catches a failure of the step it
delegates to. A value `JSON.stringify` cannot serialize surfaces that failure out
of `toJson64`; an argument whose decoded text is not valid JSON surfaces
`JSON.parse`'s `SyntaxError` out of `fromJson64`. In particular a decode that
succeeds followed by a parse that fails is reported as a parse failure, not as
`undefined` and not as a decoding error. A caller that must tolerate malformed
input MUST guard the call itself.

The two are inverses over any value `JSON.stringify` and `JSON.parse` round-trip:
`fromJson64(toJson64(x))` yields a value equal to `x` for such `x`.

## 7. Direct MX from headers

`getMxFromHeaders` MUST have the signature `getMxFromHeaders(headers)` and MUST
return either the decoded direct-MX value or `undefined`.

`getMxFromHeaders` MUST read `headers[JSON64_DIRECT_MX]` from a **header map**
(§2, §0) and MUST return `undefined` when that value is falsy — the case of a
message that does not carry the header.

`headers` itself is not guarded. That `undefined` is the falsy-**value** case,
not a falsy-argument case: a `headers` of `undefined` or `null` raises a
`TypeError` rather than yielding `undefined`, and a caller that must tolerate one
MUST guard the call itself.

When the value is present, `getMxFromHeaders` MUST return `fromJson64` (§6)
applied to its **first** element. A direct-MX header carried with more than one
value therefore contributes only its first; the remaining values are not decoded.

The returned value is the **parsed** result of §6, not the header text: a caller
receives the structure the sender encoded, and any decoding or parsing failure
surfaces out of this call as §6 specifies.

The direct-MX header is decoded here even though `JSON64_DIRECT_MX` is a member
of neither list of §3, so a message carrying only that header is not special and
its header is not copied.

## 8. Direct post request routing

`getDirectPostRequestRouting` MUST have the signature
`getDirectPostRequestRouting(request, options)` and MUST return a routing result
object.

`options` has **no default**. A call made with one argument therefore raises a
`TypeError` on the first statement, and this MUST be preserved as written; §9's
reader defaults its own options and does not share this behavior.

`getDirectPostRequestRouting` MUST read `options.headers` as a **header map**,
treating a falsy value as `{}`, and MUST build its result as follows.

1. The post-URL header name MUST be taken from `DIRECT_POST_URL_HEADERNAME` (§2)
   into a local binding, and the body of the function MUST be guarded on that
   binding being truthy. Since the constant is a non-empty string, **the guard is
   always true**. It MUST be preserved as written.
2. Within that guard, when `headers[DIRECT_POST_URL_HEADERNAME]` is present,
   `url` MUST be set on the result to its **first** element. When the header is
   absent, `url` MUST NOT be set.
3. Still within that guard — and **whether or not** step 2 set `url` — the config
   name MUST be read from `headers[DIRECT_CONFIG_HEADERNAME]` and the direct
   routing config taken from `options.directRoutingConfig`, treating a falsy
   value as `{}`.
4. When the config name is present, the config entry MUST be looked up by its
   **first** element and `headers` and `auth` MUST be set on the result from that
   entry, each defaulting to `{}` when the entry omits it **or carries a falsy
   value for it** (§10). When the config name is absent, neither field MUST be
   set.

Because step 3 sits under the always-true guard of step 1 rather than under the
URL-present branch of step 2, the config lookup runs even for a message carrying
**no** post-URL header. A result may therefore carry `headers` and `auth` with no
`url`, and — from the other direction — a message carrying the post-URL header
but no config-name header yields a result carrying `url` alone, with neither
`headers` nor `auth` set.

The lookup of step 4 is **unguarded against an absent entry**: a config name that
names no entry of the direct routing config raises a `TypeError` rather than
falling back to a default. This MUST be preserved as written.

Finally, when `request` is truthy, `getDirectPostRequestRouting` MUST return
`merge(true, request, result)` — a **new** object, leaving `request` unmodified,
with the result's fields taking precedence on conflict. When `request` is falsy,
it MUST return the bare result. `merge`'s deep-merge rules beyond the
first-argument clone are the library's own, and are not specified here (§1.2).

## 9. Direct notify request routing

`getDirectNotifyRequestRouting` MUST have the signature
`getDirectNotifyRequestRouting(options = {})` and MUST return a routing result
object.

`options` **defaults to `{}`**, so a call with no argument is tolerated and
returns the empty result. This is the respect in which this reader differs from
§8's, which leaves the same parameter undefaulted.

`getDirectNotifyRequestRouting` MUST read `options.headers` as a **header map**,
treating a falsy value as `{}`, and MUST build its result as follows.

1. The notify URL MUST be read from `headers[DIRECT_NOTIFY_URL_HEADERNAME]`
   (§2). When it is falsy, the result MUST be `{}` — with **no** config lookup
   attempted — and MUST be returned as such.
2. When it is present, `directNotificationUrl` MUST be set on the result to its
   **first** element.
3. **Nested inside** that same branch, the config name MUST be read from
   `headers[DIRECT_CONFIG_HEADERNAME]` and the direct routing config taken from
   `options.directRoutingConfig`, treating a falsy value as `{}`.
4. When the config name is present, the config entry MUST be looked up by its
   **first** element and `directNotificationHeaders` and `directNotificationAuth`
   MUST be set on the result from that entry's `headers` and `auth`, each
   defaulting to `{}` when the entry omits it **or carries a falsy value for
   it** (§10). When the config name is absent, neither field MUST be set.

Because step 3 is nested inside the URL-present branch, this reader — unlike §8's
— performs **no** config lookup for a message carrying no notify-URL header, and
cannot return a result carrying notification headers without a notification URL.
A message carrying the notify-URL header but no config-name header yields a
result carrying `directNotificationUrl` alone.

The lookup of step 4 is **unguarded against an absent entry** here too: a config
name that names no entry raises a `TypeError`. This MUST be preserved as written.

The three result fields MUST be named `directNotificationUrl`,
`directNotificationHeaders` and `directNotificationAuth`. The result is returned
as built, with no merge into a caller-supplied object.

## 10. The direct routing config

A direct routing config is a plain object keyed by **config name**, whose value
for each name is that name's entry. It reaches §8 and §9 as
`options.directRoutingConfig`, and a falsy value is treated as `{}` by both.

An entry MUST be an object that MAY carry `headers` and MAY carry `auth`:

| Field | Type | Consumed as |
|-------|------|-------------|
| `headers` | object | The outgoing request headers that apply under this config name. Defaults to `{}` when the entry omits it or carries a falsy value for it. |
| `auth` | object | The outgoing request authentication that applies under this config name. Defaults to `{}` when the entry omits it or carries a falsy value for it. |

Each field defaults **per field**, and on a **falsy** value rather than on an
absent key: an entry present but carrying neither field yields `{}` for both, an
entry carrying a truthy value for one yields that one and `{}` for the other, and
a field carrying `null` — or any other falsy value — yields `{}` exactly as an
omitted field does. This defaulting is what the readers apply; it does not
require the entry itself to be well-formed beyond being an object.

The same entry is read differently by the two readers. §8 sets its `headers` and
`auth` onto the result under those names; §9 sets them under
`directNotificationHeaders` and `directNotificationAuth`. No other key of an
entry is read by either reader, so an entry carrying further keys contributes
nothing through them.

Neither reader checks that a named entry exists before reading these fields, so a
config name naming an absent entry raises rather than yielding the defaults above
(§8, §9). The defaults apply to a **missing or falsy field of a present entry**,
never to a missing entry.

The config is loaded from `direct-routing.yaml`. This spec specifies only the
shape as the two readers consume it; [config-and-resolvers.md §8] owns the
loading, the path resolution and the parsing.

## 11. Tests checklist

The scenarios below cover the claims in this file that are not transcribed
literals or mechanical expansions of them: the constants' shared value and their
reader map, the list memberships and the absences, the guards, the branch
structure of the two routing readers and the defaulting they apply. Each is
stated so that a plausible-sounding but wrong description of the behavior fails
it. There is one subsection per technical section §2–§10, and none is empty.

### 11.1 Header-name constants

* `DIRECT_POST_URL_HEADERNAME` and `DIRECT_FORWARD_URL_HEADERNAME` compare equal:
  both are `x-debuggex-direct-routing-post-url`. This catches a description that
  treats forwarding as separately routable by header name, and any consumer that
  sets one expecting it to be distinguishable from the other.
* `DIRECT_FORWARD_URL_HEADERNAME` is read **through that identifier** by no
  symbol under `lib/`, and exists as an export only — while the header name it
  holds *is* read, through the identifier it shares that string with, by §8. This
  catches a reader who takes an unread identifier for an unread header.
* The behavior of the two symbols that read `DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME`
  and `GUID_HEADERNAME` is specified **outside this spec's symbol range** —
  `extractGuidFromHeaders` in [transport-model.md §10], `fetchRoutingInfo` in
  [config-and-resolvers.md §11] — though both are inside `lib/util.js`. This catches
  a reader who takes this spec for the contract of everything §2's table names.

### 11.2 The special-header and routing-header lists

* `specialHeaders` has exactly **eight** entries, in the order §3 gives. This
  catches a description that adds the guid header to it, which is the list §5
  uses rather than this one.
* `routingHeaders` is those eight **plus** the guid header, in that order, and is
  a superset by no other member. This catches a description that treats the two
  lists as interchangeable.
* `DIRECT_FORWARD_URL_HEADERNAME` and `JSON64_DIRECT_MX` are each **absent from
  both lists as a constant reference**, and this means opposite things for the
  two: a message carrying only the direct-MX header is **not** special and is not
  copied, although §7 still decodes that header, while a message carrying the
  forward-URL header **is** special and **is** copied, because the string that
  constant holds is `DIRECT_POST_URL_HEADERNAME`'s and is in both lists. This
  catches the reader who takes identifier-level absence to mean the header itself
  is not routed.
* `specialHeaders`, `routingHeaders` and `specialHeadersSet` are exposed by **no**
  export of `lib/util.js`. This catches a consumer that expects to read or extend
  the lists directly rather than through §4 and §5.

### 11.3 Special-header detection

* `hasSpecialHeaders` called with a mail carrying no `headers` property returns
  `false` rather than raising: the falsy value is treated as the empty list.
* The name tested is element `[0]` of each pair, not the pair and not its value.
  This catches an implementation that tests entries whole against the set.
* A header written `X-Debuggex-Direct-Routing-Config` is detected: the name is
  **lowercased** before the membership test. This catches a description of
  detection as an exact-key test, which is what §5's copying actually is.
* A mail whose only routing header is the guid header is **not** special, and
  detection returns at the **first** matching entry without examining the rest.
  This catches a description that tests `routingHeaders` rather than
  `specialHeadersSet`.

### 11.4 Routing-header copying

* Iteration is over `routingHeaders`, so a source carrying only the guid header
  still produces one `update` call: the guid header **is** copied though it is not
  special. This catches a description that copies the special headers only.
* A source whose value for a routing header is falsy produces no `update` call for
  that name, and iteration continues to the remaining names.
* Only element `[0]` of the value is passed, so a source carrying a routing header
  with two values reaches the destination with the second dropped.
* The name passed to `update` is the constant's own case and the source is read at
  that exact key, with **no** lowercasing: a source keyed
  `X-Debuggex-Guid` is not found. This catches the assumption that §4's
  case-insensitivity applies here.
* `copyRoutingHeaders` returns nothing, communicating only through
  `destination.update`. This catches a caller that expects a copied header map
  back.

### 11.5 JSON64 encoding and decoding

* `fromJson64` applied to a base64 string whose decoded text is not JSON surfaces
  the `SyntaxError` from `JSON.parse` rather than returning `undefined`. This is
  the failure a decode-then-parse description hides.
* `toJson64` applied to a value `JSON.stringify` cannot serialize surfaces that
  failure rather than guarding it, so §6's no-guard claim is checked in **both**
  directions.
* `toJson64` and `fromJson64` round-trip a value: `fromJson64(toJson64(x))` equals
  `x` for any `x` that `JSON.stringify` and `JSON.parse` round-trip. This catches
  a mismatch in encoding direction between the pair.

### 11.6 Direct MX from headers

* `getMxFromHeaders` returns `undefined` for a header map not carrying the
  direct-MX header, rather than raising or returning an empty value.
* A direct-MX header carried with two values has only its **first** decoded; the
  second is not decoded and does not appear in the result.
* The value returned is the **parsed** structure, not the decoded text and not the
  header value. This catches a description that stops at the base64 decoding.

### 11.7 Direct post request routing

* The `if (headername)` guard is **always** true, because the binding it tests is
  a non-empty module constant. It is preserved as written, and no input reaches
  the function that makes the guard fail.
* A call whose `options` carries no `headers` proceeds with `{}` rather than
  raising, and returns a result carrying neither `url` nor the config fields.
* `url` is set only when the post-URL header is present, and is set to its
  **first** element. A header carried with two values contributes only the first.
* The config lookup happens **whether or not** the post-URL header was present:
  a call carrying a config-name header but no post-URL header returns a result
  carrying `headers` and `auth` with **no** `url`. This catches a description
  that nests the lookup inside the URL-present branch, which is what §9 does.
* The lookup is itself guarded on the config-name header, so a call carrying the
  post-URL header but **no** config-name header returns `url` alone, with neither
  `headers` nor `auth` set.
* A config-name header naming an entry that is **absent** from the direct routing
  config raises a `TypeError` rather than defaulting to `{}`. This catches a
  description that reads the `{}` defaults as covering a missing entry.
* `headers` and `auth` each default to `{}` when the named entry **exists but
  omits them**, including the case where the entry carries one and not the other,
  and equally when the entry carries a **falsy** value such as `null` for one of
  them. This is the missing-field and falsy-field case, which the raising
  scenario above does not reach; the falsy half catches a defaulting that fires
  only on an absent key.
* A truthy `request` is merged into a **new** object by `merge(true, …)`, leaving
  the caller's `request` unmodified and letting the result's fields win on
  conflict; a falsy `request` yields the bare result. This catches an
  implementation that mutates `request` in place.

### 11.8 Direct notify request routing

* A call whose headers carry no notify-URL header returns `{}` with **no** config
  lookup attempted — even when a config-name header is present. This catches a
  description that shares §8's flat branch structure.
* A call made with **no argument** is tolerated and returns `{}`, because
  `options` defaults to `{}`. This catches a description that gives §8's reader
  the same default; §8's raises here.
* The three result fields are named `directNotificationUrl`,
  `directNotificationHeaders` and `directNotificationAuth`, not the flat `url`,
  `headers` and `auth` that §8 sets from the same config entry.
* `directNotificationHeaders` and `directNotificationAuth` each default to `{}`
  when the named entry omits them **or carries a falsy value for them**, matching
  §8's per-field defaulting.
* The config lookup is guarded on the config-name header here too, so a call
  carrying the notify-URL header but no config-name header returns
  `directNotificationUrl` alone.
* A config-name header naming an absent entry raises a `TypeError` here too,
  rather than yielding the defaults.

### 11.9 The direct routing config

* An entry carrying keys beyond `headers` and `auth` contributes nothing through
  them: both readers read only those two. This catches a description that passes
  the entry through whole.
* The same entry read by §8 and by §9 produces differently named fields — flat
  `headers` and `auth` against the `directNotification*` names — so a result
  cannot be interpreted without knowing which reader produced it.
