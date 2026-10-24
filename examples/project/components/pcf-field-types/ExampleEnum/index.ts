import { IInputs, IOutputs } from './generated/ManifestTypes';
import { ChoiceEditor } from '../shared/choice-editor';
export class ExampleEnum
  extends ChoiceEditor<IInputs>
  implements ComponentFramework.StandardControl<IInputs, IOutputs>
{
  constructor() {
    super('ExampleEnum');
  }
  public getOutputs(): IOutputs {
    return { controlValue: this._value === undefined ? undefined : String(this._value) };
  }
}
