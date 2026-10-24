import { IInputs, IOutputs } from './generated/ManifestTypes';
import { ChoiceEditor } from '../shared/choice-editor';
export class ExampleOptionSet
  extends ChoiceEditor<IInputs>
  implements ComponentFramework.StandardControl<IInputs, IOutputs>
{
  constructor() {
    super('ExampleOptionSet');
  }
  public getOutputs(): IOutputs {
    return { controlValue: this._value };
  }
}
