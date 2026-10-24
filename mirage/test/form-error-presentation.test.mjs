import test from 'node:test';
import assert from 'node:assert/strict';
import { formWriteError } from '../lib/form-error-presentation.mjs';
import { DataStore } from '../lib/data.mjs';

test('native form failures retain configured validation messages and conceal undeclared backend details', async () => {
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
    assert.equal(formWriteError(error).message, 'Choose another name.');
    assert.equal(
      formWriteError(error, { formSubmissionErrorMessage: 'Configured site failure.' }).message,
      'Configured site failure.',
    );
    return true;
  });
  assert.equal(
    formWriteError({ nativeFormWriteFailure: true, code: 'PluginValidation', message: 'Backend internal details' })
      .message,
    'An error occurred while processing your request. Please try again.',
  );
});
