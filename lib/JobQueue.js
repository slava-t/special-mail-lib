const jobClasses = require('./jobs/job-classes');
const jobTypes = require('./jobs/job-types');
const {getLogger} = require('./logger');
const {
  getEnvironment,
  allPromises,
  extractGuid,
  urlJoin
} = require('./util');

class JobQueue {
  constructor(options = {}) {
    this._options = {
      ...options
    };
    this._logger = getLogger(this._options);
    this._failHandler = options.failHandler;
    this._jobOptions = {
      logger: this._logger,
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
      monitorStateIntervalSeconds: options.monitorStateIntervalSeconds || 600,
      maintenanceIntervalSeconds: options.maintenanceIntervalSeconds || 600,
    };
    this._queue = new PgBoss(pgBossOptions);
    this._resolver = this._jobOptions.resolver;
    this._queue.on(
      'error',
      error => this._logger.error('An error occurred in pg-boss', error)
    );
  }

  async _processJob(job) {
    if (!job.data) {
      this._logger.error('Invalid job: no data field in the job');
      return;
    }
    const {JobClass, optionsField} = this._jobClasses[job.data.job];

    if (!JobClass) {
      this._logger.error('Invalid job type: ', job.data);
      return;
    }

    const item = job.data;
    delete(item.queueOptions);
    const jobInstance = new JobClass(item, this._jobOptions, optionsField);
    await jobInstance.process();
  }


  async start(options) {
    await this._queue.start(options);
  }

  async stop() {
    await this._queue.stop();
  }

  async subscribe(options) {
    const self = this;
    const queuename = options.queuename || this._options.queuename || 'mail-*';
    const teamSize = options.teamSize || this._options.teamSize || 100;
    const teamConcurrency = options.teamConcurrency ||
      self._options.teamConcurrency ||
      100;
    const newJobCheckInterval = options.newJobCheckInterval ||
      self._options.newJobCheckInterval ||
      10;
    await self._queue.work(
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

    await self._queue.onComplete(
      queuename,
      async function(job) {
        const item = {...job.data.request.data};
        const queueOptions = item.queueOptions || {};
        if (job.data.failed) {
          let failType = 'in.job.fail.complete';
          if (queueOptions.pushIfFail) {
            delete queueOptions.pushIfFail;
            const queueName = job.data.request.name;
            self.pushItem(item, queueName);
            failType = 'in.job.fail.partial';
          }
          if (self._failHandler) {
            try {
              await self._failHandler(failType, job);
            } catch (err) {
              //just log the error
              self._logger.error(
                'ERROR: unexpected error occured while ' +
                'processing a job failure',
                err
              );
            }
          }
        }
      }
    );
  }

  async pushTrackedItem(item, queueName = 'mail-main') {
    try {
      await this._queue.send({
        name: queueName,
        data: {
          ...item,
          queueOptions: {
            pushIfFail: true
          }
        },
        options: {
          retryLimit: 3,
          retryDelay: 600,
          expireInSeconds: 1800
        }
      });
      return true;
    } catch (err) {
      //just log the error
      this._logger.error(
        'ERROR: unexpected error occured while queueing a two staged item',
        err
      );
    }
  }

  async pushItem(item, queueName = 'mail-main') {
    try {
      await this._queue.send({
        name: queueName,
        data: item,
        options: {
          retryLimit: 288,
          retryDelay: 600,
          expireInSeconds: 1800
        }
      });
      return true;
    } catch (err) {
      //just log the error.
      this._logger.error(
        'ERROR: unexpected error occurred while queueing an item',
        err
      );
    }
  }

  async notify(target, type, content, options = {}, guid) {
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
      if (!guid) {
        guid = extractGuid(content);
      }

      let url;
      let headers = {};
      let auth;

      const res = this._resolver.createUrl(target);
      if (res && res.index >= 0) {
        url = res.notificationUrl;
        headers = res.headers;
      } else {
        const environment =  getEnvironment(target, this._jobOptions);
        if (!environment) {
          throw new Error(`Could not find and environment for ${target}`);
        }
        url = urlJoin(
          environment.baseUrl,
          environment.notificationPostUri
        );
        headers = environment.notificationPostHeaders || {};
        auth = environment.notificationPostAuth;
      }

      if (options.directNotificationUrl) {
        url = options.directNotificationUrl;
        headers = options.directNotificationHeaders;
        auth = options.directNotificationAuth;
      }
      this._logger.info('--- JobQueue notify request ready ---', {url, target});
      const request = {
        url,
        headers,
        data: {
          notificationType: type,
          guid,
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
      this._logger.error(`Notifying ${target} failed`, err);
    }
  }

  async _notifyAll(targetDomains, type, content, options) {
    const self = this;
    const promises = targetDomains.map(x => self.notify(
      x.host,
      type,
      content,
      options,
      x.guid
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
