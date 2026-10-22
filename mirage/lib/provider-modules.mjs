// Side-effect imports: each provider and contract module registers its setting parser (config-keys.mjs) and pack
// exports (pack-exports.mjs) when it loads. project-config.mjs imports this file so every parser is present on the
// config-load path. None of these modules may import project-config.mjs.
import { registerSettingParser } from './config-keys.mjs';
import { canvasSettings } from './canvas-source.mjs';
import './connector-runtime.mjs';
import './code-apps-config.mjs';
import './storage-provider.mjs';
import './message-bus.mjs';
import './outbox.mjs';
import './canvas-power-fx.mjs';
import './service-fixtures.mjs';
import './secret-resolver.mjs';
import './local-services.mjs';
import './dataverse-calculated.mjs';
import './dataverse-business-rules.mjs';
import './dataverse-rollup.mjs';
import './dataverse-formula.mjs';
import './dataverse-virtual-providers.mjs';
import './dataverse-hierarchy.mjs';
import './dataverse-state-transitions.mjs';
import './flow-actions.mjs';
import './flow-triggers.mjs';

// canvas-source.mjs sits inside config-keys.mjs's own import graph (via solution-inventory.mjs), so registering there
// would run before config-keys.mjs has initialised; the canvas parser is registered here instead.
registerSettingParser('canvas', canvasSettings);
