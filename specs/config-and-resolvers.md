# Config and Resolvers Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers configuration loading, the two resolver classes, routing-config parsing,
and the environment, mail-server and routing-info lookups built on them. The
eight exported symbols specified here are exactly the rows whose home spec is
this file in [overview.md §3]: `config`, `DomainNameResolver`,
`EnvironmentResolver`, `parseRoutingConfig`, `getMailServers`, `getEnvironment`,
`fetchRoutingInfo` and `createResolvers`. Seven class members reached only
through two of those rows — `DomainNameResolver`'s `constructor`,
`getRouteCount`, `resolve`, `canSolve` and `createUrl`, and
`EnvironmentResolver`'s `constructor` and `resolve` — and one unexported inner
function, `parseRoutingConfig`'s `combine`, are specified with them because the
exported symbols cannot be described without them. This file also specifies the
shapes of the three configuration files these symbols read (§12).

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here; this file uses
**header map** as [transport-model.md §0] defines it, and **direct routing
config** and **config name** as [routing-headers.md §0] defines them.

* **Config directory**: the directory passed to `createResolvers` (§8), holding
  the three configuration files that function reads by fixed name.
* **Resolver config**: the parsed contents of `domain-resolver.yaml` — the object
  `DomainNameResolver`'s constructor consumes (§3), whose shape §12 specifies.
* **Routing config**: the parsed contents of `routing.yaml`. The term names two
  distinct forms, and every requirement in this file that depends on the
  difference says which it means: the **raw** form, as the YAML parser returns
  it, and the **parsed** form, which is the raw form after §7 has combined the
  common fields into each environment entry.
* **Environment entry**: a value of the routing config's `environments` map,
  keyed by environment name. §12 specifies its fields.
* **Route**: an element of a `routes` list in either the resolver config or the
  routing config. Both kinds carry a `domain` pattern; a resolver-config route
  additionally carries a `target`, and a routing-config route an `env`.
* **Domain pattern**: a route's `domain` value before compilation — a string that
  §3 and §6 each turn into a regular expression, by rules that differ (§3, §6).
* **Resolver result**: the object `DomainNameResolver`'s `resolve` returns for a
  matched domain (§4), and the object `createUrl` extends (§5).

## 1. Goals and non-goals

### 1.1 Goals

* Specify the configuration loader, including the directory its paths resolve
  against and the errors it does not catch.
* Specify both resolver classes as written: their constructors' defaulting and
  validation, the two different pattern-compilation rules, and the resolution
  each performs.
* Specify URL construction on a resolver result, and the respect in which it
  differs from URL joining elsewhere in the library.
* Specify routing-config parsing, including what the result carries that the
  input did not.
* Specify the environment, mail-server and routing-info lookups, and for each
  one, which form of the routing config its stated behavior holds over.
* Specify the shapes of the three configuration files as the symbols under
  `lib/` consume them.

### 1.2 Non-goals

* The consumption of the direct routing config. §12 specifies loading it and its
  file shape; what the two readers do with an entry is [routing-headers.md §8]'s
  and [routing-headers.md §9]'s.
* The HTTP and YAML libraries' internals. §11 names the client and the direction
  of the call; §2 and §8 name the parser. [overview.md §4] pins both as
  dependencies; neither library's own error shapes, retries or grammar are
  specified here.
* What the queue and the jobs do with a resolved environment. §9 returns the
  entry; [job-queue.md §13], [jobs.md §7], [routing.md §5],
  [routing.md §6] and [routing.md §7] own the uses.
* DKIM, SPF and MX verification. §12's table names `dkimSelector`, `spfInclude`
  and `mailServers` and the symbols that read them; `domain-verification.md` and
  `mx-verification.md` own what those readers do.
* The `destination`, transport and header-map contracts. §11 hands a transport to
  the HTTP client; [transport-model.md §2] owns its shape.
* The consumer-side configuration files themselves. This file specifies their
  shapes as the readers under `lib/` consume them, not the values any deployment
  sets in them.

## 2. Configuration loading

`lib/config.js` MUST export a single function as the module's value. It takes one
optional argument:

```
config(configPath = '/moment/env/env.yaml')
```

The function MUST resolve `configPath` against **`__dirname`** — the directory of
`lib/config.js` inside the installed package — read the resolved path
synchronously as `utf8`, parse the contents as YAML, and return the parsed value.

