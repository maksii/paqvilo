import { modelDrivenObservationRuntime } from './model-driven-observation.mjs';

/** Serialize the same bounded, read-only native adapter used by node inspection. */
export const inspectModelDrivenContext = new Function(
  'origin',
  'return (' + modelDrivenObservationRuntime.toString() + ')().readContext(origin);',
);
