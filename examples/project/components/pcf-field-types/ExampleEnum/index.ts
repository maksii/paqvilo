import { IInputs, IOutputs } from "./generated/ManifestTypes";

interface Choice {
  Value: number;
  Label: string;
}

function isChoice(value: unknown): value is Choice {
  if (typeof value !== "object" || value === null) return false;
  if (!("Value" in value) || !("Label" in value)) return false;
  return typeof value.Value === "number" && typeof value.Label === "string";
}

function readChoices(parameter: object): Choice[] | undefined {
  if (!("attributes" in parameter)) return undefined;
  const attributes: unknown = parameter.attributes;
  if (typeof attributes !== "object" || attributes === null || !("Options" in attributes)) return undefined;
  const options: unknown = attributes.Options;
  if (!Array.isArray(options)) return undefined;
  const choices = options.filter(isChoice);
  return choices.length > 0 ? choices : undefined;
}

function readNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && !Number.isNaN(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

export class ExampleEnum implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _value: number | undefined;
  private _notifyOutputChanged: () => void = () => undefined;
  private container: HTMLDivElement;
  private editor: HTMLSelectElement | HTMLInputElement | undefined;
  private mode = "";
  private readonly onEdit = (): void => {
    const text = this.editor?.value ?? "";
    this._value = text === "" ? undefined : Number(text);
    this._notifyOutputChanged();
  };

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement
  ): void {
    this._notifyOutputChanged = notifyOutputChanged;
    this.container = document.createElement("div");
    container.appendChild(this.container);
    this._value = readNumber(context.parameters.controlValue.raw);
    this.render(context);
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    if (document.activeElement === this.editor) return;
    const next = readNumber(context.parameters.controlValue.raw);
    if (next !== this._value) this._value = next;
    this.render(context);
  }

  public getOutputs(): IOutputs {
    return { controlValue: this._value === undefined ? undefined : String(this._value) };
  }

  public destroy(): void {
    this.editor?.removeEventListener("input", this.onEdit);
    this.editor?.removeEventListener("change", this.onEdit);
  }

  private render(context: ComponentFramework.Context<IInputs>): void {
    const choices = readChoices(context.parameters.controlValue);
    const mode = choices ? "select" : "number";
    if (mode !== this.mode) {
      this.editor?.removeEventListener("input", this.onEdit);
      this.editor?.removeEventListener("change", this.onEdit);
      this.editor?.remove();
      this.mode = mode;
      if (choices) {
        const select = document.createElement("select");
        select.addEventListener("change", this.onEdit);
        this.editor = select;
      } else {
        const input = document.createElement("input");
        input.type = "number";
        input.addEventListener("input", this.onEdit);
        this.editor = input;
      }
      this.editor.className = "ExampleEnum";
      this.container.appendChild(this.editor);
    }
    const editor = this.editor;
    const selected = this._value === undefined ? "" : String(this._value);
    if (editor instanceof HTMLSelectElement && choices) {
      editor.replaceChildren();
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "";
      editor.appendChild(blank);
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = String(choice.Value);
        option.textContent = choice.Label;
        editor.appendChild(option);
      }
      editor.value = selected;
    } else if (editor instanceof HTMLInputElement && editor.value !== selected) {
      editor.value = selected;
    }
  }
}