Resolution against `__dirname` rather than the process working directory has a
consequence the caller MUST account for: a **relative** `configPath` resolves
inside the package directory, not against the caller's working directory. The
default is absolute, so the default path is unaffected by this rule and refers to
`/moment/env/env.yaml` as written.

The function MUST NOT catch. It contains no `catch`, so a missing file, an
unreadable file or malformed YAML propagates the underlying error to the caller
unchanged. A caller that needs a missing configuration file to be recoverable
MUST handle the error itself.

## 3. The domain-name resolver

`DomainNameResolver` MUST be exported as a class. Its constructor takes the
resolver config (§12) and MUST perform the following, in order.

**Retain the raw config.** The constructor MUST retain the object it was given,
unmodified, as the instance's `config`.

**Apply the instance-level defaults.** Five fields are read from the config onto
the instance, each defaulting on a **falsy** value rather than on an absent key:

| Instance field | Source | Default |
|----------------|--------|---------|
| `proto` | `config.proto` | `https` |
| `port` | `config.port` | **none** — the value is taken as given, so a falsy or absent `port` stays falsy |
| `uri` | `config.uri` | `''` |
| `notificationUri` | `config.notificationUri` | `''` |
| `headers` | `config.headers` | `{}` |

`port` MUST NOT be defaulted. It is the only one of the five without a default,
and §5 depends on that: a falsy `port` is what suppresses the port segment of a
constructed URL.

**Compile the routes.** The constructor MUST iterate `config.routes` **without**
a fallback for an absent list. A resolver config carrying no `routes` therefore
raises a `TypeError` on construction rather than yielding a resolver with no
routes. This differs from §6, whose loop does provide a fallback.

For each route, in order:

1. If the route has no truthy `target`, the constructor MUST raise an `Error`
   whose message is exactly `A route without a target found.`
2. If the route has no truthy `domain`, the constructor MUST raise an `Error`
   whose message is exactly `A route without a domain found.`
3. The route's `domain` MUST be compiled to a regular expression by the
   **anchoring** rule: a pattern that both starts with `^` and ends with `$` is
   compiled as written; any other pattern is escaped and then wrapped so that the
   compiled expression is `^`, the escaped pattern, `$`. The escape applies to
   the characters `- / \ ^ $ * + ? . ( ) | [ ] { }`.
4. The expression MUST be compiled with the flags `gi`, making matching
   case-insensitive.
5. The compiled route MUST be pushed as the source route's own fields, with
   `domain` replaced by the compiled expression and `target` restated.

The order of the two validation checks is part of the contract: a route missing
both fields reports the **target**, never the domain.

## 4. Domain-name resolution

`resolve(domain)` MUST return a resolver result for the first matching route, or
nothing.

A falsy `domain` MUST skip the route loop entirely. It does not skip the
`defaultTarget` branch below.

For each route, in index order, the method MUST perform the following before
testing the match:

* read the route's own `uri`, falling back to the instance `uri` on a falsy
  value;
* read the route's own `notificationUri`, falling back to the instance
  `notificationUri` on a falsy value.

Both fallbacks are computed for **every route the loop visits**, including routes
that do not match. This is unconditional work, and a consumer MUST NOT rely on
the fallbacks being evaluated only for the matching route.

The match test is `domain.match(re)` against the compiled expression. Because the
expression carries the `g` flag and neither this method nor §6's resets
`lastIndex`, the question of statefulness arises; the required behavior is that
**repeated calls with the same argument produce the same result**. String
matching with a global expression restarts from the beginning and ignores
`lastIndex`, so no reset is needed and none MUST be added on the assumption that
one is.

On a match, the result MUST carry exactly:

| Field | Value |
|-------|-------|
| `index` | the matched route's index in the route list |
| `target` | the argument with the compiled expression replaced by the route's `target`, so capture groups in the pattern substitute into the target |
| `proto` | the route's `proto`, falling back to the instance value on a falsy value |
| `port` | the route's `port`, falling back to the instance value on a falsy value |
| `headers` | the route's `headers`, falling back to the instance value on a falsy value |
| `uri` | the value resolved above |
| `notificationUri` | the value resolved above |

`target` is produced by a replace against the same compiled expression, which is
the second global-expression use on that object; it is stable across repeated
calls for the same reason the match is.

**The `defaultTarget` branch.** If no route matched — or if the loop was skipped
— and the instance has a truthy `defaultTarget`, `resolve` MUST return a result
whose `index` is `-1` and whose `target` is that `defaultTarget`, with `proto`,
`port`, `headers`, `uri` and `notificationUri` taken from the instance.

