# Mail Store Spec (v1.0)

This spec describes `special-mail-lib` v4.7.10 as implemented.

Covers the mail-store model factory and `MailStore` class exported from
`index.js` as `mailStoreModel` and `MailStore`. The factory owns the Sequelize
connection arguments, the `TestEmail` model definition and the table/index
options. The class owns synchronization, message persistence queries, deletion,
transaction retrying and scheduled cleanup.

## 0. Glossary

Terms with a specific technical meaning in this file. Cross-cutting terms are
defined once in [overview.md §0] and are not redefined here: this file uses
**Mail**, **Inbox** and **Group** as that glossary defines them.

* **Model factory**: the function exported by `lib/mail-store-model.js`, reached
  from `index.js` as `mailStoreModel`.
* **Store model**: the object returned by the model factory, carrying the
  Sequelize instance, the Sequelize module object and the `TestEmail` model.
* **TestEmail row**: one row in the `test_emails` table, represented by the
  model named `testEmail`.
* **Transaction callback**: the function supplied to `MailStore.transaction`,
  called with a Sequelize transaction object.
* **Cleanup process**: the interval installed by `startCleanUpProcess`, which
  deletes old mail rows until the interval is stopped or the process exits.

## 1. Goals and non-goals

### 1.1 Goals

* Specify the model factory signature, connection defaults, option precedence,
  returned object and `TestEmail` schema.
* Specify `MailStore` construction, static creation and synchronization.
* Specify the class methods that create, read, count and delete stored mail.
* Specify the transaction retry loop, including commit, rollback, logging and
  retry delay behavior.
* Specify the cleanup interval lifecycle and the exact method names, time-unit
  conversions and log messages involved.

### 1.2 Non-goals

* Sequelize's own connection, model, transaction, query, index and synchronization
  semantics. [overview.md §4] names Sequelize as a third-party dependency. This
  spec states only which Sequelize calls the library makes and which arguments it
  supplies.
* Winston logger internals and default logger construction. `MailStore` obtains
  a logger through `getLogger()`; [logging.md §2] and [logging.md §3] own the
  logger contract.
* The unrelated `saveEmail` helper exported from `lib/util.js`. [utilities.md
  §10] owns that function. This file owns only `MailStore.saveEmail`.
* Database migrations, schema provisioning and storage engine behavior outside
  the values supplied by this library.

## 2. Model factory and connection

The model factory MUST be the function exported by `lib/mail-store-model.js` and
re-exported from `index.js` as `mailStoreModel`. It MUST have the signature:

```
mailStoreModel(password, options = {})
```

The `options = {}` default means a call with only `password` is valid. A `null`
second argument is not replaced by the default and raises on the first property
read.

The factory MUST create one Sequelize instance by calling `new Sequelize` with
these positional arguments:

| Position | Value |
|----------|-------|
| 1 | `options.dbName || 'mailstore'` |
| 2 | `options.dbUser || 'mailstore'` |
| 3 | `password` |
| 4 | the connection options object defined below |

The first two positional arguments default on JavaScript truthiness. A falsy
`options.dbName` or `options.dbUser` therefore becomes `'mailstore'`, not the
falsy value supplied by the caller. The password is passed through unchanged.

The connection options object MUST be built with these fields before the final
caller spread:

| Field | Value before caller spread |
|-------|----------------------------|
| `dialect` | `'postgres'` |
| `host` | `'localhost'` |
| `port` | `5432` |
| `schema` | `options.schema || 'main'` |

The object MUST then spread `...options` after those fields. The spread is the
final conflict rule: a caller-owned key in `options` replaces any earlier
connection option with the same key, including `dialect`, `host`, `port` and
`schema`. For `schema`, the library first computes the fallback value
`options.schema || 'main'`; then the final spread can replace that key with the
caller-owned `options.schema` value, including a falsy value.

The factory MUST return a store model object containing exactly the factory's
own initial keys `sequelize` and `Sequelize`, then the `TestEmail` model added
in §3. The `sequelize` key is the instance just constructed. The `Sequelize` key
is the module object required from `sequelize`.

