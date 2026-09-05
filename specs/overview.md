# special-mail-lib Overview Spec (v2.0)

The `special-mail-lib` v4.7.10 lock-in pass established a marker-free compliance
baseline in the fourteen runtime specs and this file. Later additions and
revisions record desired behavior, including the current packaging and runtime
contract in §4. They use INTENT for user-directed requirements and FUTURE for
longer-term goals, not immediate implementation targets.
`dependency-upgrades.md` was the first addition; §2.1 records the policy and
automation design motivations.

This file carries the project overview, the cross-cutting glossary, the map of
the library's export surface, its packaging contract, and the index of the spec
set.

## 0. Glossary

These terms are used across the spec set and are defined here once.

* **Transport object**: the library's internal representation of one message in
  transit, carrying the envelope, the message body and the routing metadata
  derived from it.
* **Envelope**: the SMTP-level sender and recipient information for a message,
  as distinct from the message headers.
* **Item**: one unit of work placed on the job queue, describing a message and
  the action to take on it.
* **Mail**: a stored message record, as persisted by the mail store.
* **`eml64`**: a base64-encoded RFC 822 message, used to carry a full message
  through JSON payloads.
* **Environment**: a named deployment context resolved from configuration,
  determining which routing and target settings apply to a message.
* **Route**: the resolved decision about where a message goes — the target, the
  delivery mode, and the callback URLs that apply to it.
* **Target**: a named destination a route resolves to, with its own mail servers
  and settings.
* **Guid**: the library-generated identifier attached to a message so it can be
  correlated across queue, delivery and callback stages.
* **Direct routing**: routing driven by special headers carried on the message
  itself, naming the post, notify, forward or dynamic-routing endpoints
  directly.
* **Static routing**: routing resolved from configuration alone, without a
  per-message routing lookup.
* **Dynamic routing**: routing resolved by querying a configured routing
  endpoint for the message.
* **In-exchange**: the MX host through which mail enters the system for a
  domain.
* **Out-exchange**: the MX host through which mail leaves the system toward a
  target.
* **DKIM id**: the selector identifying which DKIM key a domain's signature is
  expected to use.
* **Group**: a named collection of test inboxes addressed together.
* **Inbox**: a test mailbox addressable by the test-inbox surface.

## 1. Goals and non-goals

### 1.1 Goals

* Lock in the behavior of `special-mail-lib` v4.7.10 at contract level across
  the entire surface the object `index.js` exports: for each exported symbol,
  its signature, inputs, outputs, error behavior, side effects and defaults,
  plus the algorithms that cannot be inferred from those.
* Give every exported symbol exactly one home spec (§3), so that the spec set
  covers the export surface without overlap or gaps.

### 1.2 Non-goals

* Marker content in the original v4.7.10 lock-in pass. That pass wrote the
  fourteen runtime specs and this file's original content without INTENT,
  FUTURE or DEPRECATED markers or Design motivations. Later additions and
  revisions use the spec conventions.
* Commentary on behavior that reads as defective. Where current behavior is
  surprising, the specs state it as it is and say nothing further about it.
* `tests/` and `docker/` are outside the library's runtime contract.
  [test-automation.md §5] and [test-automation.md §6] specify their staging
  and execution by project automation.
* The internals of third-party dependencies. §4 names them; their own contracts
  are theirs.

## 2. Purpose and architecture

`special-mail-lib` is the shared mail-handling library behind a Haraka and
ZoneMTA based mail system. It is consumed as a plugin support library rather
than run on its own: it MUST NOT be treated as a service, and it starts nothing
at require time beyond the module-level logger of [logging.md §2].

The pipeline the library serves runs in this order:

1. A Haraka or ZoneMTA plugin receives a message and converts its envelope and
   body into a transport object.
2. The plugin pushes an item onto a PostgreSQL-backed job queue.
3. A parsing job turns the queued message into a parsed representation.
4. A routing job resolves the environment, target and route for it.
5. A delivery job acts on that route — posting to an HTTP endpoint, forwarding
   over SMTP, or generating a bounce.

Each stage is specified by the spec that owns it: `job-queue.md` for the queue,
`email-parsing.md` for parsing, `routing.md` for routing decisions, and
`jobs.md` for the job classes that drive the stages. The values passed between
them are specified by `transport-model.md` and `routing-headers.md`.

### 2.1 Design motivations

STARTINTENT
Dependencies are upgraded only to remediate critical and high advisories,
and never to a version published less than 14 days earlier. The user
directed the cooldown because of supply-chain attacks, and directed that
only critical and high advisories trigger an upgrade.
`dependency-upgrades.md` carries the policy, its scoping, the waiver
protocol, and the requirements on the automation that enforces it.
ENDINTENT

