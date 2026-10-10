import { IInputs, IOutputs } from "./generated/ManifestTypes";

export class ExampleTwoOptions implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _value = false;
  private _notifyOutputChanged: () => void = () => undefined;
  private input: HTMLInputElement;
  private label: HTMLSpanElement;
  private readonly onInput = (): void => {
    this._value = this.input.checked;
    this.label.textContent = String(this._value);
    this._notifyOutputChanged();
  };

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement
  ): void {
    this._notifyOutputChanged = notifyOutputChanged;
    this._value = context.parameters.controlValue.raw;
    this.input = document.createElement("input");
    this.input.type = "checkbox";
    this.input.className = "ExampleTwoOptions";
    this.input.checked = this._value;
    this.input.addEventListener("input", this.onInput);
    this.label = document.createElement("span");
    this.label.textContent = String(this._value);
    const row = document.createElement("label");
    row.append(this.input, this.label);
    container.appendChild(row);
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    if (document.activeElement === this.input) return;
    const next = context.parameters.controlValue.raw;
    if (next === this._value) return;
    this._value = next;
    this.input.checked = next;
    this.label.textContent = String(next);
  }

  public getOutputs(): IOutputs {
    return { controlValue: this._value };
  }

  public destroy(): void {
    this.input.removeEventListener("input", this.onInput);
  }
}
