const createModel = require('./mail-store-model.js');
const {getLogger} = require('./logger.js');

module.exports = class MailStore {
  constructor(model) {
    this.logger = getLogger();
    this.model = model;
    this.cleanUpIntervalId = null;
  }

  static createMailStore(password, options = {}) {
    const model = createModel(password, options);
    return new MailStore(model);
  }

  sync() {
    return this.model.sequelize.sync();
  }

  async saveEmail(address, data, group = null) {
    const self = this;
    const result = await self.transaction(function(transaction) {
      return self.model.TestEmail.create({
        address: address.toLowerCase(),
        group: group ? group.toLowerCase() : group,
        data
      }, {transaction});
    });
    return result;
  }

  async getEmail(id) {
    const self = this;
    const email = await self.transaction(function(transaction) {
      return self.model.TestEmail.findOne({
        where: {id},
        transaction
      });
    });
    return email;
  }

  async getInboxLastEmail(address) {
    const self = this;
    const emails = await self.transaction(function(transaction) {
      return self.model.TestEmail.findAll({
        where: {address: address.toLowerCase()},
        order: [['created_at', 'DESC']],
        limit: 1,
        transaction
      });
    });
    return emails ? emails[0] : null;
  }

  async getGroupLastEmail(group) {
    const self = this;
    const emails = await self.transaction(function(transaction) {
      return self.model.TestEmail.findAll({
        where: {group: group.toLowerCase()},
        order: [['created_at', 'DESC']],
        limit: 1,
        transaction
      });
    });
    return emails ? emails[0] : null;
  }

  async getInboxEmails(address) {
    const self = this;
    const emails = await self.transaction(function(transaction) {
      return self.model.TestEmail.findAll({
        where: {address: address.toLowerCase()},
        order: [['created_at', 'DESC']],
        transaction
      });
    });
    return emails;
  }

  async getInboxEmailCount(address) {
    const self = this;
    const count = await self.transaction(function(transaction) {
      return self.model.TestEmail.count({
        where: {address: address.toLowerCase()},
        transaction
      });
    });
    return count;
  }

  async getGroupEmails(group) {
    const self = this;
    const emails = await self.transaction(function(transaction) {
      return self.model.TestEmail.findAll({
        where: {group: group.toLowerCase()},
        order: [['created_at', 'DESC']],
        transaction
      });
    });
    return emails;
  }

  async deleteAllBefore(date) {
    const self = this;
    const result = await self.transaction(function(transaction) {
      return self.model.TestEmail.destroy({
        where: {
          ['created_at']: {
            [self.model.Sequelize.Op.lt]: date
          }
        },
        transaction
      });
    });
    return result;
  }

  async deleteEmail(id) {
    const self = this;
    const result = await self.transaction(function(transaction) {
      return self.model.TestEmail.destroy({
        where: {id},
        transaction
      });
    });
    return result;
  }

  async deleteInbox(address) {
    const self = this;
    const result = await self.transaction(function(transaction) {
      return self.model.TestEmail.destroy({
        where: {address: address.toLowerCase()},
        transaction
      });
    });
    return result;
  }

  async deleteGroup(group) {
    const self = this;
    const result = await self.transaction(function(transaction) {
      return self.model.TestEmail.destroy({
        where: {group: group.toLowerCase()},
        transaction
      });
    });
    return result;
  }

  async transaction(func) {
    const self = this;
    while (true) {
      let t;
      try {
        t = await self.model.sequelize.transaction({
          isolationLevel: 'SERIALIZABLE',
          type: 'IMMEDIATE'
        });
        const result = await func(t);
        await t.commit();
        return result;
      } catch (err) {
        try {
          if (t) {
            await t.rollback();
          }
        } catch (e) {
          this.logger.error('Rolling back transaction after error failed', e);
        }
        if (!err.original || err.original.code !== '40001') {
          this.logger.error('Transaciton failed', err);
          throw err;
        }

        //wait for 10 + random milliseconds to avoid racing
        await new Promise(resolve => setTimeout(
          resolve,
          Math.floor((Math.random() * 100) + 10)
        ));
      }
    }
  }

  startCleanUpProcess(intervalInSeconds, lifetimeInMinutes) {
    const self = this;

    const interval = intervalInSeconds * 1000;
    const lifetime = lifetimeInMinutes * 60 * 1000;

    if (self.cleanUpIntervalId) {
      self.stopCleanupProcess();
    }

    self.cleanUpIntervalId = setInterval(async function() {
      try {
        const beforeDate = new Date(Date.now() - lifetime);
        const result = await self.deleteAllBefore(beforeDate);
        if (result) {
          self.logger.info(
            `Cleaning up process: Deleted ${result} emails.`
          );
        }
      } catch (err) {
        this.logger.error(
          'An error occurred while cleaning up old emails.',
          err
        );
      }
    }, interval);
  }

  stopCleanUpProcess() {
    if (this.cleanUpIntervalId) {
      clearInterval(this.cleanUpIntervalId);
    }
  }
};