STARTINTENT
The user chose visor2 automation under `ci2/`, with full lint, unit,
integration and dependency-policy coverage, and authorized agents to run
`ci2/scripts/all-tests.sh` and cite its output as validation evidence.
`test-automation.md` carries the automation and validation requirements.
ENDINTENT

## 3. Export surface

`index.js` MUST export a single object composed of twelve named properties
followed by the spread of four modules — `lib/util.js`, `lib/JobQueue.js`,
`lib/logger.js` and `lib/parse-email-file.js`, in that order. Expanded, that
object MUST have exactly the 79 keys below.

Every key MUST have exactly one home spec, and the home spec column MUST be the
sole authority for that symbol's contract. A spec file named here that does not
exist yet is a forward mention: it names the spec that will own the symbol, and
is not a cross-reference.

The four spread modules contribute 63, 2, 1 and 1 keys respectively; with the
twelve named properties that is 79. Those five key sets MUST be pairwise
disjoint, so that no spread key shadows a named property or another spread's
key and the 79 contributed keys are 79 distinct keys of the exported object.

| Export | Home spec | Source file |
|--------|-----------|-------------|
| `config` | `config-and-resolvers.md` | `lib/config.js` |
| `DomainNameResolver` | `config-and-resolvers.md` | `lib/DomainNameResolver.js` |
| `DomainNameVerifier` | `domain-verification.md` | `lib/DomainNameVerifier.js` |
| `EmailSorter` | `email-parsing.md` | `lib/EmailSorter.js` |
| `EmailParser` | `email-parsing.md` | `lib/EmailParser.js` |
| `EnvironmentResolver` | `config-and-resolvers.md` | `lib/EnvironmentResolver.js` |
| `createError` | `errors.md` | `lib/error.js` |
| `MailStore` | `mail-store.md` | `lib/MailStore.js` |
| `mailStoreModel` | `mail-store.md` | `lib/mail-store-model.js` |
| `MxVerifier` | `mx-verification.md` | `lib/MxVerifier.js` |
| `TestInbox` | `test-inbox.md` | `lib/TestInbox.js` |
| `jobTypes` | `jobs.md` | `lib/jobs/job-types.js` |
| `DIRECT_CONFIG_HEADERNAME` | `routing-headers.md` | `lib/util.js` |
| `DIRECT_POST_URL_HEADERNAME` | `routing-headers.md` | `lib/util.js` |
| `DIRECT_FORWARD_URL_HEADERNAME` | `routing-headers.md` | `lib/util.js` |
| `DIRECT_NOTIFY_URL_HEADERNAME` | `routing-headers.md` | `lib/util.js` |
| `DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME` | `routing-headers.md` | `lib/util.js` |
| `JSON64_DIRECT_MX` | `routing-headers.md` | `lib/util.js` |
| `JSON64_DATA_HEADERNAME` | `routing-headers.md` | `lib/util.js` |
| `MOMENT_POST_URL_HEADERNAME` | `routing-headers.md` | `lib/util.js` |
| `MOMENT_NOTIFY_URL_HEADERNAME` | `routing-headers.md` | `lib/util.js` |
| `MOMENT_ROUTING_RESPONSE_HEADERNAME` | `routing-headers.md` | `lib/util.js` |
| `GUID_HEADERNAME` | `routing-headers.md` | `lib/util.js` |
| `normalizeEOLs` | `utilities.md` | `lib/util.js` |
| `asyncWrapper` | `utilities.md` | `lib/util.js` |
| `clearInboxes` | `utilities.md` | `lib/util.js` |
| `randomHexString` | `utilities.md` | `lib/util.js` |
| `randomAlphanumeric` | `utilities.md` | `lib/util.js` |
| `errorHandler` | `utilities.md` | `lib/util.js` |
| `ok` | `utilities.md` | `lib/util.js` |
| `hashQueueName` | `utilities.md` | `lib/util.js` |
| `parseRoutingConfig` | `config-and-resolvers.md` | `lib/util.js` |
| `getDomainHashKey` | `utilities.md` | `lib/util.js` |
| `getDkimDir` | `domain-verification.md` | `lib/util.js` |
| `getDkim` | `domain-verification.md` | `lib/util.js` |
| `saveEmail` | `utilities.md` | `lib/util.js` |
| `dnsResolve` | `utilities.md` | `lib/util.js` |
| `allPromises` | `utilities.md` | `lib/util.js` |
| `copyStream` | `utilities.md` | `lib/util.js` |
| `streamToBuffer` | `utilities.md` | `lib/util.js` |
| `streamToBase64` | `utilities.md` | `lib/util.js` |
| `generateMessageId` | `transport-model.md` | `lib/util.js` |
| `bufferToStream` | `utilities.md` | `lib/util.js` |
| `getMailServers` | `config-and-resolvers.md` | `lib/util.js` |
| `getEnvironment` | `config-and-resolvers.md` | `lib/util.js` |
| `fetchRoutingInfo` | `config-and-resolvers.md` | `lib/util.js` |
| `createResolvers` | `config-and-resolvers.md` | `lib/util.js` |
| `getDirectNotifyRequestRouting` | `routing-headers.md` | `lib/util.js` |
| `getDirectPostRequestRouting` | `routing-headers.md` | `lib/util.js` |
| `headerListToObject` | `transport-model.md` | `lib/util.js` |
| `headersToObject` | `transport-model.md` | `lib/util.js` |
| `headerLinesToObject` | `transport-model.md` | `lib/util.js` |
| `hasSpecialHeaders` | `routing-headers.md` | `lib/util.js` |
| `copyRoutingHeaders` | `routing-headers.md` | `lib/util.js` |
| `toJson64` | `routing-headers.md` | `lib/util.js` |
| `fromJson64` | `routing-headers.md` | `lib/util.js` |
| `addressToObject` | `transport-model.md` | `lib/util.js` |
| `getMxFromHeaders` | `routing-headers.md` | `lib/util.js` |
| `adjustEnvelope` | `transport-model.md` | `lib/util.js` |
| `envelopeToTransport` | `transport-model.md` | `lib/util.js` |
| `emailToTransport` | `transport-model.md` | `lib/util.js` |
| `extractGuidFromHeaders` | `transport-model.md` | `lib/util.js` |
| `extractGuid` | `transport-model.md` | `lib/util.js` |
| `transportLogInfo` | `transport-model.md` | `lib/util.js` |
| `generateGuid` | `transport-model.md` | `lib/util.js` |
| `generateEmailGuid` | `transport-model.md` | `lib/util.js` |
| `extractAddressObjects` | `transport-model.md` | `lib/util.js` |
| `parseAddresses` | `transport-model.md` | `lib/util.js` |
| `getAddressesFromEmail` | `transport-model.md` | `lib/util.js` |
| `getRfc822Headers` | `transport-model.md` | `lib/util.js` |
| `getRfc822Message` | `transport-model.md` | `lib/util.js` |
| `urlJoin` | `utilities.md` | `lib/util.js` |
| `extractAttachments` | `transport-model.md` | `lib/util.js` |
| `getJsonSafeHeaders` | `transport-model.md` | `lib/util.js` |
| `getJsonSafeEmail` | `transport-model.md` | `lib/util.js` |
| `JobQueue` | `job-queue.md` | `lib/JobQueue.js` |
| `createJobQueue` | `job-queue.md` | `lib/JobQueue.js` |
| `getLogger` | `logging.md` | `lib/logger.js` |
| `parseEmailFile` | `email-parsing.md` | `lib/parse-email-file.js` |

