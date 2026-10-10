import { IInputs, IOutputs } from "./generated/ManifestTypes";

interface PortalShell {
  getTokenDeferred(): Promise<string>;
}

interface ContactRow {
  id: string;
  fullname: string;
}

interface ApiResult {
  ok: boolean;
  text: string;
  entityId: string;
}

function shellFrom(candidate: Window): PortalShell | undefined {
  const host = candidate as Window & { shell?: PortalShell };
  const shell = host.shell;
  if (shell && typeof shell.getTokenDeferred === "function") return shell;
  return undefined;
}

function findShell(): PortalShell | undefined {
  const local = shellFrom(window);
  if (local) return local;
  try {
    if (window.parent && window.parent !== window) return shellFrom(window.parent);
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function guid(value: string): string {
  const match = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.exec(value);
  return match?.[0] ?? "";
}

function parseContacts(text: string): ContactRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.value)) return [];
  const rows: ContactRow[] = [];
  for (const item of parsed.value) {
    if (!isRecord(item)) continue;
    const fullname = typeof item.fullname === "string" ? item.fullname : "";
    const rawId = typeof item.contactid === "string"
      ? item.contactid
      : typeof item["@odata.id"] === "string"
        ? item["@odata.id"]
        : "";
    const id = guid(rawId);
    if (id) rows.push({ id, fullname });
  }
  return rows;
}

export class ExamplePortalWebApi implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _status = "";
  private _notifyOutputChanged: () => void = () => undefined;
  private nameInput: HTMLInputElement;
  private contacts: HTMLSelectElement;
  private result: HTMLDivElement;
  private buttons: { element: HTMLButtonElement; handler: () => void }[] = [];
  private readonly onCreate = (): void => {
    void this.createContact();
  };
  private readonly onRetrieve = (): void => {
    void this.retrieveContacts();
  };
  private readonly onUpdate = (): void => {
    void this.updateContact();
  };
  private readonly onDelete = (): void => {
    void this.deleteContact();
  };

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement
  ): void {
    this._notifyOutputChanged = notifyOutputChanged;
    this._status = context.parameters.controlValue.raw ?? "";
    const root = document.createElement("div");
    root.className = "ExamplePortalWebApi";

    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.className = "fullname";
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Full name ";
    nameLabel.appendChild(this.nameInput);

    this.contacts = document.createElement("select");
    this.contacts.className = "contacts";
    this.setContacts([]);
    const contactLabel = document.createElement("label");
    contactLabel.textContent = "Contact ";
    contactLabel.appendChild(this.contacts);

    const actions = document.createElement("div");
    actions.append(
      this.button("Create contact", this.onCreate),
      this.button("Retrieve contacts", this.onRetrieve),
      this.button("Update contact", this.onUpdate),
      this.button("Delete contact", this.onDelete)
    );

    this.result = document.createElement("div");
    this.result.className = "result";
    this.result.textContent = this._status;
    root.append(nameLabel, contactLabel, actions, this.result);
    container.appendChild(root);
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    const next = context.parameters.controlValue.raw ?? "";
    if (next === this._status) return;
    this._status = next;
    this.result.textContent = next;
  }

  public getOutputs(): IOutputs {
    return { controlValue: this._status };
  }

  public destroy(): void {
    for (const button of this.buttons) button.element.removeEventListener("click", button.handler);
  }

  private button(text: string, handler: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", handler);
    this.buttons.push({ element: button, handler });
    return button;
  }

  private finish(result: string, status: string): void {
    this.result.textContent = result;
    this._status = status;
    this._notifyOutputChanged();
  }

  private async call(method: string, url: string, body?: Record<string, string>): Promise<ApiResult | undefined> {
    const shell = findShell();
    if (!shell) {
      this.finish("shell is missing", "shell is missing");
      return undefined;
    }
    try {
      const token = await shell.getTokenDeferred();
      const headers: Record<string, string> = {
        Accept: "application/json",
        __RequestVerificationToken: token,
      };
      if (body) headers["Content-Type"] = "application/json";
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      const entityId = guid(response.headers.get("entityid") ?? response.headers.get("odata-entityid") ?? "");
      if (!response.ok) {
        this.finish(text || String(response.status), "Request failed");
        return undefined;
      }
      return { ok: true, text, entityId };
    } catch (error) {
      this.finish(error instanceof Error ? error.message : "Request failed", "Request failed");
      return undefined;
    }
  }

  private async createContact(): Promise<void> {
    const fullname = this.nameInput.value.trim() || "Sample Contact";
    const result = await this.call("POST", "/_api/contacts", { fullname });
    if (!result) return;
    if (result.entityId) this.upsertContact(result.entityId, fullname);
    this.finish(result.text || result.entityId || "Created contact", "Created contact");
  }

  private async retrieveContacts(): Promise<void> {
    const result = await this.call("GET", "/_api/contacts?$select=fullname&$top=5");
    if (!result) return;
    const rows = parseContacts(result.text);
    this.setContacts(rows);
    this.finish(result.text || "Retrieved contacts", `Retrieved ${rows.length} contacts`);
  }

  private async updateContact(): Promise<void> {
    const id = this.contacts.value;
    if (!id) {
      this.finish("Select a contact.", "Select a contact");
      return;
    }
    const fullname = this.nameInput.value.trim();
    if (!fullname) {
      this.finish("Enter a full name.", "Enter a full name");
      return;
    }
    const result = await this.call("PATCH", `/_api/contacts(${id})`, { fullname });
    if (!result) return;
    this.upsertContact(id, fullname);
    this.finish(result.text || "Updated contact", "Updated contact");
  }

  private async deleteContact(): Promise<void> {
    const id = this.contacts.value;
    if (!id) {
      this.finish("Select a contact.", "Select a contact");
      return;
    }
    const result = await this.call("DELETE", `/_api/contacts(${id})`);
    if (!result) return;
    this.contacts.querySelector(`option[value="${CSS.escape(id)}"]`)?.remove();
    this.finish(result.text || "Deleted contact", "Deleted contact");
  }

  private setContacts(rows: ContactRow[]): void {
    const selected = this.contacts.value;
    this.contacts.replaceChildren();
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Select a contact";
    this.contacts.appendChild(blank);
    for (const row of rows) this.upsertContact(row.id, row.fullname);
    this.contacts.value = selected;
  }

  private upsertContact(id: string, fullname: string): void {
    const found = this.contacts.querySelector(`option[value="${CSS.escape(id)}"]`);
    const option = found instanceof HTMLOptionElement ? found : document.createElement("option");
    if (!(found instanceof HTMLOptionElement)) {
      option.value = id;
      this.contacts.appendChild(option);
    }
    option.textContent = fullname || id;
  }
}
