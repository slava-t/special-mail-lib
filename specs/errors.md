# Errors Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the library's structured error values: the `createError` factory exported
from `index.js` and the message-template catalog it formats against.

## 0. Glossary

* **Error code**: the string key identifying an entry in the error catalog, for
  example `MxPriorityTooLow`. It is also the value of the `error` property on a
  created error object.
* **Error object**: the plain object `createError` returns, carrying `error`,
  `params` and `message`.
* **Message template**: the string stored under an error catalog entry's
  `message` property, containing zero or more positional parameters.
* **Positional parameter**: a `{N}` placeholder in a message template, where `N`
  is a zero-based index into the parameter array supplied to `createError`.

## 1. Goals and non-goals

### 1.1 Goals

* Specify the signature, return value and lookup behavior of `createError`.
* Enumerate every entry of the error catalog with its exact message template and
  the positional parameters that template uses.

### 1.2 Non-goals

* The placeholder grammar of the `string-template` package beyond the `{N}`
  positional form the catalog uses. That is a third-party contract; the
  dependency is named in [overview.md §4].
* The circumstances under which each error code is raised. Those belong to the
  specs owning the subsystems that raise them — `mx-verification.md` and
  `domain-verification.md` for the MX, SPF and DKIM codes.

## 2. createError

`createError` is exported from `index.js`, which re-exports the `createError`
property of `lib/error.js`. It MUST have the signature
`createError(error, ...params)`: a first argument naming an error code, followed
by zero or more further arguments collected into a rest array.

`createError` MUST return a new plain object with exactly three own properties,
in this order:

| Property | Value |
|----------|-------|
| `error` | the error code the returned message was formatted from, after the fallback in this section is applied |
| `params` | the rest array, exactly as collected from the call |
| `message` | the catalog entry's message template, formatted over `params` |

The lookup MUST use `Object.prototype.hasOwnProperty.call` against the `errors`
catalog in `lib/error.js`. When the first argument is **not** an own property of
that catalog, `createError` MUST replace it with `UnknownError` before
formatting. The replacement therefore applies to unknown strings and equally to
keys inherited from `Object.prototype`, such as `toString`, which are reachable
by `in` or by property access but are not own properties.

Because the replacement happens before the returned object is built, a
fallback result MUST carry `error` `'UnknownError'` and `message`
`Unknown error`, while `params` MUST still be the rest array exactly as passed.
The arguments are not discarded by the fallback; they are preserved on a result
whose message has no placeholders to consume them.

`message` MUST be produced by applying `string-template` to the entry's message
template with the `params` array as its single substitution argument, so `{N}`
resolves to `params[N]`. `createError` MUST NOT validate the number of
parameters against the template: a template placeholder with no corresponding
element and a parameter with no corresponding placeholder are both accepted, and
the result is whatever `string-template` produces.

`createError` MUST NOT throw for any first argument, and MUST NOT mutate the
catalog.

The `errors` catalog itself is module-private in `lib/error.js`; it is not
exported, and `createError` is the only handle on it.

## 3. Error catalog

The `errors` catalog in `lib/error.js` MUST contain exactly the twelve entries
below. Each entry MUST be an object whose only property is `message`, holding
the message template shown. Templates are given exactly as they render, with
every entry built from more than one string literal shown as the joined string.

| Error code | Positional parameters | Message template |
|------------|----------------------|------------------|
| `MxPriorityTooLow` | `{0}`, `{1}` | `The priority for MX record '{1} {0}' is too high(the value {1} is too low)` |
| `MxPriorityTooHigh` | `{0}`, `{1}` | `The priority for MX record '{1} {0}' is too low(the value {1} is too high)` |
| `MxMissingInExchange` | `{0}` | `Missing MX record for {0}` |
| `MxMissingOutExchange` | none | `No MX records for target servers found.` |
| `DnsGettingMxRecordsFailed` | `{0}` | `Getting MX records for domain {0} failed` |
| `DnsGettingARecordsFailed` | `{0}` | `Getting A records for domain {0} failed` |
| `SpfFailed` | `{0}`, `{1}`, `{2}`, `{3}`, `{4}` | `Spf validation did not pass for the domain {0} for mail server {1} (ip: {2}). Verification code: {3}. Message: '{4}'.` |
| `DkimGettingValueFailed` | `{0}` | `Server error. Dkim value could not be read for the domain {0}` |
| `DkimDnsResolveError` | `{0}`, `{1}` | `Could not get the TXT record for {0}. Message: '{1}'` |
| `DkimMultipleRecords` | `{0}` | `Multiple TXT records found for {0}` |
| `DkimKeyMismatch` | `{0}`, `{1}` | `The DKIM text value does not match with the expected one for the domain {0}(dkimId: {1}` |
| `UnknownError` | none | `Unknown error` |

`UnknownError` MUST be present as a catalog entry, because §2's fallback formats
against it.

Four of the twelve templates are built by concatenating two string literals:
`MxPriorityTooLow`, `MxPriorityTooHigh`, `SpfFailed` and `DkimKeyMismatch`. The
table gives each as the joined string, which is what `createError` formats and
what a caller receives.

## 4. Tests checklist

### 4.1 createError

* `createError(code, ...params)` with a `code` that is an own property of the
  `errors` catalog in `lib/error.js` returns `{error, params, message}` with
  `error` unchanged, `params` the rest array exactly as passed, and `message`
  the catalog template for that code formatted over that array.
* `createError` with a `code` that is not an own property of the catalog returns
  `error` `'UnknownError'` and `message` `Unknown error`, with the passed
  `params` preserved on the result. Cover an inherited key —
  `createError('toString')` — alongside an unknown string. An unknown string
  behaves the same under all three lookup forms, so only the inherited key
  distinguishes §2's `Object.prototype.hasOwnProperty.call` guard from
  `errors[code]` or `code in errors`.

### 4.2 Catalog transcription

* Each of the twelve entries in §3 reproduces, character for character, the
  message template of the same-named key in the `errors` catalog in
  `lib/error.js` — placeholder indices, embedded quoting, and the text on both
  sides of every `+` concatenation included. The four entries whose templates
  cross a concatenation are `MxPriorityTooLow`, `MxPriorityTooHigh`, `SpfFailed`
  and `DkimKeyMismatch`; check those against the joined string, not against
  either literal.
