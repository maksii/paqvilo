import { createEditor, releaseEditor } from '../shared/editor';
import { IInputs, IOutputs } from './generated/ManifestTypes';

export class ExampleMultiple implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _value = '';
  private _notifyOutputChanged: () => void = () => undefined;
  private input: HTMLInputElement | HTMLTextAreaElement;
  private readonly onInput = (): void => {
    this._value = this.input.value;
    this._notifyOutputChanged();
  };

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement,
  ): void {
    this._notifyOutputChanged = notifyOutputChanged;
    this._value = context.parameters.controlValue.raw ?? '';
    this.input = createEditor(container, 'ExampleMultiple', this._value, this.onInput, 'textarea');
    this.input.disabled = context.mode.isControlDisabled;
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    this.input.disabled = context.mode.isControlDisabled;
    if (document.activeElement === this.input) return;
    const next = context.parameters.controlValue.raw ?? '';
    if (next === this._value) return;
    this._value = next;
    this.input.value = next;
  }

  public getOutputs(): IOutputs {
    return { controlValue: this._value };
  }

  public destroy(): void {
    releaseEditor(this.input, this.onInput);
  }
}