`defaultTarget` is read at three sites in this class and is **assigned at no site
under `lib/`**, on the axis of assignment and scoped to the whole library: the
constructor (§3) does not copy it from the resolver config, and nothing else
writes it. Nothing the library does therefore reaches this branch or
`getRouteCount`'s increment below, and no `defaultTarget` written in
`domain-resolver.yaml` reaches either; only a consumer assigning the property on
an instance does. The branch MUST be preserved as written; a consumer MUST NOT
expect a `defaultTarget` in `domain-resolver.yaml` to reach it.

`canSolve(domain)` MUST return the resolve result **and** whether its `index` is
at least zero, without coercion to a boolean. For a resolved domain this yields
`true`. For an unresolved domain `resolve` returns nothing, so `canSolve` yields
that value — `undefined` — rather than `false`. A caller MUST treat the result as
truthy or falsy and MUST NOT compare it to `false` by identity.

`getRouteCount()` MUST return the number of compiled routes, plus one when the
instance has a truthy `defaultTarget`. Given the assignment absence stated above,
it returns the compiled route count unless a consumer has written the property.

## 5. URL construction

`createUrl(domain)` MUST resolve the argument through §4 and return nothing when
that resolution returns nothing.

Otherwise it MUST build:

1. a port segment: `:` followed by the result's `port`, or the empty string when
   `port` is falsy;
2. a **`baseUrl`**: the result's `proto`, `://`, the result's `target`, then the
   port segment;
3. the returned object: the resolve result's own fields, plus `baseUrl`, plus
   `url` and `notificationUrl`.

`url` MUST be `baseUrl` followed by the result's `uri`, and `notificationUrl`
MUST be `baseUrl` followed by the result's `notificationUri`.

All three are **string concatenations**, not URL joins: no separator is inserted,
no path is normalized, and no duplicate separator is collapsed. A `uri` that does
not begin with `/` therefore appends directly to the host or port. This differs
from §11, which joins a URL by path semantics; the two constructions coexist in
this library and MUST NOT be assumed interchangeable.

The `baseUrl` this section builds is **the resolver result field**, derived from
a matched route's `proto`, `target` and `port`. It is not the environment entry's
`baseUrl` field, which §11 reads and §12 specifies; neither is derived from the
other, and a consumer MUST NOT substitute one for the other.

## 6. The environment resolver

`EnvironmentResolver` MUST be exported as a class. Its constructor takes the
routing config in either form (§0) and MUST perform the following, in order.

**Obtain the logger and emit an instantiation record.** The constructor MUST
obtain the shared logger through `getLogger` ([logging.md §3]) and emit one
`info` record at instantiation with the message
`--EnvironmentResolver instantiation--`, carrying the config's `routes` as given.
This is a logging side effect in a constructor; `DomainNameResolver` (§3) has
none, and the asymmetry MUST be preserved.

**Compile the routes.** The constructor MUST iterate the config's `routes`
**with** a fallback to the empty list. A routing config carrying no `routes`
therefore yields a resolver with no routes rather than raising — the opposite of
§3's behavior on the same omission.

For each route, in order:

1. If the route has no truthy `env`, the constructor MUST raise an `Error` whose
   message is exactly `A route without an environment found`.
2. If the route has no truthy `domain`, the constructor MUST raise an `Error`
   whose message is exactly `A route without a domain found`.
3. The route's `domain` MUST be compiled by the **escape-only** rule: a pattern
   that both starts with `^` and ends with `$` is compiled as written; any other
   pattern is escaped and compiled **without** being wrapped in anchors. The
   escape set is the same as §3's.
4. The expression MUST be compiled with the flags `gi`.
5. The compiled route MUST be pushed as the source route's own fields with
   `domain` replaced by the compiled expression. Unlike §3, no field is restated.

Two differences from §3 are contract, not incident. The validation order reports
the **environment** first, where §3 reports the target first. The two message
strings here end **without** a period, where §3's two end with one; all four are
exact and MUST be preserved as written.

Because a non-anchored pattern is escaped but not wrapped, a compiled pattern
matches as a **substring**: a route whose `domain` is `example.com` matches
`notexample.com.evil.test`. A deployment that needs whole-domain matching MUST
write the pattern with both `^` and `$` itself, which is the branch that compiles
as written.

