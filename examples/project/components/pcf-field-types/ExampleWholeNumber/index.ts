import { IInputs, IOutputs } from "./generated/ManifestTypes";

export class ExampleWholeNumber implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _value: number | undefined;
  private _notifyOutputChanged: () => void = () => undefined;
  private input: HTMLInputElement;
  private readonly onInput = (): void => {
    this._value = this.input.value === "" ? undefined : Number(this.input.value);
    this._notifyOutputChanged();
  };

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement
  ): void {
    this._notifyOutputChanged = notifyOutputChanged;
    const raw = context.parameters.controlValue.raw;
    this._value = raw === null || Number.isNaN(raw) ? undefined : raw;
    this.input = document.createElement("input");
    this.input.type = "number";
    this.input.step = "1";
    this.input.className = "ExampleWholeNumber";
    this.input.value = this._value === undefined ? "" : String(this._value);
    this.input.addEventListener("input", this.onInput);
    container.appendChild(this.input);
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    if (document.activeElement === this.input) return;
    const raw = context.parameters.controlValue.raw;
    const next = raw === null || Number.isNaN(raw) ? undefined : raw;
    if (next === this._value) return;
    this._value = next;
    this.input.value = next === undefined ? "" : String(next);
  }

  public getOutputs(): IOutputs {
    return { controlValue: this._value };
  }

  public destroy(): void {
    this.input.removeEventListener("input", this.onInput);
  }
}