`routing.md` owns no row: the routing job it specifies is driven through the
queue rather than exported from `index.js`. Apart from this file, which carries
the map rather than owning symbols, it is the one spec in §5 whose surface the
export map does not reach.

## 4. Packaging and runtime

`package.json` MUST declare:

| Field | Value |
|-------|-------|
| `name` | `special-mail-lib` |
| `version` | `4.7.10` |
| `main` | `index.js` |
| `license` | `MIT` |

STARTINTENT
`package.json` MUST declare `engines.node` as `>=20.19.0`, and consumers
MUST run the library on Node 20.19.0 or later. The user selected this minimum
for Mailparser upgrades.
ENDINTENT

A consumer MUST reach the export surface of §3 by requiring the package itself.

The package MUST declare exactly these 18 runtime dependencies. The concern
column states what each supports in this library; the modules named are where
the dependency is required.

| Dependency | Supports |
|------------|----------|
| `address-rfc2821` | SMTP address handling in `lib/util.js`, `lib/jobs/ForwardingJob.js` and `lib/jobs/RoutingJob.js` |
| `addressparser` | address-header parsing in `lib/util.js` |
| `axios` | outbound HTTP in `lib/util.js`, `lib/jobs/PostingJob.js` and `lib/TestInbox.js` |
| `haraka-dsn` | delivery status notification construction in `lib/jobs/RoutingJob.js` |
| `iconv` | character-set conversion in `lib/util.js` and `lib/EmailParser.js` |
| `js-base64` | base64 encoding and decoding in `lib/util.js` |
| `mailparser` | MIME parsing in `lib/util.js` and `lib/EmailParser.js` |
| `mailsplit` | MIME stream splitting in `lib/util.js` |
| `merge` | option and configuration merging in `lib/util.js` |
| `nodemailer` | its `mail-composer` submodule in `lib/util.js` and its `addressparser` submodule in `lib/EmailParser.js` |
| `pg-boss` | the PostgreSQL-backed job queue in `lib/JobQueue.js` |
| `sequelize` | the mail store model in `lib/mail-store-model.js` |
| `sleep-promise` | delays in `lib/TestInbox.js` |
| `spf-check` | SPF verification in `lib/DomainNameVerifier.js` |
| `stream-buffers` | buffer and stream conversion in `lib/util.js` and `lib/plugin-util.js` |
| `string-template` | positional message formatting in `lib/error.js` and `lib/MxVerifier.js` |
| `winston` | logging in `lib/logger.js` |
| `yaml` | YAML configuration parsing in `lib/config.js` and `lib/util.js` |

