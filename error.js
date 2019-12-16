const format = require('string-template');

const errors = {
  MxPriorityTooLow: {
    message: 'The priority for MX record \'{1} {0}\' is too high' +
      '(the value {1} is too low)'
  },
  MxPriorityTooHigh: {
    message: 'The priority for MX record \'{1} {0}\' is too low' +
      '(the value {1} is too high)'
  },
  MxMissingInExchange: {
    message: 'Missing MX record for {0}'
  },
  MxMissingOutExchange: {
    message: 'No MX records for target servers found.'
  },
  DnsGettingMxRecordsFailed: {
    message: 'Getting MX records for domain {0} failed'
  },
  DnsGettingARecordsFailed: {
    message: 'Getting A records for domain {0} failed'
  },
  SpfFailed: {
    message: 'Spf validation did not pass for the domain {0} for mail ' +
      'server {1} (ip: {2}). Verification code: {3}. Message: \'{4}\'.'
  },
  DkimGettingValueFailed: {
    message: 'Server error. Dkim value could not be read for the domain {0}'
  },
  DkimDnsResolveError: {
    message: 'Could not get the TXT record for {0}. Message: \'{1}\''
  },
  DkimMultipleRecords: {
    message: 'Multiple TXT records found for {0}'
  },
  DkimKeyMismatch: {
    message: 'The DKIM text value does not match with the expected one ' +
      'for the domain {0}(dkimId: {1}'
  },
  UnknownError: {
    message: 'Unknown error'
  }
};

const createError = function(error, ...params) {
  if (!errors.hasOwnProperty(error)) {
    error = 'UnknownError';
  }
  return {
    error,
    params,
    message: format(errors[error].message, params)
  };
};

module.exports = {
  createError
};
