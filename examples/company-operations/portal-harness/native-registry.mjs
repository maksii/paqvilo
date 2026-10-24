/** Freeze actual source SDK registrations, including disabled steps and every
 * image attached to the explicitly registered step domain. Secure values are
 * never requested; only secure configuration identity/presence is retained. */
export async function captureNativeRegistry(client, source) {
  const stepFields =
    'sdkmessageprocessingstepid,name,_eventhandler_value,_sdkmessageid_value,_sdkmessagefilterid_value,_impersonatinguserid_value,_sdkmessageprocessingstepsecureconfigid_value,stage,rank,mode,configuration,statecode,statuscode';
  const allSteps = await client.list(`sdkmessageprocessingsteps?$select=${stepFields}`),
    steps = allSteps.filter((step) =>
      source.steps.some((original) => original.sdkmessageprocessingstepid === step.sdkmessageprocessingstepid),
    );
  if (steps.length !== source.steps.length) throw new Error('Registered native plugin step domain is incomplete.');
  const readIds = async (entity, ids, primary, fields) => {
    const records = [];
    for (let offset = 0; offset < ids.length; offset += 30)
      records.push(
        ...(await client.list(
          `${entity}?$select=${fields}&$filter=${ids
            .slice(offset, offset + 30)
            .map((id) => `${primary} eq ${id}`)
            .join(' or ')}`,
        )),
      );
    if (records.length !== new Set(ids).size)
      throw new Error('Native SDK registration identity is missing or duplicated.');
    return records;
  };
  const filters = await readIds(
    'sdkmessagefilters',
    [...new Set(steps.map((step) => step._sdkmessagefilterid_value).filter(Boolean))],
    'sdkmessagefilterid',
    'sdkmessagefilterid,primaryobjecttypecode,secondaryobjecttypecode,_organizationid_value',
  );
  const messages = await readIds(
    'sdkmessages',
    [...new Set(steps.map((step) => step._sdkmessageid_value).filter(Boolean))],
    'sdkmessageid',
    'sdkmessageid,name,_organizationid_value',
  );
  const images = [];
  for (let offset = 0; offset < steps.length; offset += 30)
    images.push(
      ...(await client.list(
        `sdkmessageprocessingstepimages?$select=sdkmessageprocessingstepimageid,name,entityalias,attributes,messagepropertyname,imagetype,_sdkmessageprocessingstepid_value&$filter=${steps
          .slice(offset, offset + 30)
          .map((step) => `_sdkmessageprocessingstepid_value eq ${step.sdkmessageprocessingstepid}`)
          .join(' or ')}`,
      )),
    );
  const who = await client.get('WhoAmI');
  return {
    ...source,
    capturedAt: new Date().toISOString(),
    applicationUserId: who.UserId,
    steps,
    filters,
    messages,
    images,
  };
}
