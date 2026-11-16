// The settings contracts of the provider modules, without their runtimes: importing this file registers every contract
// setting parser (config-keys.mjs) from modules that only validate. The config-load path of a command (lense/config.mjs)
// imports it, so reading a catalogue loads no connector, storage, messaging, canvas or Dataverse runtime.
// provider-modules.mjs imports it too and adds the pack exports, which the runtimes own.
//
// Registration happens here, not in the *-settings.mjs modules: they import nothing from config-keys.mjs, so one of them
// reached from inside config-keys.mjs's own import graph cannot run a registration before that module has initialised.
import { registerSettingParser } from './config-keys.mjs';
import { canvasSettings } from './canvas-settings.mjs';
import { codeAppSettings } from './code-app-settings.mjs';
import { connectionsSettingParser } from './connection-settings.mjs';
import { localServicesSettingParser } from './local-service-settings.mjs';
import { messagingSettings } from './messaging-settings.mjs';
import { outboxSettings } from './outbox-settings.mjs';
import { secretsSettingParser } from './secret-settings.mjs';
import { storageSettingParser } from './storage-settings.mjs';

/** Every contract setting key and the parser its owning module registers; a provider module registers the same function. */
const SETTING_CONTRACTS = Object.freeze({
  canvas: canvasSettings,
  codeApps: codeAppSettings,
  connections: connectionsSettingParser,
  localServices: localServicesSettingParser,
  'providers.messaging': messagingSettings,
  'providers.outbox': outboxSettings,
  'providers.storage': storageSettingParser,
  secrets: secretsSettingParser,
});

for (const [key, parse] of Object.entries(SETTING_CONTRACTS)) registerSettingParser(key, parse);
