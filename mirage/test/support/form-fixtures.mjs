// Survey schemas and an answer store stub for the web form suites (form-action-handler, multistep-markup): a two-step survey
// whose steps each suite builds with its own step function, and a store that resolves the answer mapping and holds no rows.
// Invented names only.

/** The two-step survey; `step(stepId, extra)` builds each step in the calling suite's own shape. */
export const surveySchemas = (step) => ({
  survey: {
    initialStepId: 'one',
    steps: [step('one', { nextStepId: 'two', title: 'One' }), step('two', { title: 'Two' })],
  },
});

/** A store for the answer entity with one mapping and no rows; every call returns a fresh object. */
export const emptyAnswerStore = () => ({
  resolveMapping: () => ({ entitySet: 'answers', idColumn: 'answerid' }),
  get: async () => null,
  query: async () => ({ value: [] }),
});
