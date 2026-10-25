// The shell opts into this lossless wire representation. Server-side catalogue
// and evidence contracts keep their full canonical source identities.
export function encodeModelDrivenProvenance(value) {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  if (Array.isArray(value.provenanceRefs) && value.provenanceRefs.length) {
    const origins = [],
      positions = new Map();
    result.provenanceFormat = 1;
    result.provenanceRefs = value.provenanceRefs.map((original) => {
      const ref = { ...original };
      const origin = { ref: ref.ref, sourceRevision: ref.sourceRevision, contentRevision: ref.contentRevision };
      const key = JSON.stringify(origin);
      let originIndex = positions.get(key);
      if (originIndex === undefined) {
        originIndex = origins.length;
        positions.set(key, originIndex);
        origins.push(origin);
      }
      delete ref.ref;
      delete ref.sourceRevision;
      delete ref.contentRevision;
      let aliasMask = 0;
      if (typeof ref.id === 'string' && ref.key === ref.id) {
        delete ref.key;
        aliasMask |= 1;
      }
      if (typeof ref.id === 'string' && ref.sourceKey === ref.id) {
        delete ref.sourceKey;
        aliasMask |= 2;
      }
      if (typeof ref.componentKey === 'string' && ref.placementKey === ref.componentKey) {
        delete ref.placementKey;
        aliasMask |= 4;
      }
      return { ...ref, originIndex, aliasMask };
    });
    result.provenanceOrigins = origins;
  }
  if (value.tables)
    result.tables = Object.fromEntries(
      Object.entries(value.tables).map(([key, table]) => [key, encodeModelDrivenProvenance(table)]),
    );
  return result;
}

export function decodeModelDrivenProvenance(value) {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  if (value.provenanceFormat !== undefined) {
    try {
      if (
        value.provenanceFormat !== 1 ||
        !Array.isArray(value.provenanceOrigins) ||
        !Array.isArray(value.provenanceRefs)
      )
        throw new Error('Unsupported model source transport.');
      result.provenanceRefs = value.provenanceRefs.map(({ originIndex, aliasMask, ...ref }) => {
        if (
          !Number.isSafeInteger(originIndex) ||
          originIndex < 0 ||
          originIndex >= value.provenanceOrigins.length ||
          !Number.isSafeInteger(aliasMask) ||
          aliasMask < 0 ||
          aliasMask > 7
        )
          throw new Error('Invalid model source transport.');
        const origin = value.provenanceOrigins[originIndex];
        if (
          !origin ||
          typeof origin !== 'object' ||
          typeof origin.ref !== 'string' ||
          typeof origin.sourceRevision !== 'string' ||
          typeof origin.contentRevision !== 'string' ||
          !origin.ref ||
          origin.ref.length > 16384 ||
          !origin.sourceRevision ||
          origin.sourceRevision.length > 256 ||
          !origin.contentRevision ||
          origin.contentRevision.length > 256 ||
          (aliasMask & 3 && typeof ref.id !== 'string') ||
          (aliasMask & 4 && typeof ref.componentKey !== 'string')
        )
          throw new Error('Invalid model source origin.');
        return {
          ...ref,
          ref: origin.ref,
          sourceRevision: origin.sourceRevision,
          contentRevision: origin.contentRevision,
          ...(aliasMask & 1 ? { key: ref.id } : {}),
          ...(aliasMask & 2 ? { sourceKey: ref.id } : {}),
          ...(aliasMask & 4 ? { placementKey: ref.componentKey } : {}),
        };
      });
    } catch {
      result.provenanceRefs = [];
      result.provenanceAvailability = [{ capability: 'editable-source', reason: 'invalid-provenance-transport' }];
    }
    delete result.provenanceFormat;
    delete result.provenanceOrigins;
  }
  if (value.tables)
    result.tables = Object.fromEntries(
      Object.entries(value.tables).map(([key, table]) => [key, decodeModelDrivenProvenance(table)]),
    );
  return result;
}
