import { randomBytes, randomUUID } from 'node:crypto';
import { ownerColumns } from './dataverse-security.mjs';

/**
 * The Power Pages invitation processes every site's environment carries (the Power Pages solution's classic workflows,
 * hosted session F4 AUTH-05d and its workflow survey): UpdateInvitationCode, real-time on create of an adx_invitation,
 * and Send Invitation, the on-demand background process the invitation form's "Send Invitation" runs through
 * ExecuteWorkflow. Their ids are the solution's, as the survey read them. Mirage seeds the two definitions when the site
 * has the adx_invitation table and the Solution does not export them, and runs them as built-in handlers.
 */
const INVITATION_PROCESSES = Object.freeze({
  updateInvitationCode: '6cf2fe48-d865-4ced-8546-0a78600efefc',
  sendInvitation: '15c03c8d-754f-4386-a62c-cf7e91337ebd',
});
const INVITATION_TABLE = 'adx_invitation';
const INVITATION_SENT = 756150000;
const EMAIL_PENDING_SEND = 6;
// The hosted email links to this address whatever the site's domain (hosted session F4); Mirage links to its own origin
// and uses this one only when it has none.
const HOSTED_LINK_ORIGIN = 'http://localhost:7500';

const bare = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const fact = (id, overrides) => ({
  id,
  uniquename: null,
  category: 0,
  type: 1,
  scope: 4,
  subprocess: false,
  triggerondelete: false,
  triggeronupdateattributelist: null,
  primaryentity: INVITATION_TABLE,
  state: 1,
  runas: 1,
  istransacted: true,
  asyncautodelete: false,
  syncworkflowlogonfailure: false,
  processtriggerscope: null,
  processtriggerformid: null,
  xaml: null,
  clientdata: null,
  ...overrides,
});

const hasInvitationTable = (store) => {
  try {
    return store.resolveMapping(INVITATION_TABLE).logicalName === INVITATION_TABLE;
  } catch {
    return false;
  }
};

/** The Solution workflow facts with the invitation processes the site's sources do not export. */
export function withInvitationProcesses(store, facts = []) {
  if (!hasInvitationTable(store)) return facts;
  const present = new Set(facts.map((item) => bare(item.id)));
  const builtIn = [
    fact(INVITATION_PROCESSES.updateInvitationCode, {
      name: 'UpdateInvitationCode',
      mode: 1,
      ondemand: false,
      triggeroncreate: true,
    }),
    fact(INVITATION_PROCESSES.sendInvitation, {
      name: 'Send Invitation',
      mode: 0,
      ondemand: true,
      triggeroncreate: false,
    }),
  ].filter((item) => !present.has(item.id));
  return builtIn.length ? [...facts, ...builtIn] : facts;
}

// The email's tracking token, appended to its subject as the hosted email shows it (" CRM:0252001"); the numbering of
// the token is local.
function trackingToken(store) {
  const used = store
    .tableRows('email')
    .map((row) => /^CRM:(\d{7})$/.exec(String(row.trackingtoken ?? ''))?.[1])
    .filter(Boolean)
    .map(Number);
  return `CRM:${String((used.length ? Math.max(...used) : 0) + 1).padStart(7, '0')}`;
}

/** The built-in handlers of the invitation processes, by workflow id. origin(): the portal's own origin, or null. */
export function invitationProcessHandlers({ origin = () => null } = {}) {
  return new Map([
    [
      INVITATION_PROCESSES.updateInvitationCode,
      // A 172-character code (128 random bytes in base64) when the new invitation has none (hosted session F4).
      async ({ api, target }) => {
        if (String(target.row?.adx_invitationcode ?? '').trim()) return { message: null };
        await api.store.updateRecordAsync(
          INVITATION_TABLE,
          target.id,
          { adx_invitationcode: randomBytes(128).toString('base64') },
          { admin: true },
        );
        return { message: null };
      },
    ],
    [
      INVITATION_PROCESSES.sendInvitation,
      // One email activity regarding the invitation, from the calling user to the invited contact, with the redemption
      // link; the invitation becomes Sent (hosted session F4, invitation-send-{a,b}-single).
      async ({ api, target, caller }) => {
        const { store } = api;
        const invitation = target.row;
        const contactMapping = store.resolveMapping('contact');
        const contactId = bare(invitation.adx_invitecontact ?? invitation._adx_invitecontact_value);
        const contact = store.tableRows('contact').find((row) => bare(row[contactMapping.idColumn]) === contactId);
        if (!contact) throw new Error('The invitation has no invited contact to send it to.');
        const code = String(invitation.adx_invitationcode ?? '');
        const link = `${origin() ?? HOSTED_LINK_ORIGIN}/register/?returnurl=/&invitation=${encodeURIComponent(code)}`;
        const token = trackingToken(store);
        const callerId = bare(caller?.systemuserid);
        const sender = store.tableRows('systemuser').find((row) => bare(row.systemuserid) === callerId);
        const emailId = randomUUID();
        await store.createRecordAsync(
          'email',
          {
            activityid: emailId,
            subject: ` ${token}`,
            trackingtoken: token,
            description: `<p>You have been invited to our portal. To redeem your invitation, please click the link below.</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>Regards,</p><p>Portal Team</p>`,
            regardingobjectid: { id: target.id, logical_name: INVITATION_TABLE },
            directioncode: true,
            statecode: 1,
            statuscode: EMAIL_PENDING_SEND,
            ...(sender ? ownerColumns(store, { id: sender.systemuserid, logical_name: 'systemuser' }) : {}),
          },
          { admin: true },
        );
        const parties = [
          sender && [1, { id: sender.systemuserid, logical_name: 'systemuser' }, sender.internalemailaddress],
          [
            2,
            { id: contact[contactMapping.idColumn], logical_name: contactMapping.logicalName },
            contact.emailaddress1,
          ],
        ].filter(Boolean);
        for (const [mask, party, address] of parties)
          await store.createRecordAsync(
            'activityparty',
            {
              activitypartyid: randomUUID(),
              activityid: { id: emailId, logical_name: 'email' },
              participationtypemask: mask,
              partyid: party,
              addressused: address ?? null,
            },
            { admin: true },
          );
        await store.updateRecordAsync(INVITATION_TABLE, target.id, { statuscode: INVITATION_SENT }, { admin: true });
        return { message: null };
      },
    ],
  ]);
}
