const format = require('string-template');
const {createError} = require('./error');


module.exports = class MxVerifier {
  constructor(mailServers) {
    this._mailServers = [];
    this._mailServerSet = new Set();
    for (const mailServer of mailServers) {
      const normalizedMailServer = mailServer.toLowerCase();
      if (!this._mailServerSet.has(normalizedMailServer)) {
        this._mailServers.push(normalizedMailServer);
        this._mailServerSet.add(normalizedMailServer);
      }
    }
  }

  verifyAnyMx(mxRecords) {
    const records = MxVerifier._normalizeMxRecords(mxRecords);
    for (const record of records) {
      if (this._mailServerSet.has(record.exchange)) {
        return true;
      }
    }
    return false;
  }

  fastVerify(mxRecords) {
    const records = MxVerifier._normalizeMxRecords(mxRecords);
    if (records.length <= this._mailServers.length) {
      return false;
    }
    let index = 0;
    for (const exchange of this._mailServers) {
      if (exchange !== records[index].exchange ||
       (index > 0 && records[index - 1].priority >= records[index].priority)
      ) {
        return false;
      }
      ++index;
    }
    if (this._mailServerSet.has(records[index].exchange) ||
      (index > 0 && records[index - 1].priority >= records[index].priority)
    ) {
      return false;
    }
    return true;
  }

  verify(mxRecords) {
    const records = MxVerifier._normalizeMxRecords(mxRecords);
    const {inRecords, outRecords} = this._classifyRecords(records);

    const {
      upperPriority,
      upperPriorityDelta
    } = MxVerifier._getUpperPriorityProps(outRecords, inRecords.length);

    MxVerifier._setInPriorities(inRecords, upperPriority);
    MxVerifier._setOutPriorities(
      outRecords,
      upperPriority,
      upperPriorityDelta
    );

    return MxVerifier._createReport(records, inRecords, outRecords);
  }

  static _mxExchangeCompare(r1, r2) {
    return (r1.exchange > r2.exchange) - (r1.exchange < r2.exchange);
  }

  static _mxPriorityCompare(r1, r2) {
    return r1.priority - r2.priority;
  }

  static _mxFullCompare(r1, r2) {
    return MxVerifier._mxPriorityCompare(r1, r2) ||
      MxVerifier._mxExchangeCompare(r1, r2);
  }


  static _normalizeMxRecords(mxRecords) {
    const records = mxRecords.map(
      x => { return {...x, exchange: x.exchange.toLowerCase()}; }
    );
    records.sort(MxVerifier._mxFullCompare);
    return records;
  }

  _classifyRecords(mxRecords) {
    const records = mxRecords.map(
      x => { return {exchange: x.exchange, priority: x.priority}; }
    );
    const inRecords = records.filter(
      x => this._mailServerSet.has(x.exchange)
    );
    const inRecordsMap = new Map(inRecords.map(x => [x.exchange, x]));
    const targetInRecords = this._mailServers.map(
      x => inRecordsMap.has(x) ?
        inRecordsMap.get(x) : {priority: -1, exchange: x}
    );

    const targetOutRecords = records.filter(
      x => !this._mailServerSet.has(x.exchange)
    );

    return {
      inRecords: targetInRecords,
      outRecords: targetOutRecords
    };
  }

  static _setInPriorities(records, upperPriority) {
    let priority = 0;
    for (let i = 0; i < records.length; ++i) {
      const r = records[i];
      if (r.priority < 0) {
        r.newPriority = priority++;
      } else if (r.priority < upperPriority - i) {
        priority = r.priority + 1;
      } else {
        r.newPriority = priority++;
      }
    }
  }

  static _setOutPriorities(records, upperPriority, upperPriorityDelta) {
    if (upperPriorityDelta > 0) {
      let prevPriority = -1;
      for (let i = 0; i < records.length; ++i) {
        const r = records[i];
        if (r.priority < upperPriority || r.priority <= prevPriority) {
          r.newPriority = r.priority + upperPriorityDelta;
          prevPriority = r.newPriority;
        } else {
          break;
        }
      }
    }
  }

  static _getUpperPriorityProps(outRecords, minPriority) {
    let upperPriority = outRecords.length > 0 ?
      outRecords[0].priority : 10 * minPriority;
    const upperPriorityDelta = upperPriority < minPriority ?
      minPriority - upperPriority : 0;
    upperPriority += upperPriorityDelta;
    return {
      upperPriority,
      upperPriorityDelta
    };
  }

  static _createReport(records, inRecords, outRecords) {
    const errors = [];
    const steps = [];
    const targetRecords = inRecords.concat(outRecords);
    for (const record of targetRecords) {
      if (record.priority < 0) {
        errors.push(createError('MxMissingInExchange', record.exchange));
        steps.push({
          step: 'MxAddInRecord',
          record,
          message: format(
            'Add new MX record \'{newPriority} {exchange}\' ' +
              '(priority={newPriority}, exchange={exchange})',
            record
          )
        });
      } else if (Object.prototype.hasOwnProperty.call(record, 'newPriority')) {
        const error = record.priority < record.newPriority ?
          'MxPriorityTooLow' : 'MxPriorityTooHigh';
        errors.push(createError(error, record.exchange, record.priority));
        steps.push({
          step: 'MxChangePriority',
          record,
          message: format(
            'In the MX record \'{priority} {exchange}\' change the priority ' +
              'from {priority} to {newPriority}',
            record
          )
        });
      }
    }
    if (outRecords.length === 0) {
      errors.push(createError('MxMissingOutExchange'));
      steps.push({
        step: 'MxAddOutRecord',
        record: {},
        message: 'Add at least one MX record for a target server.'
      });
    }
    return {
      records,
      targetRecords,
      errors,
      steps
    };
  }
};
