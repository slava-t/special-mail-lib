const assert = require('assert');
const createJobQueue = require('./lib/JobQueue.js').createJobQueue;
const jobTypes = require('./lib/jobs/job-types');
const sleep = require('sleep-promise');

const TIME_OUT = 180 * 1000;

describe('job queue', function() {
  this.timeout(TIME_OUT);
  let queue = null;
  let items = [];
  beforeEach(async function() {
    queue = await createJobQueue({
      database: 'queue',
      host: 'db',
      password: 'sml-integration-tests',
      user: 'queue',
      monitorStateIntervalSeconds: 5,
      maintenanceIntervalSeconds: 5,
      newJobCheckInterval: 2,
      jobOptions: {
        callback: function(arg) {
          items.push(arg);
        }
      }
    });
    assert(!!queue);
  });

  afterEach(async function() {
    await queue.stop();
  });

  it('should process all items', async function() {
    items = [];
    const WAIT_SECONDS = 60;
    const ITEM_COUNT = 1000;
    let waited = 0;
    for (let i = 0; i < ITEM_COUNT; ++i) {
      await queue.pushItem(
        {
          arg: i,
          job: jobTypes.CALLBACK
        },
        'mail-test'
      );
    }
    while (items.length < ITEM_COUNT && waited < WAIT_SECONDS) {
      await sleep(1000);
      waited += 1;
    }
    assert.equal(items.length, ITEM_COUNT);
    items.sort((a, b) => a - b);
    for (let i = 0; i < ITEM_COUNT; ++i) {
      assert.equal(items[i], i);
    }
  });
});
