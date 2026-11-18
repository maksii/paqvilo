# Lint model-driven JavaScript web resources

Microsoft's [Power Apps checker ESLint plugin](https://www.npmjs.com/package/@microsoft/eslint-plugin-power-apps)
statically checks model-driven app JavaScript: form libraries and command handlers. It does not check Power Pages
JavaScript, Canvas apps, inline HTML scripts or PCF bundles. Paqvilo does not run it; a project opts in on its own and
keeps exports, lint configuration and reports in the project.

From the project directory, install the tools and keep the lockfile:

```sh
npm install --save-dev --save-exact eslint @microsoft/eslint-plugin-power-apps
```

Create `eslint.power-apps.config.mjs`. This example enables every rule the installed plugin exports as a warning; it
is not the plugin's `paCheckerHosted` preset:

```js
import powerApps from '@microsoft/eslint-plugin-power-apps';

export default [
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script' },
    plugins: { '@microsoft/power-apps': powerApps },
    rules: Object.fromEntries(Object.keys(powerApps.rules).map((name) => [`@microsoft/power-apps/${name}`, 'warn'])),
  },
];
```

Point ESLint at the files you maintain, for example an unpacked Solution in the project:

```sh
npx --no-install eslint --config eslint.power-apps.config.mjs "solutions/Example/WebResources/**/*.js"
```

Warnings do not fail ESLint; add `--max-warnings=0` if CI should fail on them. Parse errors always fail. Set
`sourceType: 'module'` for module sources and exclude generated or third-party files. Once installed, the lint runs
offline.

## Reading the results

The rules inspect source patterns, including code paths a test may never run. A clean result does not prove the
native app supports a script, that every unsupported pattern was found, or that the hosted checker agrees.
`use-client-context` (not `avoid-2011-api`) reports `Xrm.Page`, but not every form of access (`Xrm["Page"]` passes),
and `do-not-make-parent-assumption` ignores expressions containing `Xrm`, such as `parent.Xrm.Page`.

Mirage maps `Xrm.Page` to its local form context, and HTML resources in frames may reach `parent.Xrm` or the DOM
through same-origin access. Mirage reports unsupported client API members, but it does not warn about such browser
access, and local success does not establish native behaviour. Use lint alongside project tests and native
verification; see the [client API](model-driven-client-api.md).
