import MxVerifier from './MxVerifier';
import {createError} from './error';
import {getDkim, dnsResolve, allPromises} from './util';
import spfCheck from 'spf-check';

export default class DomainNameVerifier {
  constructor(configDir, options = {}) {
    const self = this;
    self._configDir = configDir;
    self._environments = options.environments || {};
    self._dnsTimeout = options.dnsTimeout || 5000;
    self._mxVerifiers = {};
    Object.keys(self._environments).map(function(environment) {
      self._mxVerifiers[environment] = new MxVerifier(
        self._environments[environment].mailServers || []
      );
    });
  }

  async verifyAnyMx(environment, domain) {
    const verifier = this._mxVerifiers[environment];
    let records = null;
    try {
      records = await dnsResolve(domain, 'MX', this._dnsTimeout);
    } catch (err) {
      return {
        errors: [createError('DnsGettingMxRecordsFailed', domain)]
      };
    }
    return {
      result: verifier.verifyAnyMx(records),
      errors: []
    };
  }

  async fastVerify(environment, domain) {
    const spfResult = await this._verifySpf(environment, domain);
    const dkimResult = await this._verifyDkim(environment, domain);
    const mxResult = await this._verifyMx(environment, domain, true);
    return (
      mxResult &&
      dkimResult.errors.length === 0 &&
      spfResult.errors.length === 0
    );
  }

  async verify(environment, domain) {
    const [spfResult, dkimResult, mxResult] = await Promise.all([
      this._verifySpf(environment, domain),
      this._verifyDkim(environment, domain),
      this._verifyMx(environment, domain, false)
    ]);
    const result = {
      success: !(
        mxResult.errors.length > 0 ||
        spfResult.errors.length > 0 ||
        dkimResult.errors.length > 0
      ),
      spf: spfResult,
      dkim: dkimResult,
      mx: mxResult
    };
    return result;
  }

  async _verifyDkim(environment, domain) {
    let dkim = null;
    try {
      dkim = await getDkim(
        this._configDir,
        domain,
        this._environments[environment]
      );
    } catch (err) {
      return {
        errors: [createError('DkimGettingValueFailed', domain)],
        steps: [{
          step: 'DkimAskSupport',
          message: 'Ask support for help'
        }]
      };
    }

    let dkimTxtRecords = null;
    const value = dkim.value.trim();
    try {
      dkimTxtRecords = await dnsResolve(
        dkim.domain,
        'TXT',
        this._dnsTimeout
      );
    } catch (err) {
      return {
        errors: [createError('DkimDnsResolveError', dkim.domain, err.message)],
        steps: [{
          step: 'DkimSetKey',
          message: `Set the TXT value for ${dkim.domain} to '${value}'`
        }]
      };
    }
    if (dkimTxtRecords.length > 1) {
      return {
        errors: [createError('DkimMultipleRecords', dkim.domain)],
        steps: [{
          step: 'DkimSetOne',
          message: `Set one TXT record to '${value}' and remove ` +
          `all other TXT records for the ${dkim.domain}`
        }]
      };
    }
    const dkimTxtRecordValue = dkimTxtRecords[0].join('');
    if (dkimTxtRecordValue !== value) {
      return {
        errors: [createError('DkimKeyMismatch', dkim.domain, dkim.id)],
        steps: [{
          step: 'DkimSetKey',
          message: `Set the TXT value for ${dkim.domain} to '${value}'`
        }]
      };
    }
    return {
      errors: [],
      steps: []
    };
  }

  async _getAllMailServersIps(mailServers) {
    const errors = [];
    const ips = [];
    const steps = [];
    const promises = allPromises(mailServers.map(
      x => dnsResolve(x, 'A', this._dnsTimeout)
    ));

    const results = await Promise.all(promises);

    let index = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        ips.push(
          ...result.value.map(x => ({ip: x, server: mailServers[index]}))
        );
      } else {
        errors.push(createError(
          'DnsGettingARecordsFailed',
          mailServers[index]
        ));
      }
      ++index;
    }

    if (errors.length > 0) {
      steps.push({
        step: 'MxAskSupport',
        message: 'Ask support for help'
      });
    }
    return {
      errors,
      steps,
      ips
    };
  }

  async _createSetSpfStep(mailServers, domain) {
    let failed = false;
    const spfPrefix = 'v=spf1 ';
    const spfInclude = `include:${mailServers[0]}`;
    let dnsRecords = [];
    try {
      dnsRecords = await dnsResolve(domain, 'TXT', this._dnsTimeout);
    } catch (err) {
      failed = true;
    }
    let spfRecord = null;
    if (!failed) {
      for (const record of dnsRecords) {
        const txtRecord = record.join('').trim();
        if (txtRecord.startsWith(spfPrefix)) {
          spfRecord = txtRecord;
          break;
        }
      }
    }

    if (failed || !spfRecord) {
      const dnsNewValue = `v=spf1 ${spfInclude} ~all`;
      return {
        step: 'SpfSetDnsRecord',
        message: `Set a DNS TXT record for the ${domain} domain to include ` +
          `${mailServers[0]}. An example for a valid SPF value would be ` +
          `'${dnsNewValue}'.`
      };
    }
    const spfRemaining = spfRecord.substring(spfPrefix.length);
    const suggestedValue = `${spfPrefix}${spfInclude} ${spfRemaining}`;
    return {
      step: 'SpfChangeDnsRecord',
      message: `Change the DNS TXT record for the ${domain} domain to ` +
        `inclute ${mailServers[0]}. Current SPF value: '${spfRecord}'. ` +
        `Suggested SPF value: '${suggestedValue}'`
    };
  }

  async _verifySpf(environment, domain) {
    const {mailServers} = this._environments[environment];
    const ipResults = await this._getAllMailServersIps(mailServers);
    if (ipResults.errors.length > 0) {
      return {
        errors: ipResults.errors,
        steps: ipResults.steps
      };
    }
    const errors = [];
    const steps = [];
    const validator = new spfCheck.SPF(domain);
    for (const ipResult of ipResults.ips) {
      //do not need try/catch here. The library handles everything for us.
      const spf = await validator.check(ipResult.ip);
      if (spf.result !== 'Pass') {
        errors.push(createError(
          'SpfFailed',
          domain,
          ipResult.server,
          ipResult.ip,
          spf.result,
          spf.message
        ));
      }
    }

    if (errors.length > 0) {
      const spfStep = await this._createSetSpfStep(mailServers, domain);
      steps.push(spfStep);
    }

    return {
      errors,
      steps
    };
  }


  async _verifyMx(environment, domain, fast = false) {
    const verifier = this._mxVerifiers[environment];
    let records = null;
    try {
      records = await dnsResolve(domain, 'MX', this._dnsTimeout);
    } catch (err) {
      if (fast) {
        return false;
      }
      const verification = verifier.verify([]);
      return {
        ...verification,
        errors: [createError('DnsGettingMxRecordsFailed', domain)]
      };
    }
    return fast ?
      verifier.fastVerify(records) : verifier.verify(records);
  }
}
