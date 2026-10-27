import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasRenderingGaps } from '../lib/canvas-rendering.mjs';
import { canvasRequirementRows } from '../lib/source-graph.mjs';

test('rendering admission keeps modern controls and components visible as gaps', () => {
  const tree = {
    screens: [
      {
        name: 'Home',
        controls: [
          { name: 'Caption', control: 'Label@2.5.1' },
          { name: 'Save', control: 'Classic/Button@2.2.0' },
          { name: 'Photo', control: 'Image@2.2.3' },
          { name: 'ModernSave', control: 'Button@0.0.45' },
          { name: 'Custom', control: 'CanvasComponent', componentName: 'Example' },
        ],
      },
    ],
  };
  const gaps = canvasRenderingGaps({ tree });
  assert.deepEqual(
    gaps.map((gap) => gap.name),
    ['ModernSave', 'Custom'],
  );
  const rows = canvasRequirementRows([{ component: 'canvasapp', name: 'invented', level: 'behaviour', tree }]);
  assert.equal(rows.find((row) => row.id === 'canvas:rendering').status, 'unsupported');
  assert.equal(rows.find((row) => row.id === 'canvas:app/invented').status, 'satisfied');
});

test('retired source controls retain their legacy names while basic pa.yaml rendering is a contract', () => {
  const tree = {
    format: 'fx.yaml',
    screens: [
      {
        name: 'Home',
        controls: [
          { name: 'Input', control: 'text' },
          { name: 'Save', control: 'button' },
        ],
      },
    ],
  };
  assert.deepEqual(canvasRenderingGaps({ tree }), []);
  const row = canvasRequirementRows([{ component: 'canvasapp', name: 'invented', level: 'behaviour', tree }]).find(
    (row) => row.id === 'canvas:rendering',
  );
  assert.equal(row.status, 'satisfied');
  assert.equal(row.level, 'contract');
});
