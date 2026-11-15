import { modelDrivenObservationRuntime } from './model-driven-observation.mjs';

/** Serialize the same bounded, read-only native adapter used by node inspection. */
/* NOSONAR */ export const inspectModelDrivenContext = new Function(
  'origin',
  'return (' + modelDrivenObservationRuntime.toString() + ')().readContext(origin);',
);