## 3. TestEmail model

The model factory MUST define `model.TestEmail` by calling
`sequelize.define('testEmail', fields, options)`.

The fields object MUST contain these five fields:

| Field | Definition |
|-------|------------|
| `id` | `type: Sequelize.BIGINT`, `primaryKey: true`, `allowNull: false`, `autoIncrement: true` |
| `address` | `type: Sequelize.STRING(128)`, `allowNull: false` |
| `data` | `type: Sequelize.JSONB`, `allowNull: true` |
| `created_at` | `type: Sequelize.DATE`, `allowNull: false`, `defaultValue: Sequelize.NOW` |
| `group` | `type: Sequelize.STRING(32)`, `allowNull: true` |

The model options object MUST set `timestamps: false` and `tableName: 'test_emails'`
as the table options.

The model options object MUST also set exactly these three indexes, in this
order:

| Index name | `unique` | Fields |
|------------|----------|--------|
| `email_address_index` | `false` | `['address', 'created_at']` |
| `email_group_index` | `false` | `['group', 'address', 'created_at']` |
| `eamail_created_at_index` | `false` | `['created_at']` |

The spelling `eamail_created_at_index` MUST be preserved. The index list is the
list supplied by the library; database-level enforcement and planner behavior are
outside this spec (§1.2).

## 4. Construction and synchronization

`MailStore` MUST be the class exported by `lib/MailStore.js` and re-exported
from `index.js` as `MailStore`.

The constructor signature MUST be `constructor(model)`. It MUST perform these
assignments in order:

1. Store `getLogger()` as `this.logger`.
2. Store the `model` argument itself as `this.model`.
3. Store `null` as `this.cleanUpIntervalId`.

The logger call supplies no options object. A caller-supplied logger passed to
another library surface therefore does not reach `MailStore` construction through
this constructor.

`MailStore.createMailStore(password, options = {})` MUST be a static method. It
MUST call the model factory as `createModel(password, options)`, construct
`new MailStore(model)` with that returned model, and return the new instance.
The `options = {}` default means a call with only `password` is valid.

`sync()` MUST return `this.model.sequelize.sync()` and MUST pass no arguments.
It MUST NOT catch a rejection or wrap the returned promise.

## 5. Write and read methods

Every method in this section MUST perform its Sequelize operation inside
`this.transaction`, passing a callback that receives the transaction object and
supplies it under the `transaction` option key.

`saveEmail(address, data, group = null)` MUST create one `TestEmail` row through
`this.model.TestEmail.create`. The row object MUST contain:

| Field | Value |
|-------|-------|
| `address` | `address.toLowerCase()` |
| `group` | `group ? group.toLowerCase() : group` |
| `data` | the `data` argument |

The `group` default is `null`. Any falsy group value is stored as supplied after
the truthiness test; it is not lowercased. A truthy group value MUST be
lowercased before it is stored. The method MUST return the create result from the
transaction callback.

`getEmail(id)` MUST call `findOne` with `where: {id}` and MUST return the result.

`getInboxLastEmail(address)` MUST call `findAll` with:

| Option | Value |
|--------|-------|
| `where` | `{address: address.toLowerCase()}` |
| `order` | `[['created_at', 'DESC']]` |
| `limit` | `1` |

It MUST test the transaction result for truthiness. When the result is truthy,
it MUST return element `0`; when the result is falsy, it MUST return `null`.
Consequently, if the result is a truthy empty array, the method returns
`undefined`.

`getGroupLastEmail(group)` MUST be the same latest-row query shape as
`getInboxLastEmail`, except the `where` object MUST be
`{group: group.toLowerCase()}`.

`getInboxEmails(address)` MUST call `findAll` with `where:
{address: address.toLowerCase()}`, `order: [['created_at', 'DESC']]`, and the
transaction option. It MUST return the find result unchanged.

`getInboxEmailCount(address)` MUST call `count` with `where:
{address: address.toLowerCase()}` and the transaction option. It MUST return the
count result unchanged.