`resolve(domain)` MUST return nothing for a falsy `domain`. Otherwise it MUST
return the **first** stored route whose compiled pattern the argument matches, as
the stored route object itself — carrying the source route's fields and the
compiled `domain` — rather than a projection of it. Matching is case-insensitive
through the `i` flag and, as in §4, is stable across repeated calls.

## 7. Routing config parsing

`parseRoutingConfig(data)` MUST return the input's own fields with
`environments` **replaced** by a combination of the input's `environmentCommon`
into each of its environment entries. Every other key of the input MUST survive
unchanged, including `environmentCommon` itself and `routes`.

The combination is performed by one unexported inner function, `combine`, which
MUST:

1. read the source map — the input's `environments` — defaulting to `{}` on a
   falsy value;
2. read the common map — the input's `environmentCommon` — defaulting to `{}` on
   a falsy value;
3. build a new result map, and for each key of the source map, set that key to
   the common map's fields spread **first** and the source entry's fields spread
   **second**;
4. return the result map.

The spread order is the conflict rule: where the common map and an entry both
carry a field, **the entry's value wins**. A field present only in the common map
is added to every entry.

Two consequences of step 3 are requirements of the result, not incidental:

* The result's `environments` MUST always be an object. An input carrying no
  `environments` key yields `{}` under it, so the parsed form never lacks the
  key, and it never carries a non-object entry: spreading a `null` entry yields
  `{}`, so an entry written in YAML with no body reaches the result as an empty
  object rather than as `null`.
* `environmentCommon` MUST survive on the result under its own key. It is read at
  exactly one site under `lib/` — this function's combination call — on the axis
  of reads and scoped to the whole library, so nothing else consumes it, and a
  consumer MUST NOT expect it to be removed once combined.

The iteration is written for its effect on the result map and discards the array
the mapping produces; that array MUST NOT be relied on.

## 8. Resolver construction

`createResolvers(configDir)` MUST read three configuration files from the config
directory, by fixed name, and return the five values built from them.

It MUST join the config directory with each file name by path semantics, and read
each file synchronously as `utf8`, parsing each as YAML. The three names are
fixed and MUST NOT be configurable: `domain-resolver.yaml`, `routing.yaml` and
`direct-routing.yaml`.

The order of operations MUST be:

1. read and parse `domain-resolver.yaml` into the **resolver config**, and
   construct a `DomainNameResolver` (§3) from it;
2. read and parse `routing.yaml` and pass the result through §7, producing the
   **parsed** routing config;
3. read and parse `direct-routing.yaml` into the **direct routing config**;
4. construct an `EnvironmentResolver` (§6) from the parsed routing config.

No read is guarded and no parse is caught, so an absent or unreadable file, or
malformed YAML in any of the three, propagates the underlying error. The order
above determines which error a caller sees when more than one file is bad.

The returned object MUST carry exactly these five keys:

| Key | Value |
|-----|-------|
| `resolver` | the `DomainNameResolver` built in step 1 |
| `resolverConfig` | the **raw** parsed `domain-resolver.yaml` |
| `environmentResolver` | the `EnvironmentResolver` built in step 4 |
| `routingConfig` | the **parsed** routing config of step 2, in §7's sense |
| `directRoutingConfig` | the parsed `direct-routing.yaml`, wrapped in nothing |

The asymmetry among the three is contract: two of the parsed configs are handed
to a class and the third is returned as parsed, and `resolverConfig` is returned
in its **raw** form while `routingConfig` is returned in its **parsed** one.

## 9. Environment lookup

`getEnvironment(targetDomain, options)` MUST resolve the target domain through
`options.environmentResolver`'s `resolve` (§6) and, when that returns a route,
MUST return the entry of `options.routingConfig.environments` named by that
route's `env`.

It MUST return `undefined` when the resolver returns nothing. It MUST also return
`undefined` — as a separate requirement, not as a consequence of the first — when
the resolver returns a route whose `env` names no entry of `environments`, since
the lookup is unguarded on the key: absence of a guard on the property read,
scoped to this function. What the lookup does with an absent `environments` is
determined by the form the caller supplies: over §7's parsed form `environments`
is always an object, so an `env` naming no entry yields `undefined`; over the raw
parsed YAML an input with no `environments` key raises on the same read.

The two `options` fields this function reads, `environmentResolver` and
`routingConfig`, are the keys §8 returns under those exact names, so the object
`createResolvers` returns satisfies both. A caller MAY supply them from elsewhere
provided each satisfies the contract of the section that specifies it.

