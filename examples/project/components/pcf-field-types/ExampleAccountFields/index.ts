import { IInputs, IOutputs } from "./generated/ManifestTypes";
import { ExampleText } from "../ExampleText";
import { ExampleEmail } from "../ExampleEmail";
import { ExamplePhone } from "../ExamplePhone";
import { ExampleUrl } from "../ExampleUrl";
import { ExampleTicker } from "../ExampleTicker";
import { ExampleTextArea } from "../ExampleTextArea";
import { ExampleWholeNumber } from "../ExampleWholeNumber";
import { ExampleCurrency } from "../ExampleCurrency";
import { ExampleDecimal } from "../ExampleDecimal";
import { ExampleFloat } from "../ExampleFloat";
import { ExampleOptionSet } from "../ExampleOptionSet";
import { ExampleTwoOptions } from "../ExampleTwoOptions";
import { ExampleDateOnly } from "../ExampleDateOnly";
import { ExampleDateTime } from "../ExampleDateTime";

type Editor = ComponentFramework.StandardControl<IInputs, IOutputs>;
type Field = [string, string, string, string | null, string];
const fields: Field[] = [["name","Account name","text","ExampleText","Organisation"],["accountnumber","Account number","text",null,"Organisation"],["emailaddress1","Email","email","ExampleEmail","Organisation"],["telephone1","Phone","tel","ExamplePhone","Organisation"],["websiteurl","Website","url","ExampleUrl","Organisation"],["tickersymbol","Ticker symbol","text","ExampleTicker","Organisation"],["description","Description","textarea","ExampleTextArea","Organisation"],["numberofemployees","Employees","integer","ExampleWholeNumber","Numbers and choices"],["creditlimit","Credit limit","currency","ExampleCurrency","Numbers and choices"],["pqvd_decimal","Service score","decimal","ExampleDecimal","Numbers and choices"],["pqvd_float","Capacity estimate","float","ExampleFloat","Numbers and choices"],["industrycode","Industry","choice","ExampleOptionSet","Numbers and choices"],["donotemail","Do not email","boolean","ExampleTwoOptions","Numbers and choices"],["pqvd_dateonly","Review date","date","ExampleDateOnly","Dates and relationships"],["pqvd_datetime","Next appointment","datetime-local","ExampleDateTime","Dates and relationships"],["parentaccountid","Parent account","lookup",null,"Dates and relationships"],["primarycontactid","Primary contact","lookup",null,"Dates and relationships"],["address1_line1","Street","text",null,"Address"],["address1_city","City","text",null,"Address"],["address1_postalcode","Postal code","text",null,"Address"]];
const industryOptions: { Value: number; Label: string }[] = [{"Value":1,"Label":"Accounting"},{"Value":2,"Label":"Agriculture and Non-petrol Natural Resource Extraction"},{"Value":3,"Label":"Broadcasting Printing and Publishing"},{"Value":4,"Label":"Brokers"},{"Value":5,"Label":"Building Supply Retail"},{"Value":6,"Label":"Business Services"},{"Value":7,"Label":"Consulting"},{"Value":8,"Label":"Consumer Services"},{"Value":9,"Label":"Design, Direction and Creative Management"},{"Value":10,"Label":"Distributors, Dispatchers and Processors"},{"Value":11,"Label":"Doctor's Offices and Clinics"},{"Value":12,"Label":"Durable Manufacturing"},{"Value":13,"Label":"Eating and Drinking Places"},{"Value":14,"Label":"Entertainment Retail"},{"Value":15,"Label":"Equipment Rental and Leasing"},{"Value":16,"Label":"Financial"},{"Value":17,"Label":"Food and Tobacco Processing"},{"Value":18,"Label":"Inbound Capital Intensive Processing"},{"Value":19,"Label":"Inbound Repair and Services"},{"Value":20,"Label":"Insurance"},{"Value":21,"Label":"Legal Services"},{"Value":22,"Label":"Non-Durable Merchandise Retail"},{"Value":23,"Label":"Outbound Consumer Service"},{"Value":24,"Label":"Petrochemical Extraction and Distribution"},{"Value":25,"Label":"Service Retail"},{"Value":26,"Label":"SIG Affiliations"},{"Value":27,"Label":"Social Services"},{"Value":28,"Label":"Special Outbound Trade Contractors"},{"Value":29,"Label":"Specialty Realty"},{"Value":30,"Label":"Transportation"},{"Value":31,"Label":"Utility Creation and Distribution"},{"Value":32,"Label":"Vehicle Retail"},{"Value":33,"Label":"Wholesale"}];
const editors: Record<string, new () => object> = {ExampleText,ExampleEmail,ExamplePhone,ExampleUrl,ExampleTicker,ExampleTextArea,ExampleWholeNumber,ExampleCurrency,ExampleDecimal,ExampleFloat,ExampleOptionSet,ExampleTwoOptions,ExampleDateOnly,ExampleDateTime};

