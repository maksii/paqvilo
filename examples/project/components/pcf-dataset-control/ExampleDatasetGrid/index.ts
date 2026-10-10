import { IInputs, IOutputs } from "./generated/ManifestTypes";

export class ExampleDatasetGrid implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _root: HTMLDivElement;

  constructor() {
    this._root = document.createElement("div");
    this._root.className = "example-dataset-grid";
  }

  public init(
    _context: ComponentFramework.Context<IInputs>,
    _notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement
  ): void {
    container.appendChild(this._root);
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    const dataset = context.parameters.sampleDataSet;
    const columns = dataset.columns.filter((column) => !column.isHidden && column.order >= 0);
    const table = document.createElement("table");
    const head = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("th");
      cell.textContent = column.displayName;
      head.appendChild(cell);
    }
    table.appendChild(head);
    for (const id of dataset.sortedRecordIds) {
      const record = dataset.records[id];
      const row = document.createElement("tr");
      for (const column of columns) {
        const cell = document.createElement("td");
        cell.textContent = record.getFormattedValue(column.name);
        row.appendChild(cell);
      }
      table.appendChild(row);
    }
    const paging = document.createElement("p");
    if (dataset.paging.hasPreviousPage) {
      const previous = document.createElement("button");
      previous.type = "button";
      previous.textContent = "Previous";
      previous.addEventListener("click", () => { void dataset.paging.loadPreviousPage(); });
      paging.appendChild(previous);
    }
    if (dataset.paging.hasNextPage) {
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "Next";
      next.addEventListener("click", () => { void dataset.paging.loadNextPage(); });
      paging.appendChild(next);
    }
    this._root.replaceChildren(table, paging);
  }

  public getOutputs(): IOutputs {
    return {};
  }

  public destroy(): void {
    this._root.replaceChildren();
  }
}