The version range `package.json` declares for each of those dependencies is
deliberately not specified. This spec pins the dependency set, not the versions
it resolves to: a range is a packaging decision that changes without changing
the library's contract, and every third-party behavior this spec set relies on
is stated in the specs themselves rather than tied to a declared range.

When a dependency's resolved version may change, and to which version, is
governed by [dependency-upgrades.md §2] and [dependency-upgrades.md §3].
[dependency-upgrades.md §9] states the boundary with this section; that policy
pins neither the dependency set nor the ranges described here.

`package.json` also carries `scripts` and `devDependencies`. Both are present,
and neither is part of the library's runtime contract: a consumer MUST NOT
depend on either. They are named here rather than specified.

The remaining top-level fields, `description` and `repository`, are project
metadata and are likewise not specified.

## 5. Spec index

The spec set lives in `specs/`. Each spec below exists; the relationship and
ordering notes and forward mentions name every planned file. Any spec may
name a spec file that does not yet exist by file name alone, without a
section: that is a forward mention naming the file that will own the subject,
not a cross-reference. `dependency-upgrades.md` names `test-automation.md`,
which owns the automation contract and validation evidence requirements
([test-automation.md §1], [test-automation.md §9]).

The export-map reachability statements in §3 and the runtime ordering below
concern the runtime specs. Policy specs supplement that set without owning
exported symbols.

* `overview.md` — this file: the project overview, cross-cutting glossary,
  export-surface map, packaging and consumer-runtime contract (§4), and spec
  index.
* `errors.md` — the `createError` factory and the twelve-entry error catalog it
  formats messages from.
* `logging.md` — the module-level default winston logger and the `getLogger`
  accessor that returns it or a caller-supplied logger.
* `utilities.md` — the general-purpose helpers: EOL normalization, express
  wrappers, random and hash generation, URL joining, DNS resolution, promise
  settling, stream conversion, email file persistence and inbox cleanup.
* `transport-model.md` — the transport object and the conversions that build,
  read and project it: address objects, header maps, the envelope and email
  conversions, guid generation and extraction, the RFC 822 and JSON-safe forms
  and the log-info projection.
* `routing-headers.md` — the routing and special header-name constants, the
  lists that group them, and the helpers that detect, copy, encode and decode the
  routing decisions carried on a message.
* `config-and-resolvers.md` — configuration loading, the domain-name and
  environment resolvers, routing-config parsing, and the environment,
  mail-server and routing-info lookups built on them.
* `email-parsing.md` — the email parser, the per-recipient sorter and the
  file-parsing entry point: how a raw message becomes one parsed item per
  recipient.
* `job-queue.md` — the pg-boss-backed job queue: how items are pushed,
  subscribed to and processed, and how the queue notifies a target about a
  message.
* `jobs.md` — the job type constants, built-in job-class registry, non-routing
  job classes, outbound mail helpers and library-emitted notification type
  catalog.
* `routing.md` — the routing job: static and dynamic routing decisions, routing
  queue writes, notification types, bounced-message handling and error behavior.
* `mx-verification.md` — the MX verifier: configured-server and record
  normalization, boolean verification, priority rewriting, report shape and
  corrective steps.
* `domain-verification.md` — the domain verifier and DKIM helper exports: SPF,
  DKIM and MX orchestration, public verification result shapes and corrective
  steps.
