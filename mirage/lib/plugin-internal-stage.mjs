// Platform steps that run between an operation's PreOperation stage and its main operation (native internal stage 25)
// and issue a message of their own: a Create that writes a money value runs the MultiCurrencyPlugin, which issues
// RetrieveExchangeRate (recorded native crud corpus). The issued message's steps see the issuing operation's
// PreOperation context as their ParentContext, reported as that internal stage and owned by the platform step, with the
// whole chain reporting the platform step's executing user (SYSTEM).
import { uuidV5 } from './dataverse-security.mjs';

const sources = new WeakMap();

/** The platform step's OwningExtension reference, named as native contexts name it. */
export const internalStepReference = (owner, message) => ({
  $type: 'EntityReference',
  logicalName: 'sdkmessageprocessingstep',
  id: uuidV5('00000000-0000-0000-0000-000000000000', `sdkmessageprocessingstep:${owner}:${message}`),
  name: owner,
});

/** record: the issued message's pipeline record. source: { entity, operation, target, record, frame, stage, owner } of
 * the issuing operation, read when a CLR step of the issued message builds its full ParentContext (plugin-clr.mjs). */
export const setInternalStageSource = (record, source) => sources.set(record, source);
export const internalStageSource = (record) => sources.get(record);

/** The issuing operation's PreOperation context (typed ExecutionContext), reported as the internal stage, with that
 * level and the issuer's main operation reporting the platform step's executing user (no Entra object id). */
export function internalStageContext(context, stage, userId) {
  const run = (values) =>
    userId
      ? {
          ...values,
          UserId: { $type: 'Guid', value: userId },
          UserAzureActiveDirectoryObjectId: { $type: 'Guid', value: '00000000-0000-0000-0000-000000000000' },
        }
      : values;
  const main = context.values.ParentContext;
  const mainOperation =
    main?.values?.Stage === 30 && main.values.MessageName === context.values.MessageName
      ? { ...main, values: run(main.values) }
      : main;
  return { $type: 'ExecutionContext', values: { ...run(context.values), Stage: stage, ParentContext: mainOperation } };
}
