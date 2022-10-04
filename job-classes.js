import EmailParsingJob from './EmailParsingJob.js';
import RoutingJob from './RoutingJob.js';
import PostingJob from './PostingJob.js';
import ForwardingJob from './ForwardingJob.js';
import jobTypes from './job-types.js';

export default {
  [jobTypes.PARSE]: {JobClass: EmailParsingJob},
  [jobTypes.ROUTE]: {JobClass: RoutingJob},
  [jobTypes.POST]: {JobClass: PostingJob},
  [jobTypes.FORWARD]: {JobClass: ForwardingJob}
};
