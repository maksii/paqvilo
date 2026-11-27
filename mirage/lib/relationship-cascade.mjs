// Solution imports use camel-case keys and the metadata Web API stores its PascalCase keys.
export function cascadeAction(configuration, action) {
  return configuration?.[action] ?? configuration?.[action[0].toUpperCase() + action.slice(1)];
}
