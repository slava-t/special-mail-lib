# Logging Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the library's default logger and the `getLogger` accessor exported from
`index.js`.

## 0. Glossary

* **Logger**: a winston logger instance, as returned by `winston.createLogger`.
* **Transport**: a winston output destination attached to a logger. The library
  configures one, `winston.transports.Console`.
* **Level**: a winston severity threshold. A logger and each of its transports
  carry one independently.
* **Format**: a winston formatter attached to a logger or to a transport,
  controlling how a log entry is rendered.
* **Loaded module instance**: the single module object Node caches for one
  resolved path. Every consumer whose `require` resolves to that path shares it;
  a second copy of the package elsewhere in the dependency tree resolves to a
  different path and therefore has its own instance.

## 1. Goals and non-goals

### 1.1 Goals

* Specify the configuration of the `defaultLogger` created by `lib/logger.js`.
* Specify the `getLogger` contract, including its fallback and the sharing that
  follows from the default logger being module-level.

### 1.2 Non-goals

* winston's own API surface and formatting semantics, including how a
  logger-level format and a transport-level format combine to produce rendered
  output. That is a third-party contract; the dependency is named in
  [overview.md §4]. This spec transcribes both configurations as written and
  asserts nothing about rendered output.
* Log call sites and message content elsewhere in the library. Those belong to
  the specs owning those subsystems.

## 2. Default logger

`lib/logger.js` MUST create one winston logger, `defaultLogger`, at module
evaluation time — that is, when the module is first required — and MUST NOT
create it lazily per call.

The logger MUST be created with:

| Setting | Value |
|---------|-------|
| Logger `level` | `'info'` |
| Logger `format` | `winston.format.simple()` |
| Transports | exactly one `winston.transports.Console` |

The single Console transport MUST be created with:

| Setting | Value |
|---------|-------|
| Transport `level` | `'info'` |
| Transport `format` | `winston.format.combine(winston.format.timestamp(), winston.format.simple())`, with `timestamp()` first |

`defaultLogger` MUST NOT be exported. `getLogger` (§3) is the only handle on it.

Because `defaultLogger` is created once at module level, every consumer that
resolves to the same loaded module instance and does not supply its own logger
receives that same object. Mutating it — adding or removing a transport,
changing `level`, or attaching a format — therefore changes it for all such
consumers. The scope of that sharing is the loaded module instance, not the
process: two copies of `special-mail-lib` in one dependency tree each create
their own `defaultLogger`, and a transport added through one is not visible
through the other.

## 3. getLogger

`getLogger` is exported from `index.js` through the spread of `lib/logger.js`.
It MUST have the signature `getLogger(options = {})`.

`getLogger` MUST return `options.logger` when that value is truthy, and MUST
return the default logger of §2 otherwise. It MUST NOT inspect any other
property of `options`, MUST NOT copy or wrap the logger it returns, and MUST NOT
throw for a missing or empty `options`.

The `options = {}` default parameter means a call with no argument is valid and
MUST return the default logger. A falsy `options.logger` — absent, `undefined`,
`null`, or any other falsy value — MUST fall back to the default logger rather
than being returned.

## 4. Tests checklist

### 4.1 Default logger configuration

* The values in §2 match the `defaultLogger` created in `lib/logger.js` as
  written: the logger `level`, the logger `format`, the count of transports, the
  single Console transport's `level`, and that transport's combined format
  including the order of `timestamp()` and `simple()` within it.

### 4.2 getLogger

* `getLogger()` with no argument returns the default logger.
* `getLogger({logger})` returns that logger.
* `getLogger({})` returns the default logger, and so does a call whose
  `options.logger` is falsy.

### 4.3 Sharing

* Two `getLogger()` calls return the same object, including when the second
  follows a further `require` of the same module path — the instance created at
  require time. This is the observable form of §2's sharing claim, and the only
  one available, since `defaultLogger` is not exported.
