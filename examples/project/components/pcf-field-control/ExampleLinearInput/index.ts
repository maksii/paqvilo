import { IInputs, IOutputs } from "./generated/ManifestTypes";

export class ExampleLinearInput implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _value: number;
  private _notifyOutputChanged: () => void;
  private label: HTMLLabelElement;
  private input: HTMLInputElement;
  private _container: HTMLDivElement;
  private _refreshData: EventListener;

  constructor() {
    this._value = 0;
  }

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement
  ): void {
    this._notifyOutputChanged = notifyOutputChanged;
    this._refreshData = this.refreshData.bind(this);
    this._container = document.createElement("div");
    this.input = document.createElement("input");
    this.input.setAttribute("type", "range");
    this.input.setAttribute("min", "1");
    this.input.setAttribute("max", "1000");
    this.input.className = "linearslider";
    this.input.addEventListener("input", this._refreshData);
    this.label = document.createElement("label");
    this.label.className = "linear-range-label";
    this._value = context.parameters.controlValue.raw ?? 0;
    this.input.value = context.parameters.controlValue.formatted ?? "0";
    this.label.innerHTML = context.parameters.controlValue.formatted ?? "0";
    this._container.appendChild(this.input);
    this._container.appendChild(this.label);
    container.appendChild(this._container);
  }

  public refreshData(): void {
    this._value = Number(this.input.value);
    this.label.innerHTML = this.input.value;
    this._notifyOutputChanged();
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    this._value = context.parameters.controlValue.raw ?? 0;
    const formatted = context.parameters.controlValue.formatted ?? "";
    this.input.value = formatted;
    this.label.innerHTML = formatted;
  }

  public getOutputs(): IOutputs {
    return { controlValue: this._value };
  }

  public destroy(): void {
    this.input.removeEventListener("input", this._refreshData);
  }
}
