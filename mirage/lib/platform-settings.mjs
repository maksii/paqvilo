import { organizationRecord } from './organization-context.mjs';
import { DataError } from './data-error.mjs';
import { parseXmlDocument } from './fetchxml-engine.mjs';
import { PLATFORM_SETTINGS, validatePlatformOverrides } from './platform-setting-definitions.mjs';

// The definitions and their validation live in platform-setting-definitions.mjs, which the settings contract loads alone.
export { validatePlatformOverrides };

const organizationSettingsCache = new WeakMap();
export function platformSettingEntries(state) {
  const overrides = validatePlatformOverrides(state.simulator?.platformOverrides);
  const { evidence: configuredEvidence, ...configured } = state.simulator?.platformDefaults ?? {};
  validatePlatformOverrides(configured);
  const org = organizationRecord(state) ?? {};
  let orgDbOrg;
  const orgValue = (d) => {
    if (!d.orgDbOrgSetting || !org.orgdborgsettings) return undefined;
    if (!orgDbOrg) {
      const cached = organizationSettingsCache.get(org);
      orgDbOrg = cached?.xml === org.orgdborgsettings ? cached.document : parseXmlDocument(org.orgdborgsettings);
      organizationSettingsCache.set(org, { xml: org.orgdborgsettings, document: orgDbOrg });
    }
    const matches = [];
    const visit = (node) => {
      if (node.name.split(':').at(-1) === d.key) matches.push(node.text.trim());
      for (const child of node.children ?? []) visit(child);
    };
    visit(orgDbOrg);
    if (!matches.length) return undefined;
    const value = Number(matches[0]);
    if (
      matches.length !== 1 ||
      !/^\d+$/.test(matches[0]) ||
      !Number.isSafeInteger(value) ||
      value < d.min ||
      value > d.max
    )
      throw new DataError('Invalid organization setting ' + d.key, 400, 'InvalidPlatformSetting');
    return value;
  };
  return PLATFORM_SETTINGS.map((d) => {
    const orgDbOrgValue = orgValue(d);
    const local = Object.hasOwn(overrides, d.key),
      catalogued = Object.hasOwn(configured, d.key),
      fromOrganization =
        orgDbOrgValue !== undefined || (d.column && Object.hasOwn(org, d.column) && org[d.column] != null),
      fromSetting = d.stateSetting && state.settings?.[d.stateSetting] != null;
    let source;
    if (catalogued) source = configured[d.key];
    else if (fromOrganization) source = orgDbOrgValue ?? org[d.column];
    else if (fromSetting) source = state.settings[d.stateSetting];
    else source = d.defaultValue;
    const settingOrigin = () => {
      if (local) return 'Instance override';
      if (catalogued) return 'Catalogue';
      if (fromOrganization) return 'Organization row';
      if (fromSetting) return 'Existing simulator setting';
      return 'Default / not configured';
    };
    return {
      ...d,
      sourceValue: source,
      value: local ? overrides[d.key] : source,
      overridden: local,
      origin: settingOrigin(),
      ...(catalogued ? { configuredEvidence, source: 'catalogue' } : {}),
    };
  });
}
export const platformValues = (state) => Object.fromEntries(platformSettingEntries(state).map((d) => [d.key, d.value]));
export function assertAttachmentPolicy(state, entity, row, changes = row) {
  if (
    !['annotation', 'activitymimeattachment'].includes(entity) ||
    !['filename', 'mimetype', 'documentbody', 'body'].some((k) => Object.hasOwn(changes, k))
  )
    return;
  const p = platformValues(state),
    body = row[entity === 'annotation' ? 'documentbody' : 'body'];
  if (body == null && !row.filename) return;
  const list = (value) =>
    String(value ?? '')
      .split(/[;,\s]+/)
      .map((s) => s.toLowerCase().replace(/^\./, ''))
      .filter(Boolean);
  const extension = String(row.filename ?? '')
    .split(/[\\/]/)
    .pop()
    .split('.')
    .slice(1)
    .pop()
    ?.toLowerCase();
  const mime = String(row.mimetype ?? 'application/octet-stream')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (extension && list(p.BlockedAttachments).includes(extension))
    throw new DataError('Attachment extension is blocked by the organization.', 400, 'AttachmentTypeBlocked');
  const allowed = list(p.AllowedMimeTypes);
  if (list(p.BlockedMimeTypes).includes(mime) || (allowed.length && !allowed.includes(mime)))
    throw new DataError('Attachment MIME type is blocked by the organization.', 400, 'AttachmentTypeBlocked');
  if (typeof body === 'string') assertAttachmentSize(state, Buffer.byteLength(body, 'utf8'));
}
// The one attachment size rule for annotation documentbody and activitymimeattachment body, whichever path writes them
// (record writes, block commits, UploadBlock). Learn (attachment-annotation-files#file-size-limits): MaxUploadFileSize
// applies to the file's Base64 encoding, so the unit is the encoded length; the limit honours /_sim overrides.
export function assertAttachmentSize(state, base64Length) {
  if (base64Length > platformValues(state).MaxUploadFileSize)
    throw new DataError('Attachment file size is too big.', 400, 'AttachmentTooLarge', { innerCode: '0x80044a02' });
}
