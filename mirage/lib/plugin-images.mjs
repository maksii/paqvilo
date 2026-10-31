/** Native image Attributes omit null/unset columns while retaining falsy data.
 * Identity is carried separately by the SDK Entity encoder. Callers detach the
 * returned values before exposing the image to a handler. The row version is
 * not an image attribute (native pre/post images never carry versionnumber). */
export function imageAttributes(row, columns = []) {
  const selected = columns.length ? new Set(columns) : null;
  return Object.fromEntries(
    Object.entries(row ?? {}).filter(
      ([name, value]) => value != null && name !== 'versionnumber' && (!selected || selected.has(name)),
    ),
  );
}

// The AsynchronousStepPrimaryName image's attributes: the primary name, then the key (native imageAliasOrder, crud).
export const primaryNameAttributes = (row, nameColumn, idColumn) =>
  imageAttributes(
    Object.fromEntries(
      [nameColumn, idColumn].filter((name) => Object.hasOwn(row ?? {}, name)).map((name) => [name, row[name]]),
    ),
  );

// The platform's own entries of the IPluginExecutionContext4 image collections (native parity corpus).
export const PRIMARY_NAME_IMAGE = 'AsynchronousStepPrimaryName',
  BUSINESS_ENTITY_IMAGE = 'PreBusinessEntity';
// Messages whose queued asynchronous steps add the row's primary-name image (native corpus crud, bulk, ownerAndState,
// sdkMessages, reads, mergeAccount), and the ones that read it from the row before the operation (Delete, DeleteMultiple, Assign).
const PRIMARY_NAME_MESSAGES = new Set([
  'create',
  'update',
  'delete',
  'createmultiple',
  'updatemultiple',
  'deletemultiple',
  'assign',
  'setstate',
  'setstatedynamicentity',
  'grantaccess',
  'modifyaccess',
  'revokeaccess',
  'retrieveprincipalaccess',
  'retrievesharedprincipalsandaccess',
  'retrieve',
  'merge',
]);
export const primaryNameSide = (operation) =>
  PRIMARY_NAME_MESSAGES.has(operation)
    ? ['delete', 'deletemultiple', 'assign'].includes(operation)
      ? 'pre'
      : 'post'
    : null;

/** The IPluginExecutionContext4 image set of one stage as the step at `upTo` sees it. Native fills the stage's
 * collections in execution order: every step that ran or was queued (an asynchronous PostOperation step at its rank
 * slot) adds its registered images, a later image with the same alias replacing the value in place (native crud: the
 * first PostOperation step sees the images of an asynchronous step queued before it, not of the steps after it).
 * `steps` are the stage's registrations in execution order ({ images, asynchronous }), `seed` the entries the stage
 * starts with. The primary-name image is added after the first queued asynchronous step's own images, or, for
 * pre-image messages, first when any asynchronous step is queued (native crud Delete: [primary name, pre]).
 * Answers { pre, post }: alias -> registered image, or { platform } for the platform's entries. */
export function stageImageSet({ stage, steps, upTo = steps.length - 1, seed = {}, primaryName = null }) {
  const pre = { ...seed },
    post = {};
  if (primaryName === 'pre' && steps.some((step) => step.asynchronous))
    pre[PRIMARY_NAME_IMAGE] = { platform: PRIMARY_NAME_IMAGE };
  for (const step of steps.slice(0, upTo + 1)) {
    for (const image of step.images ?? []) {
      const alias = image.alias || image.name;
      if ([0, 2].includes(image.type)) pre[alias] = image;
      if (stage === 40 && [1, 2].includes(image.type)) post[alias] = image;
    }
    if (step.asynchronous && primaryName === 'post') post[PRIMARY_NAME_IMAGE] ??= { platform: PRIMARY_NAME_IMAGE };
  }
  return { pre, post };
}
