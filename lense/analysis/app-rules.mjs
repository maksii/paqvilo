import { analyzePcf, pcfRules } from './app-pcf.mjs';
import { analyzeCanvas, canvasRules } from './app-canvas.mjs';
import { analyzeCodeApps, codeAppRules } from './app-code.mjs';

export const appRules = [...pcfRules, ...canvasRules, ...codeAppRules];

function inspectDomain(domain, scan, entries, emit, incompleteRules) {
  let complete = true;
  const result = scan(entries, (ruleId, ...args) => {
    if (incompleteRules.includes(ruleId)) complete = false;
    emit(ruleId, ...args);
  });
  return { domain, ...result, complete };
}
/** Read already bounded source entries. Never compile, load project code, or contact an app host. */
export function analyzeApps(entries, emit) {
  return {
    domains: [
      inspectDomain('pcf', analyzePcf, entries, emit, ['APP-PCF-001']),
      inspectDomain('canvas', analyzeCanvas, entries, emit, ['APP-CANVAS-001', 'APP-CANVAS-004', 'APP-CANVAS-008']),
      inspectDomain('code-apps', analyzeCodeApps, entries, emit, ['APP-CODE-001', 'APP-DEPS-003']),
    ],
  };
}