`getGroupEmails(group)` MUST call `findAll` with `where:
{group: group.toLowerCase()}`, `order: [['created_at', 'DESC']]`, and the
transaction option. It MUST return the find result unchanged.

These methods do not guard `address`, `group` or `id`. A value that cannot be
used by the stated operation reaches the operation or the lowercasing call as
given.

## 6. Delete methods

Every method in this section MUST perform its Sequelize operation inside
`this.transaction`, passing the transaction object under the `transaction` option
key, and MUST return the destroy result unchanged.

`deleteAllBefore(date)` MUST call `this.model.TestEmail.destroy` with a `where`
object whose only key is `created_at`, and whose value is an object keyed by
`this.model.Sequelize.Op.lt` with `date` as its value.

`deleteEmail(id)` MUST call `destroy` with `where: {id}`.

`deleteInbox(address)` MUST call `destroy` with `where:
{address: address.toLowerCase()}`.

`deleteGroup(group)` MUST call `destroy` with `where:
{group: group.toLowerCase()}`.

The delete methods do not guard their inputs. The date, id, address and group
values reach the stated object construction as supplied, except for the
lowercasing calls in the inbox and group methods.

## 7. Transactions

`transaction(func)` MUST be asynchronous and MUST retry inside an unbounded
`while (true)` loop until it either commits successfully or rethrows a
non-retry error.

On each attempt it MUST:

1. Initialize a local transaction binding to `undefined`.
2. Await `this.model.sequelize.transaction` with:

   | Option | Value |
   |--------|-------|
   | `isolationLevel` | `'SERIALIZABLE'` |
   | `type` | `'IMMEDIATE'` |

3. Store the resulting transaction object in the local binding.
4. Await `func(t)` with that transaction object.
5. Await `t.commit()`.
6. Return the callback result.

When any statement in steps 2-5 throws or rejects, `transaction` MUST enter its
catch path. The catch path MUST first attempt rollback inside its own `try`
block, and MUST call `t.rollback()` only when the local transaction binding is
truthy.

If the rollback attempt itself throws or rejects, `transaction` MUST log through
`this.logger.error` with message `Rolling back transaction after error failed`
and the rollback error as the second argument. A rollback failure MUST NOT by
itself decide whether the original error is retried or rethrown.

After the rollback attempt, `transaction` MUST inspect the original error. When
`err.original` is falsy, or when `err.original.code !== '40001'`, it MUST log
through `this.logger.error` with message `Transaciton failed` and the original
error as the second argument, then rethrow that original error.

When `err.original.code === '40001'`, `transaction` MUST wait by awaiting a
promise backed by `setTimeout`. The timeout value MUST be:

```
Math.floor((Math.random() * 100) + 10)
```

After that wait, the loop MUST start another attempt. There is no retry counter,
maximum delay growth or final failure branch for repeated `40001` errors.

## 8. Cleanup process

`startCleanUpProcess(intervalInSeconds, lifetimeInMinutes)` MUST compute:

| Local | Value |
|-------|-------|
| `interval` | `intervalInSeconds * 1000` |
| `lifetime` | `lifetimeInMinutes * 60 * 1000` |

When `this.cleanUpIntervalId` is truthy, the method MUST call
`this.stopCleanupProcess()` before installing a new interval. The called name has
lowercase `u` in `Cleanup`; the defined stop method in §8.2 is
`stopCleanUpProcess`, with uppercase `U` in `CleanUp`. This spec requires the
call as written.

After the restart check, `startCleanUpProcess` MUST assign `this.cleanUpIntervalId`
to the return value of `setInterval(async function() { ... }, interval)`.

### 8.1 Interval callback

The interval callback MUST be an async non-arrow function. On each callback
invocation it MUST:

1. Compute `beforeDate` as `new Date(Date.now() - lifetime)`.
2. Await `self.deleteAllBefore(beforeDate)`, where `self` is the `MailStore`
   instance captured before installing the interval.
3. When the delete result is truthy, log through `self.logger.info` with message
   `` `Cleaning up process: Deleted ${result} emails.` ``.

