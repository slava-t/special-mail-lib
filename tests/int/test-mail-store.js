const assert = require('assert').strict;
const crypto = require('crypto');
const MailStore = require('./lib/MailStore');

describe('mail store dependency compatibility', function() {
  this.timeout(15000);
  let store;
  let schema;

  beforeEach(async function() {
    schema = `mail_store_${crypto.randomBytes(8).toString('hex')}`;
    store = MailStore.createMailStore('sml-integration-tests', {
      dbName: 'queue', dbUser: 'queue', host: 'db', port: 5432,
      schema, logging: false,
      pool: {max: 2, min: 0, acquire: 5000}
    });
    await store.model.sequelize.createSchema(schema);
    await store.sync();
  });

  afterEach(async function() {
    if (store) {
      try {
        await store.model.sequelize.dropSchema(schema, {cascade: true});
      } finally {
        await store.model.sequelize.close();
      }
    }
  });

  it('round-trips nested JSONB with normalized inbox and group operations',
    async () => {
      const data = {subject: 'fixture', nested: {items: [1, null, {ok: true}]}};
      const first = await store.saveEmail('USER@EXAMPLE.COM', data, 'GROUP');
      const second = await store.saveEmail('user@example.com', null, 'group');
      // Fixed timestamps keep ordering assertions independent of the clock.
      await first.update({['created_at']: new Date('2020-01-01T00:00:00Z')});
      await second.update({['created_at']: new Date('2020-01-02T00:00:00Z')});
      assert.equal(first.address, 'user@example.com');
      assert.equal(first.group, 'group');
      assert.deepEqual((await store.getEmail(first.id)).data, data);
      assert.equal((await store.getEmail(second.id)).data, null);
      assert.equal(await store.getInboxEmailCount('USER@EXAMPLE.COM'), 2);
      assert.equal((await store.getInboxLastEmail('USER@EXAMPLE.COM')).id,
        second.id);
      assert.equal((await store.getGroupLastEmail('GROUP')).id, second.id);
      assert.deepEqual((await store.getInboxEmails('USER@EXAMPLE.COM'))
          .map(email => email.id), [second.id, first.id]);
      assert.deepEqual((await store.getGroupEmails('GROUP'))
          .map(email => email.id), [second.id, first.id]);
      assert.equal(await store.deleteEmail(first.id), 1);
      assert.equal(await store.getEmail(first.id), null);
      assert.equal(await store.deleteInbox('USER@EXAMPLE.COM'), 1);
      assert.equal(await store.getInboxEmailCount('user@example.com'), 0);
      await store.saveEmail('other@example.com', data, 'GROUP');
      await store.saveEmail('keep@example.com', data, 'keep');
      assert.equal(await store.deleteGroup('GROUP'), 1);
      assert.equal(await store.getInboxEmailCount('keep@example.com'), 1);
    });

  it('rolls back real writes and preserves the original callback error',
    async () => {
      const expected = new Error('fixture rollback');
      await assert.rejects(store.transaction(async transaction => {
        await store.model.TestEmail.create({
          address: 'rollback@example.com', data: {rollback: true}
        }, {transaction});
        throw expected;
      }), err => err === expected);
      assert.equal(await store.getInboxEmailCount('rollback@example.com'), 0);
    });

  it('retries a controlled 40001 callback error with a new transaction',
    async () => {
      const transactions = [];
      const saved = await store.transaction(async transaction => {
        transactions.push(transaction);
        const row = await store.model.TestEmail.create({
          address: 'retry@example.com', data: {attempt: transactions.length}
        }, {transaction});
        if (transactions.length === 1) {
          const error = new Error('fixture serialization failure');
          error.original = {code: '40001'};
          throw error;
        }
        return row;
      });
      assert.equal(transactions.length, 2);
      assert.notEqual(transactions[0], transactions[1]);
      assert.equal(transactions[0].finished, 'rollback');
      assert.equal(transactions[1].finished, 'commit');
      assert.equal(await store.getInboxEmailCount('retry@example.com'), 1);
      assert.deepEqual((await store.getEmail(saved.id)).data, {attempt: 2});
    });
});