## 10. Mail server set

`getMailServers(routingConfig)` MUST return a `Set` of the mail-server names
declared across every environment entry, each **lowercased**.

It MUST iterate the keys of the config's `environments`, defaulting to `{}` on a
falsy value, take each entry's `mailServers` defaulting to `[]`, and add each
element lowercased to the set. Duplicates across environments therefore collapse
to one member, and the result carries no ordering guarantee.

The entry lookup inside the loop is **unguarded on the entry's value**: absence of
a guard on the read of the entry's `mailServers`, scoped to this function.
Enumerating the keys guarantees the **key** and nothing about the value, so a
present-but-`null` entry raises a `TypeError` on that read rather than
contributing nothing.

What makes the loop safe is the **input class**, not the iteration. Over §7's
parsed form there is no `null` entry to raise on, because §7 rebuilds every entry
through a spread. Over the raw parsed `routing.yaml` there is: an environment key
written with no body parses to `null` (§12). This function has no caller under
`lib/` and is reached only through the library's export surface, so which form
arrives is the consumer's choice and both are real inputs.

## 11. Routing info fetch

`fetchRoutingInfo(environment, transport)` MUST request routing information for a
transport from an environment entry's routing endpoint, MUST be asynchronous, and
MUST resolve to the response body.

It MUST read the transport's `headers` ([transport-model.md §2]), defaulting to
`{}` on a falsy value, and then:

1. build the routing URL by joining the environment entry's `baseUrl` with its
   `routingUri` through the library's URL joining ([utilities.md §6]), which
   applies path semantics rather than §5's concatenation;
2. read the dynamic-routing header from the header map, by the constant
   [routing-headers.md §2] specifies for it;
3. when that header is present, **replace** the joined URL with **element 0** of
   the header's value. The override replaces the URL entirely; it MUST NOT be
   joined onto or appended to the URL built in step 1;
4. issue a `post` through the HTTP client to the resulting URL, with the
   environment entry's **`routingHeaders`** as the request headers, both
   `maxContentLength` and `maxBodyLength` set to `Infinity`, and the transport as
   the request body;
5. return the response's `data`.

The header value is read as a list and its first element is used, which is the
header-map representation's shape; a header carrying more than one value
contributes only its first.

The `routingHeaders` read here is **the environment entry's field** (§12), the
outgoing request headers for this call. It is not the module-level routing-header
list that groups the header-name constants, which is a different thing under the
same name and belongs to [routing-headers.md §3]. Every reference to
`routingHeaders` in this file means the entry's field.

Both size limits are set to `Infinity`, so neither the request body nor the
response is bounded by the client's defaults. Nothing here catches: a transport
error, a non-success status, or a failure to build the URL reaches the caller.
Because the function is asynchronous, each reaches it as a **rejected promise**
rather than as a synchronous throw — including the URL-joining failure, which is
raised before the request is issued. A caller that ignores the returned promise
observes none of them.

## 12. Configuration file shapes

The three files §8 reads, specified as the symbols under `lib/` consume them. The
**Read by, under `lib/`** column names, for each field, at least one symbol that
reads it; a field no symbol under `lib/` reads is not listed, and the values a
deployment sets are not specified here (§1.2).

### 12.1 `domain-resolver.yaml`

Parsed into the resolver config and consumed by §3, §4 and §5. Five fields sit at
the top level beside `routes`:

| Field | Type | Read by, under `lib/` |
|-------|------|-----------------------|
| `proto` | string | `DomainNameResolver`'s constructor (§3), defaulting to `https` |
| `port` | string or number | `DomainNameResolver`'s constructor (§3); **not** defaulted |
| `uri` | string | `DomainNameResolver`'s constructor (§3), defaulting to `''` |
| `notificationUri` | string | `DomainNameResolver`'s constructor (§3), defaulting to `''` |
| `headers` | object | `DomainNameResolver`'s constructor (§3), defaulting to `{}` |
| `routes` | list | `DomainNameResolver`'s constructor (§3), **unguarded** — the key is required |

Each element of `routes` is a route object:

| Field | Required | Read by, under `lib/` |
|-------|----------|-----------------------|
| `domain` | yes | `DomainNameResolver`'s constructor (§3), compiled with anchoring |
| `target` | yes | §3 validates and restates it; §4 substitutes into it |
| `proto` | no | §4, overriding the instance value when truthy |
| `port` | no | §4, overriding the instance value when truthy |
| `uri` | no | §4, overriding the instance value when truthy |
| `notificationUri` | no | §4, overriding the instance value when truthy |
| `headers` | no | §4, overriding the instance value when truthy |

