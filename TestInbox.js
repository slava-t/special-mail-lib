const axios = require('axios');
const crypto = require('crypto');
const sleep = require('sleep-promise');

module.exports = class TestInbox {
  constructor(localName = null, name = null, options = {}) {
    this.options = {
      ...(TestInbox.options || {}),
      ...options
    };
    this.mainDomain = options.mainDomain || 'moment.casa';
    this.localName = localName || TestInbox.generateLocalName();
    this.name = name;
    this.baseUrl = options.baseUrl || `http://${this.mainDomain}:8200`;
    this.apiUrl = options.apiUrl || `${this.baseUrl}/api/v1`;

    this.emailsUrl = 'emails';
    this.sendUrl = 'send';

    this.group = TestInbox.generateGroup(options.group);
    this.groupUrl = this.group ?
      `groups/${this.group}` : this.apiUrl;
    this.groupEmailsUrl = `${this.groupUrl}/emails`;
    this.groupLastEmailUrl = `${this.groupUrl}/last_email}`;

    this.emailDomain = this.group ?
      `${this.group}.${this.mainDomain}` :
      this.mainDomain;
    this.emailAddress = `${this.localName}@${this.emailDomain}`;

    this.inboxUrl = `inboxes/${this.emailAddress}`;
    this.inboxEmailsUrl = `${this.inboxUrl}/emails`;
    this.inboxEmailCountUrl = `${this.inboxUrl}/count`;
    this.inboxLastEmailUrl = `${this.inboxUrl}/last_email`;
    const auth = this.options.auth || {
      username: 'tester',
      password: 'tester'
    };

    //TODO: HACK! Find a better way to deal with auth for post url.
    //      Because this is testing environment it is ok for now.
    this.postUrl = `http://${auth.username}:${auth.password}@` +
      `${this.mainDomain}:8200/api/v1/${this.inboxEmailsUrl}`;

    this.axios = axios.create({
      baseURL: this.apiUrl,
      auth
    });
  }

  createDerivedInbox(localName = null, name = null, options = {}) {
    return new TestInbox(
      localName,
      name,
      {
        ...this.options,
        group: this.group,
        ...options,
      }
    );
  }

  async send(mail) {
    const res = await this.axios({
      method: 'post',
      url: 'send',
      data: {
        from: {
          name: this.name,
          address: this.emailAddress
        },
        ...mail
      }
    });
    return this._extractResult(res);
  }

  async save(mail) {
    const res = await this.axios({
      method: 'post',
      url: this.inboxEmailsUrl,
      data: mail
    });
    return this._extractResult(res);
  }

  async getEmails() {
    const res = await this.axios({
      method: 'get',
      url: this.inboxEmailsUrl
    });

    return this._extractResult(res);
  }

  async getEmailCount() {
    const res = await this.axios({
      method: 'get',
      url: this.inboxEmailCountUrl
    });
    return this._extractResult(res);
  }

  async waitForEmailCount(
    count,
    interval = 2000,
    timeout = 30000,
    initialDelay = 500
  ) {
    await sleep(initialDelay);
    let time = Date.now();
    const endTime = time + timeout;
    while (time < endTime) {
      const res = await this.getEmailCount();
      if (res >= count) {
        return res;
      }
      await sleep(interval);
      time += interval;
    }
    throw new Error('Time out');
  }

  async getLastEmail() {
    const res = await this.axios({
      method: 'get',
      url: this.inboxLastEmailUrl
    });
    return this._extractResult(res);
  }

  async clear() {
    const res = await this.axios({
      method: 'delete',
      url: this.inboxUrl
    });
    return this._extractResult(res);
  }

  async getGroupEmails() {
    if (!this.group) {
      throw new Error('This inbox is not attached to any group');
    }
    const res = await this.axios({
      method: 'get',
      url: this.groupEmailsUrl
    });
    return this._extractResult(res);
  }

  async getLastGroupEmail() {
    if (!this.group) {
      throw new Error('This inbox is not attached to any group');
    }
    const res = await this.axios({
      method: 'get',
      url: this.groupLastEmailUrl
    });
    return this._extractResult(res);
  }

  async clearGroup() {
    if (!this.group) {
      throw new Error('This inbox is not attached to any group');
    }
    const res = await this.axios({
      method: 'delete',
      url: this.groupUrl
    });
    return this._extractResult(res);
  }

  async getEmail(id) {
    const res = await this.axios({
      method: 'get',
      url: `${this.emailsUrl}/${id}`
    });
    return this._extractResult(res);
  }

  async deleteEmail(id) {
    const res = await this.axios({
      method: 'delete',
      url: `${this.emailsUrl}/${id}`
    });
    return this._extractResult(res);
  }


  static generateGroup(group = void(0)) {
    if (group === void(0)) {
      return 'g' + crypto.randomBytes(12).toString('hex');
    }
    return group;
  }

  static generateLocalName() {
    return 'l' + crypto.randomBytes(12).toString('hex');
  }

  _extractResult(res) {
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `ERROR: Status code - ${res.status}, message -'${res.statusText}'`
      );
    }
    if (!res.data.success) {
      throw new Error(
        `ERROR: Success status - false, message -'${res.data.error.message}'`
      );
    }
    return res.data.result;
  }
};
