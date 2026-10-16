// Explicit Dataverse/Windows timezone rules for formatted-value annotations.
// UTC = local + bias; transition clocks use the bias in effect before the change.
// No browser zone or organisation-specific timezone is inferred.
export function compileFormattedTimeZone(profile) {
  if (profile == null) return null;
  const invalid = () => { throw new Error('formattedValueTimeZone requires evidence and 1–512 valid Dataverse timezonerule records'); };
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
      Object.keys(profile).some(key => !['evidence','rules'].includes(key)) ||
      typeof profile.evidence !== 'string' || !profile.evidence.trim() || profile.evidence.length > 2000 ||
      !Array.isArray(profile.rules) || !profile.rules.length || profile.rules.length > 512) invalid();
  const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
  const rules = profile.rules.map(source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) invalid();
    const effective = Date.parse(source.effectivedatetime);
    if (typeof source.effectivedatetime !== 'string' || !Number.isFinite(effective) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/i.test(source.effectivedatetime) || new Date(effective).toISOString().slice(0,19) !== source.effectivedatetime.slice(0,19) ||
        !['bias','standardbias','daylightbias'].every(key => integer(source[key],-1440,1440))) invalid();
    const rule = {effective, standard:-(source.bias + source.standardbias), daylight:-(source.bias + source.daylightbias)};
    for (const prefix of ['standard','daylight']) {
      const point = Object.fromEntries(['year','month','day','dayofweek','hour','minute','second'].map(key => [key, source[prefix + key]]));
      if (!integer(point.month,0,12) || !integer(point.year,0,9999)) invalid();
      if (point.month && (!integer(point.day,1,point.year ? 31 : 5) || !integer(point.dayofweek,0,6) || !integer(point.hour,0,23) || !integer(point.minute,0,59) || !integer(point.second,0,59))) invalid();
      if (point.month && point.year) {
        const date = new Date(0); date.setUTCFullYear(point.year,point.month-1,point.day);
        if (date.getUTCMonth() !== point.month-1 || date.getUTCDate() !== point.day) invalid();
      }
      rule[prefix + 'Point'] = point;
    }
    if (!rule.standardPoint.month !== !rule.daylightPoint.month) invalid();
    if (!!rule.standardPoint.year !== !!rule.daylightPoint.year) invalid();
    return rule;
  }).sort((a,b) => a.effective - b.effective);
  if (rules.some((rule,index) => index && rule.effective === rules[index-1].effective)) invalid();
  const calendar = (year, month, day, hour, minute, second) => {
    const date = new Date(0); date.setUTCFullYear(year,month-1,day); date.setUTCHours(hour,minute,second,0); return date.getTime();
  };
  const transition = (point, year, offset) => {
    year = point.year || year;
    let day = point.day;
    if (!point.year) {
      const first = new Date(calendar(year,point.month,1,0,0,0)).getUTCDay();
      day = 1 + (point.dayofweek - first + 7) % 7 + (point.day - 1) * 7;
      const last = new Date(calendar(year,point.month+1,0,0,0,0)).getUTCDate();
      if (day > last) day -= 7;
    }
    return calendar(year,point.month,day,point.hour,point.minute,point.second) - offset * 60000;
  };
  // Cache transitions per rule/year, bounded by the number of years supported
  // by Dataverse rather than by the number of formatted rows.
  const years = new Map();
  return ms => {
    let index = rules.length - 1;
    while (index > 0 && ms < rules[index].effective) index--;
    const rule = rules[index];
    if (!rule.daylightPoint.month || rule.standard === rule.daylight) return rule.standard;
    const year = new Date(ms + rule.standard * 60000).getUTCFullYear(), key = index + ':' + year;
    let boundaries = years.get(key);
    if (!boundaries) {
      boundaries = [transition(rule.daylightPoint,year,rule.standard),transition(rule.standardPoint,year,rule.daylight)];
      years.set(key,boundaries);
    }
    const [start,end] = boundaries;
    const daylight = start < end || rule.daylightPoint.year ? ms >= start && ms < end : ms >= start || ms < end;
    return daylight ? rule.daylight : rule.standard;
  };
}