A `defaultTarget` written at the top level of this file is **not** read: §3's
constructor does not copy it onto the instance, and §4's branch reads only the
instance field.

### 12.2 `routing.yaml`

Parsed into the routing config, in the raw form until §7 produces the parsed one.
It carries `environmentCommon`, `environments` and `routes`.

`environmentCommon` is an object of fields merged into every environment entry by
§7, where an entry's own value for a field wins. Its fields are the same fields an
entry may carry.

`environments` maps an environment name to an **environment entry**. The twelve
fields below are exactly those read by at least one named symbol under `lib/`,
counted once per field name however many symbols read it. Fields a deployment may
set that no symbol under `lib/` reads are excluded by that unit and are not
listed.

| Field | Type | Read by, under `lib/` |
|-------|------|-----------------------|
| `baseUrl` | string | `fetchRoutingInfo` (§11); `JobQueue`, specified in [job-queue.md §13]; `RoutingJob`, specified in [routing.md §6] and [routing.md §7] |
| `routingUri` | string | `fetchRoutingInfo` (§11) |
| `routingHeaders` | object | `fetchRoutingInfo` (§11) |
| `emailPostUri` | string | `RoutingJob`, specified in [routing.md §6] and [routing.md §7] |
| `emailPostHeaders` | object | `RoutingJob`, specified in [routing.md §6] and [routing.md §7] |
| `notificationPostUri` | string | `JobQueue`, specified in [job-queue.md §13] |
| `notificationPostHeaders` | object | `JobQueue`, specified in [job-queue.md §13], defaulting to `{}` there |
| `notificationPostAuth` | object | `JobQueue`, specified in [job-queue.md §13] |
| `mailServers` | list of strings | `getMailServers` (§10), lowercasing each; `DomainNameVerifier`, specified in `domain-verification.md` |
| `spfInclude` | string | `DomainNameVerifier`, specified in `domain-verification.md` |
| `emailDomain` | string | `ForwardingJob`, specified in [jobs.md §7] |
| `dkimSelector` | string | `getDkim`, specified in `domain-verification.md`, which receives the whole entry and defaults this field to `main` |

An environment key written with **no body** parses to `null`, not to an empty
object. Which symbols that reaches, and what they do with it, depends on the form
(§7, §9, §10).

Each element of `routes` is a routing-config route object:

| Field | Required | Read by, under `lib/` |
|-------|----------|-----------------------|
| `domain` | yes | `EnvironmentResolver`'s constructor (§6), compiled **without** anchoring |
| `env` | yes | §6 validates it; §9 uses it as the key into `environments` |

### 12.3 `direct-routing.yaml`

Parsed into the **direct routing config** and returned by §8 wrapped in nothing.
Its shape as the two readers consume it — an object keyed by config name, whose
entries carry `headers` and `auth` — is specified in [routing-headers.md §10];
this file specifies only the loading half.

A config name written with **no body** parses to `null`. Such an entry is
**present**: enumerating the config's keys finds it, and a lookup by that name
returns `null` rather than `undefined`. Both readers of an entry apply their
field defaults to a present entry by reading fields off it, so a `null` entry
raises on that read exactly as an absent entry does, rather than yielding the
per-field defaults that a present entry omitting both fields would yield.

## 13. Tests checklist

The scenarios below cover claims in this file that are not transcribed
literals or mechanical expansions of them: the defaulting rules and the one field
that has no default, the two pattern-compilation rules and what each implies for
matching, the guards that are absent and what each absence costs, the branch
structure of resolution and URL construction, and the two lookups whose behavior
depends on which form of the routing config arrives. Each is stated so that a
plausible-sounding but wrong description of the behavior fails it. There is one
subsection per technical section §2–§12, and none is empty.

### 13.1 Configuration loading

* A **relative** `configPath` resolves against the package's own directory, not
  against the process working directory: calling the loader from a working
  directory that contains the named file, with the package installed elsewhere,
  reads the package-relative path and not the local one. This catches a
  description that treats the argument as a normal relative path.
* The default argument is absolute, so the default call is unaffected by the
  resolution rule above and reads `/moment/env/env.yaml`. This catches a fix that
  "corrects" the resolution base and silently changes the default's meaning.
