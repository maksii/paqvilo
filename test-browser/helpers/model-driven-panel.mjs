import { xrayUi } from '../../lense/xray-ui.mjs';
import { panelUi } from '../../lense/panel-ui.mjs';
import { modelDrivenPanelData } from '../../lense/model-driven-panel.mjs';
import { modelDrivenInspectorUi } from '../../lense/model-driven-inspector-ui.mjs';

export async function installModelPanel(page, state) {
  await page.evaluate(panelUi, modelDrivenPanelData(state, { cfg: {}, ui: { open: true } }));
  await page.evaluate(xrayUi, modelDrivenPanelData(state, { cfg: {} }));
  await page.evaluate(modelDrivenInspectorUi, state);
}