/** One Power Pages PCF host, composed from the project's 14 typed editor modules. */
export class ExampleAccountFields implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private children: Editor[] = [];
  private root: HTMLDivElement;
  private notify: () => void = () => undefined;
  private lastOutput = "";

  public init(context: ComponentFramework.Context<IInputs>, notifyOutputChanged: () => void, _state: ComponentFramework.Dictionary, container: HTMLDivElement): void {
    this.notify = notifyOutputChanged;
    this.root = document.createElement("div");this.root.className = "ExampleAccountFields";container.appendChild(this.root);
    for(const group of [...new Set(fields.map(field=>field[4]))]){
      const section=document.createElement("fieldset");section.className="demo-form-section";
      const legend=document.createElement("legend");legend.textContent=group;section.appendChild(legend);
      const grid=document.createElement("div");grid.className="demo-form-grid";section.appendChild(grid);this.root.appendChild(section);
      for(const [name,label,type,editor] of fields.filter(field=>field[4]===group)){
        const host=document.createElement("div");host.className="demo-field"+(type==="lookup"?" demo-pcf-lookup":"")+(editor?" demo-pcf-field":"")+(type==="textarea"?" wide":"");host.dataset.field=name;grid.appendChild(host);
        const caption=document.createElement("label");caption.htmlFor="pcf-"+name;caption.textContent=label+(name==="name"?" *":"");host.appendChild(caption);
        const detail=document.createElement("span");detail.className="demo-field-type";detail.textContent=editor?"PCF · "+editor:type==="lookup"?"PCF lookup · search and paging":"Text";host.appendChild(detail);
        if(editor){
          const target=document.createElement("div");host.appendChild(target);
          const child=new editors[editor]() as Editor;
          const parameter={raw: type==="boolean"?false:null,formatted:"",attributes:{Options:name==="industrycode"?industryOptions:[],DisplayName:label,LogicalName:name}};
          const childContext=Object.create(context) as ComponentFramework.Context<IInputs>;
          Object.defineProperty(childContext,"parameters",{value:{controlValue:parameter},enumerable:true});
          child.init(childContext,()=>this.notify(),{},target);this.children.push(child);
        }else{
          const input=type==="lookup"?document.createElement("select"):document.createElement("input");
          if(input instanceof HTMLInputElement)input.type="text";else input.add(new Option("None",""));
          input.name=name;input.id="pcf-"+name;host.appendChild(input);
        }
      }
      if(group==="Numbers and choices"){
        const host=document.createElement("div");host.className="demo-field";host.dataset.field="transactioncurrencyid";
        const label=document.createElement("label");label.textContent="Currency";label.htmlFor="pcf-transactioncurrencyid";
        const detail=document.createElement("span");detail.className="demo-field-type";detail.textContent="Lookup · used by credit limit";
        const select=document.createElement("select");select.name="transactioncurrencyid";select.id=label.htmlFor;
        host.append(label,detail,select);grid.appendChild(host);
      }
    }
    for(const host of Array.from(this.root.querySelectorAll<HTMLDivElement>("[data-field]"))){
      const input=host.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>("input,select,textarea");if(!input)continue;
      input.name=host.dataset.field||"";input.id="pcf-"+input.name;input.setAttribute("aria-label",host.querySelector("label")?.textContent||input.name);
      if(input instanceof HTMLInputElement){if(input.name==="name")input.required=true;if(input.type==="number")input.step=input.name==="numberofemployees"?"1":"any";}
      input.addEventListener("change",()=>this.notify());
    }
  }
  public updateView(): void { /* The Web API controller owns record loading and read-only state. */ }
  public getOutputs(): IOutputs {
    const record: Record<string,string|boolean>={};for(const input of Array.from(this.root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>("input[name],select[name],textarea[name]")))record[input.name]=input instanceof HTMLInputElement&&input.type==="checkbox"?input.checked:input.value;
    this.lastOutput=JSON.stringify(record);return {controlValue:this.lastOutput};
  }
  public destroy(): void {for(const child of this.children)child.destroy();this.children=[];this.root.replaceChildren();}
}
