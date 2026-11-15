# Lint model-driven JavaScript web resources

Microsoft's [Power Apps checker ESLint plugin](https://www.npmjs.com/package/@microsoft/eslint-plugin-power-apps) offers static checks for model-driven app JavaScript web resources. Project owners can opt in independently of Paqvilo. This setup is for authored model-driven JavaScript, including form libraries and JavaScript command handlers. It is not a Power Pages JavaScript, canvas app, HTML inline script or PCF bundle checker. Scope the input to your own unpacked Solution resources; keep exports and lint reports in the project.

From your project directory, install compatible versions and keep the resulting lockfile:

```sh
npm install --save-dev --save-exact eslint@10.13.0 @microsoft/eslint-plugin-power-apps@0.6.0
```

Create `eslint.power-apps.config.mjs` in that project:

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

Point ESLint at the model-driven JavaScript files you maintain. For example, if the unpacked Solution is under the project:

```sh
npx --no-install eslint --config eslint.power-apps.config.mjs "solutions/Example/WebResources/**/*.js"
```

The example enables all 26 rules exported by plugin version 0.6.0 with default options and warning severity. Its bundled `paCheckerHosted` preset enables 21 rules with a mixture of warnings and errors; this example is not that preset. Choose rules, options and severities for the project. Warnings normally do not fail ESLint; use `--max-warnings=0` if the project deliberately wants warnings to fail CI. Parsing failures still fail. Set `sourceType` appropriately for module-based sources, and exclude generated or third-party files when they are not your lint target. Once dependencies are installed, the lint command runs locally without connecting to the platform.

## Interpretation

These rules inspect source patterns, including paths that may not run in a particular test. A clean result does not prove that the native app supports a script, that all unsupported patterns were detected, or that hosted checker results are identical. Review each finding in its context; for example, a DOM rule cannot by itself prove a particular access targets the platform-managed form rather than a resource's own document. The plugin's `avoid-2011-api` rule does not flag every use of `Xrm.Page`, and `do-not-make-parent-assumption` excludes expressions containing `Xrm`.

Mirage supports a bounded Client API and maps `Xrm.Page` to its local form context. Its app exposes `Xrm`, and HTML resources can run in frames where same-origin browser access to `parent.Xrm` or the DOM may be possible. Successful local access does not establish support or equivalent behavior in the native app. Mirage reports unsupported simulated Client API calls, but it does not provide a general checker warning for these browser accesses. Use lint alongside project tests and native verification; see the [Client API limits](model-driven-client-api.md) and [Solution customization guide](model-driven-customizations.md).
