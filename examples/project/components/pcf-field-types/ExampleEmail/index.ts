import { IInputs, IOutputs } from "./generated/ManifestTypes";

export class ExampleEmail implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _value = "";
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
    container: HTMLDivElement
  ): void {
    this._notifyOutputChanged = notifyOutputChanged;
    this._value = context.parameters.controlValue.raw ?? "";
    const field = document.createElement("input");
    field.type = "email";
    this.input = field;
    field.className = "ExampleEmail";
    field.value = this._value;
    field.addEventListener("input", this.onInput);
    container.appendChild(field);
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    if (document.activeElement === this.input) return;
    const next = context.parameters.controlValue.raw ?? "";
    if (next === this._value) return;
    this._value = next;
    this.input.value = next;
  }

  public getOutputs(): IOutputs {
    return { controlValue: this._value };
  }

  public destroy(): void {
    this.input.removeEventListener("input", this.onInput);
  }
}