* `mail-store.md` — message persistence: the model factory, stored message
  schema, query/delete methods, transaction retrying and scheduled cleanup.
* `test-inbox.md` — the test inbox client: construction, generated addresses,
  URL fields, HTTP calls, response extraction, group methods and count waiting.
* `dependency-upgrades.md` — the dependency upgrade policy: the critical-and-
  high trigger, the 14-day cooldown and its change-set and entry scopes,
  identification of policed changes, waiver and upgrade-record protocol,
  and enforcement boundary per rule; INTENT-marked policy rather than lock-in.
* `test-automation.md` — the visor2 `ci2/` automation contract: staging,
  runtime coverage, suites, runner behavior and project-authorized validation
  evidence.

### 5.1 Relationships and ordering

The spec set is read in dependency order. `overview.md`, `errors.md` and
`logging.md` are the foundations: they depend on nothing else, and everything
else assumes the glossary in §0 and the export map in §3.

`utilities.md` comes next, covering the general-purpose helpers — EOL
normalization, random and hash generation, stream conversion, DNS resolution,
promise helpers and file-save helpers. §3 routes each of those symbols to it by
name. `transport-model.md` builds
on it, defining the transport object, the envelope conversion, the guid and
RFC 822 forms, and the JSON-safe projections. `routing-headers.md` follows,
covering the header-name constants and the encode/decode helpers that carry
routing decisions on a message.

`config-and-resolvers.md` depends on the utilities, the header layer and the
glossary: it covers configuration loading, environment and domain-name
resolution, and the routing-info lookup. `email-parsing.md` depends on the
transport model and covers the parser, the sorter and the file-parsing entry
point.

`job-queue.md` sits on top of the utilities, the transport model, the header
layer and the configuration layer, and specifies the queue itself. `jobs.md`
depends on the queue and on parsing, and covers the job types and the job
classes. `routing.md` depends on `jobs.md` and covers the routing job — the one
spec whose subject is not reachable from the export map (§3).

The remaining specs hang off the foundations more directly. `mx-verification.md`
depends only on the foundations and covers MX record verification.
`domain-verification.md` depends on the utilities, the configuration layer and
`mx-verification.md`, and covers domain, SPF and DKIM verification.
`mail-store.md` depends on the foundations and covers message persistence.
`test-inbox.md` depends on the utilities and covers the test inbox surface.

Ordering constraints worth stating: `transport-model.md` must be read before
any spec describing a message in transit; `routing-headers.md` before
`config-and-resolvers.md` and `job-queue.md`, which consume the header
constants; and `errors.md` before `mx-verification.md` and
`domain-verification.md`, which raise the codes it catalogs.

`dependency-upgrades.md` is a policy spec rather than a runtime spec. It
depends on §4 of this file for the dependency set and on nothing else in the
set; no runtime spec depends on it. It is read after this file, independently
of the runtime order above.

`test-automation.md` is read after this overview and `dependency-upgrades.md`.
The dependency spec owns policy; the automation spec owns execution and
validation evidence. This is reading and ownership order: the policy's
filename mentions still point to its automation owner. Neither spec changes
the runtime ordering or owns exported symbols.

## 6. Tests checklist

### 6.1 Export surface

* The map in §3 enumerates every key of the object `index.js` exports, with the
  four spread modules expanded: no key of the exported object is missing from
  the table, and no row names a key the object does not have.
* The five contributed key sets of §3 — `index.js`'s twelve named properties and
  the exports of `lib/util.js`, `lib/JobQueue.js`, `lib/logger.js` and
  `lib/parse-email-file.js` — are pairwise disjoint: the object `index.js`
  exports has exactly 79 keys, one per row. The bullet above passes even when
  two of those sets contribute the same key, since the map and the object still
  agree as sets; a collision shows up here instead, as an object with fewer than
  79 keys, and it silently rebinds the earlier contribution — object spread is
  last-wins and the four spreads follow the named properties.
* Each row's home spec is either a spec file that exists in `specs/`, or a
  forward mention of one this spec set still plans, and each row names exactly
  one.

### 6.2 Packaging

* The figures in §4 — name, version, `main`, `engines.node`, license, and the
  set of 18 runtime dependencies — match `package.json` as written.
* Each `Supports` entry in §4's dependency table holds against the source: every
  module the entry names requires that package, and no module under `lib/`
  requires the package without being named in its entry. This column is derived
  from the require sites rather than transcribed from `package.json`, so no
  other item here checks it.
