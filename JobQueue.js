const jobClasses = require('./job-classes');
const jobTypes = require('./job-types');
const urlJoin = require('url-join');
const {
  getEnvironment,
  allPromises
} = require('./util');

class JobQueue {
  constructor(options = {}) {
    this._options = {
      ...options
    };
    this._jobOptions = {
      ...(options.jobOptions || {}),
      queue: this
    };
    this._jobClasses = {
      ...jobClasses,
      ...(options.jobClasses || {})
    };
    const PgBoss = require('pg-boss');
    const pgBossOptions = {
      host: options.host || 'localhost',
      port: options.port || 5432,
      database: options.database || 'mailqueue',
      user: options.user || 'mailqueue',
      password: options.password,
      monitorStateIntervalMinutes: options.monitorStateIntervalMinutes || 10
    };
    this._queue = new PgBoss(pgBossOptions);
  }

  async _processJob(job) {
    if (!job.data) {
      console.error('Invalid job: no data field in the job');
      return;
    }
    const {JobClass, optionsField} = this._jobClasses[job.data.job];

    if (!JobClass) {
      console.error('Invalid job type: ', job.data);
      return;
    }

    const item = job.data;
    const jobInstance = new JobClass(item, this._jobOptions, optionsField);
    await jobInstance.process();
  }


  async start() {
    await this._queue.start();
  }

  async subscribe(options) {
    const self = this;
    const queuename = options.queuename || this._options.queuename || 'mail-*';
    const teamSize = options.teamSize || this._options.teamSize || 100;
    const teamConcurrency = options.teamConcurrency ||
      this._options.teamConcurrency ||
      100;
    const newJobCheckInterval = options.newJobCheckInterval ||
      this._options.newJobCheckInterval ||
      10;
    await this._queue.subscribe(
      queuename,
      {
        teamSize,
        teamConcurrency,
        newJobCheckIntervalSeconds: newJobCheckInterval
      },
      async function(job) {
        await self._processJob(job);
      }
    );
  }

  async pushItem(item, queueName = 'mail-main') {
    try {
      await this._queue.publish({
        name: queueName,
        data: item,
        options: {
          retryLimit: 192,
          retryDelay: 600,
          expireIn: '2 days'
        }
      });
      return true;
    } catch (err) {
      //just log the error.
      console.error(
        'ERROR: unexpected error occurred while queuing the item',
        err
      );
    }
  }

  async notify(target, type, content, options = {}) {
    try {
      if (Array.isArray(target)) {
        return this._notifyAll(target, type, content, options);
      } else if (typeof target == 'string') {
        const parts = target.split('@');
        target = parts[parts.length - 1];
      } else {
        target = target.host;
      }
      if (!target) {
        throw new Error(`Invalid notification target: ${target}`);
      }

      const environment =  getEnvironment(target, this._jobOptions);
      if (!environment) {
        throw new Error(`Could not find and environment for ${target}`);
      }
      //const routingConfig = this._jobOptions.routingConfig;
      let url = urlJoin(environment.baseUrl, environment.notificationPostUri);
      let headers = environment.emailNotificationHeaders || {};
      let auth = environment.emailNotificationAuth;
      if (options.directNotificationUrl) {
        url = options.directNotificationUrl;
        headers = options.directNotificationHeaders;
        auth = options.directNotificationAuth;
      }

      const request = {
        url,
        headers,
        data: {
          notificationType: type,
          content,
          target
        },
        auth
      };
      await this.pushItem({
        job: jobTypes.POST,
        request
      }, 'mail-notify');
    } catch (err) {
      console.error(`Notifying ${target} failed`, err);
    }
  }

  async _notifyAll(targetDomains, type, content, options) {
    const self = this;
    const promises = targetDomains.map(x => self.notify(
      x.host,
      type,
      content,
      options
    ));

    await allPromises(promises);
  }
}

const createJobQueue = async function(options) {
  const queue = new JobQueue(options);
  await queue.start();
  await queue.subscribe(options);
  return queue;
};

module.exports = {
  JobQueue,
  createJobQueue
};
