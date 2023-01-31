const EmailParsingJob = require('./EmailParsingJob.js');
const RoutingJob = require('./RoutingJob.js');
const PostingJob = require('./PostingJob.js');
const ForwardingJob = require('./ForwardingJob.js');
const CallbackJob = require('./CallbackJob.js');
const jobTypes = require('./job-types.js');

module.exports = {
  [jobTypes.PARSE]: {JobClass: EmailParsingJob},
  [jobTypes.ROUTE]: {JobClass: RoutingJob},
  [jobTypes.POST]: {JobClass: PostingJob},
  [jobTypes.FORWARD]: {JobClass: ForwardingJob},
  [jobTypes.CALLBACK]: {JobClass: CallbackJob}
};