* A missing file and malformed YAML both propagate: the loader has no `catch`, on
  the axis of the exported function's body and scoped to `lib/config.js`, so
  neither is converted into a return value. This catches a caller that treats an
  absent configuration file as recoverable without handling the error itself.

### 13.2 The domain-name resolver

* A resolver config carrying **no `routes` key** raises on construction. The
  constructor's route loop has no fallback for an absent list, on the axis of that
  loop and scoped to this class, where §6's loop does have one. This catches a
  description that gives the two constructors the same tolerance.
* `port` is the one instance-level field with **no default**: a config omitting
  `proto`, `port`, `uri`, `notificationUri` and `headers` yields `https`, a falsy
  port, `''`, `''` and `{}` respectively. This catches a defaulting table that
  invents a port.
* All five instance defaults apply on a **falsy** value, not on an absent key: a
  config carrying `proto: ''` yields `https`, and one carrying `headers: null`
  yields `{}`. This catches an implementation that checks for the key instead.
* A route missing **both** `target` and `domain` reports the **target**, with the
  message ending in a period. This catches a reordering of the two checks and any
  drift in the message text.

### 13.3 Domain-name resolution

* A falsy `domain` skips the route loop but **not** the `defaultTarget` branch, so
  resolution of a falsy argument is decided entirely by that branch.
* The `uri` and `notificationUri` fallbacks are computed for **every route
  visited**, before the match test, including routes that do not match. This
  catches an optimization that defers them to the matching route and changes the
  work done on a non-matching route.
* A pattern with capture groups substitutes into the target: the returned `target`
  is the argument with the compiled expression replaced by the route's `target`,
  not the route's `target` verbatim. This catches a description that treats
  `target` as a literal.
* `proto`, `port` and `headers` each fall back to the instance value on a **falsy**
  route value, while `uri` and `notificationUri` were already resolved before the
  match. The result carries all seven fields including `index`.
* Repeated `resolve` calls with the same argument return the same result, even
  though the expression carries `g` and `lastIndex` is never reset — both the
  match and the `target` replace run against that same compiled object. This
  catches a "fix" that adds a `lastIndex` reset on the assumption that one is
  needed, and any caching that would make the second call differ from the first.
* A `defaultTarget` written in `domain-resolver.yaml` never reaches the
  `index: -1` branch and never increments the route count: §3's constructor does
  not copy it onto the instance, and it is **assigned at no site under `lib/`**,
  on the axis of assignment and scoped to the whole library. This catches a
  reader who takes a `defaultTarget` written in that file for one that reaches
  the branch.

### 13.4 URL construction

* An unresolved domain yields nothing, not a URL built from the instance
  defaults.
* A falsy `port` produces **no** port segment and no stray colon, while a truthy
  one produces `:` followed by the value. This is the one behavior that depends on
  `port` having no default.
* `url` and `notificationUrl` are **string concatenations** of `baseUrl` with the
  resolved `uri` and `notificationUri`: a `uri` not beginning with `/` appends
  directly to the host or port, and no separator is inserted or collapsed. This
  catches a description that assumes the path joining §11 uses.

### 13.5 The environment resolver

* A routing config carrying **no `routes` key** yields a resolver with no routes
  rather than raising — the opposite of §3 on the same omission. This catches a
  description that gives both constructors one behavior.
* Construction emits exactly one `info` record carrying the config's `routes` as
  given, where `DomainNameResolver` emits none. This catches a refactor that
  removes the side effect as redundant or adds a matching one to the other class.
* A route missing **both** `env` and `domain` reports the **environment**, with
  the message ending **without** a period — the opposite order to §3's and a
  different punctuation. This catches a description that unifies the four message
  strings.
* An unanchored pattern is escaped but **not** wrapped, so it matches as a
  **substring**: a route whose `domain` is `example.com` matches
  `notexample.com.evil.test`, while the same pattern under §3's rule would not.
  This catches a reader who assumes both resolvers anchor, and is the scenario a
  deployment relying on whole-domain matching must fail before writing its own
  anchors.
* Resolution returns the **first** matching stored route object itself, carrying
  the source route's fields and the compiled `domain`, not a projection; and
  repeated calls are stable for the same reason §4's are.

### 13.6 Routing config parsing

* An input carrying **no `environments` key** yields `{}` under that key, so the
  parsed form always has it. This catches a description that says the key is
  passed through untouched.
* An entry written in YAML with **no body** parses to `null` and reaches the
  result as `{}`, because spreading `null` contributes nothing. This is the claim
  §10 and §9 depend on, and it is the reason the parsed form carries no `null`
  entry.
