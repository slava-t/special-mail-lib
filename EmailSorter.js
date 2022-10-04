export default class EmailSorter {
  constructor(item, mail) {
    this._item = item;
    this._mail = mail;
    this._transport = item.transport;
  }

  getSortedOutEmails() {
    const mail = this._getJsonSafeEmail();
    let emails = [];
    for (const address of this._transport.rcpt_to) {
      emails.push(this._createEmailData(address, mail));
    }
    return emails;
  }

  _extractAttachments() {
    const attachments = [];
    for (const attachment of (this._mail.attachments || [])) {
      const content = attachment.content ?
        attachment.content.toString('base64') : '';
      attachments.push({
        filename: attachment.filename,
        contentType: attachment.contentType,
        contentDisposition: attachment.contentDisposition,
        checksum: attachment.checksum,
        content,
        size: attachment.size,
        headers: [...attachment.headers],
        contentId: attachment.contentId,
        cid: attachment.cid,
        related: attachment.related
      });
    }
    return attachments;
  }

  _getJsonSafeHeaders() {
    return [...this._mail.headers];
  }

  _getJsonSafeEmail() {
    const attachments = this._extractAttachments();
    const headers = this._getJsonSafeHeaders();
    return {
      ...this._mail,
      headers,
      attachments
    };
  }

  _getTransportInfo(address) {
    return {
      ...this._transport,
      target: address
    };
  }


  _createEmailData(address, mail) {
    return {
      ...this._item,
      mail,
      transport: this._getTransportInfo(address)
    };
  }
}
