// @test-kind unproven: local presentation of basic-form write failures other than plug-in refusals (toolkit fallback text)
import test from 'node:test';
import assert from 'node:assert/strict';
import { formWriteError } from '../lib/form-error-presentation.mjs';
import { DataStore } from '../lib/data.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FALLBACK = 'An error occurred while processing your request. Please try again.';

// @test-kind observation: native basic-form plug-in refusal display, 7 captures on 2026-11-15 (InvalidPluginExecutionException shown as the generic Error ID text unless Site/EnableCustomPluginError is true)
test('a plug-in refusal shows the unknown failure with its request id, or its message when Site/EnableCustomPluginError is true', async () => {
  const store = new DataStore({
    state: {
      mappings: { widget: { idColumn: 'widgetid', entitySet: 'widgets' } },
      tables: { widget: [] },
      settings: { permissionMode: 'permissive' },
      plugins: [
        {
          id: 'field-validation',
          entity: 'widget',
          operations: ['create'],
          validate: [{ field: 'title', pattern: '^(?!Blocked$).+', message: 'Choose another name.' }],
        },
      ],
    },
  });
  await assert.rejects(store.create('widget', { title: 'Blocked' }), (error) => {
    assert.equal(formWriteError(error), null);
    error.nativeFormWriteFailure = true;
    const outcome = formWriteError(error);
    assert.match(outcome.requestId, GUID);
    assert.equal(outcome.message, `An unknown failure has occurred. Error ID # [${outcome.requestId}]`);
    assert.match(
      formWriteError(error, { formSubmissionErrorMessage: 'Configured site failure.' }).message,
      /^An unknown failure has occurred\. Error ID # \[[0-9a-f-]{36}\]$/,
    );
    assert.equal(
      formWriteError(error, undefined, 'entityform', {
        settings: { 'site/enablecustompluginerror': { value: 'True' } },
      }).message,
      'Choose another name.',
    );
    return true;
  });
  const legacy = formWriteError({
    nativeFormWriteFailure: true,
    code: 'PluginValidation',
    message: 'Backend internal details',
  });
  assert.match(legacy.message, /^An unknown failure has occurred\. Error ID # \[[0-9a-f-]{36}\]$/);
  assert.doesNotMatch(legacy.message, /Backend internal details/);
});

// @test-kind unproven: an ordinary plug-in exception and other Dataverse failures keep the toolkit fallback; no native display was captured for them
test('other write failures keep the toolkit fallback and carry no request id', () => {
  const ordinary = formWriteError({
    nativeFormWriteFailure: true,
    code: 'InvalidRequest',
    status: 400,
    message: 'x',
    details: { innerCode: '0x80040224' },
  });
  assert.equal(ordinary.message, FALLBACK);
  assert.equal(ordinary.requestId, undefined);

  const exceptionFault = { nativeFormWriteFailure: true, code: 'InvalidRequest', status: 400, message: 'x' };
  Object.defineProperty(exceptionFault, 'traceError', { value: { type: 'Exception' } });
  const exception = formWriteError(exceptionFault);
  assert.equal(exception.message, FALLBACK);
  assert.equal(exception.requestId, undefined);

  assert.equal(
    formWriteError({ nativeFormWriteFailure: true, code: 'PermissionDenied' }).message,
    "You don't have the appropriate permissions.",
  );
});

// @test-kind contract: observed.formSubmissionErrorMessage is the documented per-site override of the toolkit fallback (mirage/docs/forms-lists-parity.md)
test('observed.formSubmissionErrorMessage replaces the toolkit fallback', () => {
  const ordinary = {
    nativeFormWriteFailure: true,
    code: 'InvalidRequest',
    status: 400,
    message: 'x',
    details: { innerCode: '0x80040224' },
  };
  assert.equal(
    formWriteError(ordinary, { formSubmissionErrorMessage: 'Configured site failure.' }).message,
    'Configured site failure.',
  );
});