* Where the common object and an entry both carry a field, **the entry wins**, and
  a field present only in the common object is added to every entry. This catches
  a spread written in the other order.
* `environmentCommon` survives on the result under its own key and is read at
  **exactly one site under `lib/`** — this function's combination call — on the
  axis of reads and scoped to the whole library. This catches an implementation
  that consumes and deletes it, and a reader who expects some later symbol to use
  it.

### 13.7 Resolver construction

* The three file names are fixed and joined onto the config directory by path
  semantics: a directory argument with or without a trailing separator reads the
  same three files, and no name is configurable.
* The returned object carries exactly five keys, with `resolverConfig` **raw** and
  `routingConfig` **parsed**. This catches a description that returns both configs
  in one form, and any consumer that passes `resolverConfig` where a parsed
  routing config is expected.
* `direct-routing.yaml` is returned parsed but wrapped in nothing, unlike the
  other two, and an absent or malformed file among the three propagates its error
  in the read order given. This catches a description that wraps all three
  uniformly or that reports the wrong file first.

### 13.8 Environment lookup

* A resolver that returns nothing yields `undefined`, and so does a resolved route
  whose `env` names **no entry** of `environments`: absence of a guard on the
  property read, scoped to this function. The two paths reach the same value for
  different reasons, and both are required.
* Over the **raw** parsed routing config, an input with no `environments` key
  raises on that same read, while over the parsed form of §7 it yields
  `undefined`, the key always being present. This catches a description that
  states one consequence unconditionally.
* The two `options` fields read here are named exactly as §8 returns them, so the
  object `createResolvers` returns satisfies the lookup unchanged. This catches a
  renaming on either side.

### 13.9 Mail server set

* Every server is lowercased and duplicates across environments collapse into one
  member of the set, and an entry with no `mailServers` contributes nothing rather
  than raising.
* The entry lookup inside the loop is **unguarded on the entry's value** — absence
  of a guard on the read of the entry's `mailServers`, scoped to this function —
  so behavior depends on which form arrives: over §7's parsed form the loop is
  safe, there being no `null` entry to read through, while over the raw parsed
  `routing.yaml` a present-but-`null` entry raises a `TypeError`. Enumerating the
  keys guarantees the key, never the value. This catches a description that reads
  key enumeration as making the body safe, and one that states either consequence
  without its input class.
* The function has **no caller under `lib/`** and is reached only through the
  export surface, so which form arrives is the consumer's choice and both are real
  inputs. This catches an assumption that the parsed form is guaranteed by the
  library.

### 13.10 Routing info fetch

* The routing URL is built by **joining** the entry's `baseUrl` with its
  `routingUri` under path semantics, not by the concatenation §5 uses. This
  catches a change that unifies the two URL constructions.
* When the dynamic-routing header is present, its **element 0 replaces** the
  joined URL entirely; the joined URL is not a prefix of the result and the two
  are not combined. This catches an implementation that appends the override.
* The request headers are the **environment entry's `routingHeaders` field**, not
  the module-level routing-header list that shares the name. This catches a
  reader who conflates the two, which is the collision this file scopes at every
  mention.
* Both `maxContentLength` and `maxBodyLength` are `Infinity`, and nothing is
  caught: the function is asynchronous, so a transport error, a non-success
  status and a URL-joining failure all reach the caller as a **rejected
  promise**, never as a synchronous throw. This catches a default size limit
  reintroduced by a client upgrade, and a description that states these failures
  in a form a `try`/`catch` around the un-awaited call could intercept.

### 13.11 Configuration file shapes

* Every field listed for an environment entry has at least one named reader under
  `lib/`, counted once per field name however many symbols read it; a field no
  symbol under `lib/` reads is not listed. This is the unit that makes the field
  list reproducible from source, and it catches a table grown from a deployment's
  configuration file rather than from its readers.
* A `defaultTarget` written at the top level of `domain-resolver.yaml` is read by
  nothing: the constructor does not copy it onto the instance. This catches a
  deployment that writes one expecting §4's branch to fire.
* An environment key and a direct-routing config name written with **no body**
  each parse to `null` rather than to an empty object, and the two are treated
  differently downstream: the environment entry is rebuilt to `{}` by §7 before
  the readers that matter see it, while the direct-routing entry reaches its
  readers as `null` and raises on the field read. This catches a description that
  gives one rule for both files.