Those three statements MUST run inside a `try` block. The catch block MUST call
`this.logger.error` with message `An error occurred while cleaning up old
emails.` and the caught error as the second argument. The catch block's `this` is
the callback's own `this`, not the captured `self`; the method MUST NOT rewrite
that call to `self.logger.error`.

When the delete result is falsy, the callback MUST emit no info log.

### 8.2 Stopping cleanup

`stopCleanUpProcess()` MUST check `this.cleanUpIntervalId`. When it is truthy,
it MUST call `clearInterval(this.cleanUpIntervalId)`. When it is falsy, it MUST
do nothing.

The method MUST NOT set `cleanUpIntervalId` back to `null` after clearing the
interval. A later `startCleanUpProcess` call therefore still sees the stored
truthy value unless something else changes it.

## 9. Tests checklist

### 9.1 Model factory and `TestEmail`

* Calling the model factory with only `password` supplies database name
  `mailstore`, user `mailstore`, password as given, and connection options with
  `dialect: 'postgres'`, `host: 'localhost'`, `port: 5432` and initial
  `schema: 'main'`.
* A caller option key that collides with a fixed connection option wins because
  `...options` is spread last. Include `schema` with a falsy caller-owned value
  to catch a description that stops at the pre-spread `options.schema || 'main'`
  fallback.
* The returned store model carries `sequelize`, `Sequelize` and `TestEmail`; the
  `TestEmail` fields, table name and three index definitions match §3 exactly,
  including `eamail_created_at_index`.

### 9.2 Construction and synchronization

* `new MailStore(model)` calls `getLogger()` with no options, stores the model
  object itself and initializes `cleanUpIntervalId` to `null`.
* `MailStore.createMailStore(password, options)` calls the model factory with
  those same two arguments and wraps the returned model in a new `MailStore`.
* `sync()` returns `this.model.sequelize.sync()` without arguments.

### 9.3 Write and read methods

* `saveEmail(address, data)` lowercases the address, stores `group: null`, stores
  the data argument as given and returns the create result from the transaction.
  A truthy group is lowercased; a falsy non-default group is stored as supplied.
* `getInboxLastEmail` and `getGroupLastEmail` use `findAll` with descending
  `created_at` order and `limit: 1`, then return element `0` for any truthy
  result, so a truthy empty array yields `undefined` rather than `null`.
* The list and count methods lowercase only the address or group field named by
  their method and return the query result unchanged.

### 9.4 Delete methods

* `deleteAllBefore(date)` destroys rows whose `created_at` is below `date` using
  `this.model.Sequelize.Op.lt`.
* `deleteEmail`, `deleteInbox` and `deleteGroup` use exactly the where clauses
  in §6 and return the destroy result unchanged.

### 9.5 Transactions

* A successful callback is awaited, then the transaction is committed, and the
  callback result is returned.
* A non-`40001` error attempts rollback, logs `Transaciton failed` with the
  original error and rethrows that same error.
* A `40001` error attempts rollback, waits `Math.floor((Math.random() * 100) +
  10)` milliseconds and retries without a limit.
* A rollback failure logs `Rolling back transaction after error failed` but does
  not replace the original error or decide the retry branch.

### 9.6 Cleanup

* `startCleanUpProcess` converts seconds to milliseconds for the interval and
  minutes to milliseconds for the lifetime, then deletes mail older than
  `Date.now() - lifetime` on each callback.
* A truthy existing `cleanUpIntervalId` calls `stopCleanupProcess()` with
  lowercase `u` in `Cleanup`, not the defined `stopCleanUpProcess()` name.
* A truthy delete result logs `Cleaning up process: Deleted ${result} emails.`;
  a falsy delete result emits no info log.
* The callback catch uses `this.logger.error`, not `self.logger.error`, and
  passes `An error occurred while cleaning up old emails.` with the caught error.
* `stopCleanUpProcess` clears a truthy interval id but leaves the stored value in
  place instead of resetting it to `null`.
