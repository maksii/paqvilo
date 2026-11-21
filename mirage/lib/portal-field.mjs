/** A portal record's value under its adx_ or mspp_ column name, else its bare name, else the fallback. A module of its
 * own: the model-driven metadata compiler thread reads portal records without loading the importer and its YAML parser. */
export const portalField = (record, name, fallback = null) =>
  record[`adx_${name}`] ?? record[`mspp_${name}`] ?? record[name] ?? fallback;
