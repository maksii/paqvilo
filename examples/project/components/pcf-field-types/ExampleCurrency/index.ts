import { createEditor, releaseEditor, numberValue } from '../shared/editor';
import { IInputs, IOutputs } from './generated/ManifestTypes';

export class ExampleCurrency implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _value: number | undefined;
  private _notifyOutputChanged: () => void = () => undefined;
  private input: HTMLInputElement | HTMLTextAreaElement;
  private readonly onInput = (): void => {
    this._value = this.input.value === '' ? undefined : Number(this.input.value);
    this._notifyOutputChanged();
  };

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement,
  ): void {
    this._notifyOutputChanged = notifyOutputChanged;
    const raw = context.parameters.controlValue.raw;
    this._value = numberValue(raw);
    this.input = createEditor(
      container,
      'ExampleCurrency',
      this._value === undefined ? '' : String(this._value),
      this.onInput,
      'number',
      'any',
    );
    this.input.disabled = context.mode.isControlDisabled;
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    this.input.disabled = context.mode.isControlDisabled;
    if (document.activeElement === this.input) return;
    const raw = context.parameters.controlValue.raw;
    const next = numberValue(raw);
    if (next === this._value) return;
    this._value = next;
    this.input.value = next === undefined ? '' : String(next);
  }

  public getOutputs(): IOutputs {
    return { controlValue: this._value };
  }

  public destroy(): void {
    releaseEditor(this.input, this.onInput);
  }
}
