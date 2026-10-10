import { IInputs, IOutputs } from "./generated/ManifestTypes";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(value: Date, withTime: boolean): string {
  const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  if (!withTime) return date;
  return `${date}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function parseDate(value: string, withTime: boolean): Date | undefined {
  if (!value) return undefined;
  if (!withTime) {
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return undefined;
    return new Date(year, month - 1, day);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export class ExampleDateOnly implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _value: Date | undefined;
  private _notifyOutputChanged: () => void = () => undefined;
  private input: HTMLInputElement;
  private readonly onInput = (): void => {
    this._value = parseDate(this.input.value, false);
    this._notifyOutputChanged();
  };

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement
  ): void {
    this._notifyOutputChanged = notifyOutputChanged;
    const initialRaw: unknown = context.parameters.controlValue.raw;
    const raw = initialRaw instanceof Date ? initialRaw : typeof initialRaw === "string" && initialRaw ? new Date(initialRaw) : undefined;
    this._value = raw && !Number.isNaN(raw.getTime()) ? raw : undefined;
    this.input = document.createElement("input");
    this.input.type = "date";
    this.input.className = "ExampleDateOnly";
    this.input.value = this._value ? formatDate(this._value, false) : "";
    this.input.addEventListener("input", this.onInput);
    container.appendChild(this.input);
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    if (document.activeElement === this.input) return;
    const value: unknown = context.parameters.controlValue.raw;
    const raw = value instanceof Date ? value : typeof value === "string" && value ? new Date(value) : undefined;
    const next = raw && !Number.isNaN(raw.getTime()) ? raw : undefined;
    const same = this._value?.getTime() === next?.getTime();
    if (same) return;
    this._value = next;
    this.input.value = next ? formatDate(next, false) : "";
  }

  public getOutputs(): IOutputs {
    return { controlValue: this._value };
  }

  public destroy(): void {
    this.input.removeEventListener("input", this.onInput);
  }
}
