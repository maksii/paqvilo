/*
 * ATTENTION: The "eval" devtool has been used (maybe by default in mode: "development").
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
var pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad;
/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./ExamplePortalWebApi/index.ts"
/*!**************************************!*\
  !*** ./ExamplePortalWebApi/index.ts ***!
  \**************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

eval("{__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   ExamplePortalWebApi: () => (/* binding */ ExamplePortalWebApi)\n/* harmony export */ });\nvar __awaiter = undefined && undefined.__awaiter || function (thisArg, _arguments, P, generator) {\n  function adopt(value) {\n    return value instanceof P ? value : new P(function (resolve) {\n      resolve(value);\n    });\n  }\n  return new (P || (P = Promise))(function (resolve, reject) {\n    function fulfilled(value) {\n      try {\n        step(generator.next(value));\n      } catch (e) {\n        reject(e);\n      }\n    }\n    function rejected(value) {\n      try {\n        step(generator[\"throw\"](value));\n      } catch (e) {\n        reject(e);\n      }\n    }\n    function step(result) {\n      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);\n    }\n    step((generator = generator.apply(thisArg, _arguments || [])).next());\n  });\n};\nfunction shellFrom(candidate) {\n  var host = candidate;\n  var shell = host.shell;\n  if (shell && typeof shell.getTokenDeferred === \"function\") return shell;\n  return undefined;\n}\nfunction findShell() {\n  var local = shellFrom(window);\n  if (local) return local;\n  try {\n    if (window.parent && window.parent !== window) return shellFrom(window.parent);\n  } catch (_a) {\n    return undefined;\n  }\n  return undefined;\n}\nfunction isRecord(value) {\n  return typeof value === \"object\" && value !== null;\n}\nfunction guid(value) {\n  var _a;\n  var match = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.exec(value);\n  return (_a = match === null || match === void 0 ? void 0 : match[0]) !== null && _a !== void 0 ? _a : \"\";\n}\nfunction parseContacts(text) {\n  var parsed;\n  try {\n    parsed = JSON.parse(text);\n  } catch (_a) {\n    return [];\n  }\n  if (!isRecord(parsed) || !Array.isArray(parsed.value)) return [];\n  var rows = [];\n  for (var item of parsed.value) {\n    if (!isRecord(item)) continue;\n    var fullname = typeof item.fullname === \"string\" ? item.fullname : \"\";\n    var rawId = typeof item.contactid === \"string\" ? item.contactid : typeof item[\"@odata.id\"] === \"string\" ? item[\"@odata.id\"] : \"\";\n    var id = guid(rawId);\n    if (id) rows.push({\n      id,\n      fullname\n    });\n  }\n  return rows;\n}\nclass ExamplePortalWebApi {\n  constructor() {\n    this._status = \"\";\n    this._notifyOutputChanged = () => undefined;\n    this.buttons = [];\n    this.onCreate = () => {\n      void this.createContact();\n    };\n    this.onRetrieve = () => {\n      void this.retrieveContacts();\n    };\n    this.onUpdate = () => {\n      void this.updateContact();\n    };\n    this.onDelete = () => {\n      void this.deleteContact();\n    };\n  }\n  init(context, notifyOutputChanged, _state, container) {\n    var _a;\n    this._notifyOutputChanged = notifyOutputChanged;\n    this._status = (_a = context.parameters.controlValue.raw) !== null && _a !== void 0 ? _a : \"\";\n    var root = document.createElement(\"div\");\n    root.className = \"ExamplePortalWebApi\";\n    this.nameInput = document.createElement(\"input\");\n    this.nameInput.type = \"text\";\n    this.nameInput.className = \"fullname\";\n    var nameLabel = document.createElement(\"label\");\n    nameLabel.textContent = \"Full name \";\n    nameLabel.appendChild(this.nameInput);\n    this.contacts = document.createElement(\"select\");\n    this.contacts.className = \"contacts\";\n    this.setContacts([]);\n    var contactLabel = document.createElement(\"label\");\n    contactLabel.textContent = \"Contact \";\n    contactLabel.appendChild(this.contacts);\n    var actions = document.createElement(\"div\");\n    actions.append(this.button(\"Create contact\", this.onCreate), this.button(\"Retrieve contacts\", this.onRetrieve), this.button(\"Update contact\", this.onUpdate), this.button(\"Delete contact\", this.onDelete));\n    this.result = document.createElement(\"div\");\n    this.result.className = \"result\";\n    this.result.textContent = this._status;\n    root.append(nameLabel, contactLabel, actions, this.result);\n    container.appendChild(root);\n  }\n  updateView(context) {\n    var _a;\n    var next = (_a = context.parameters.controlValue.raw) !== null && _a !== void 0 ? _a : \"\";\n    if (next === this._status) return;\n    this._status = next;\n    this.result.textContent = next;\n  }\n  getOutputs() {\n    return {\n      controlValue: this._status\n    };\n  }\n  destroy() {\n    for (var button of this.buttons) button.element.removeEventListener(\"click\", button.handler);\n  }\n  button(text, handler) {\n    var button = document.createElement(\"button\");\n    button.type = \"button\";\n    button.textContent = text;\n    button.addEventListener(\"click\", handler);\n    this.buttons.push({\n      element: button,\n      handler\n    });\n    return button;\n  }\n  finish(result, status) {\n    this.result.textContent = result;\n    this._status = status;\n    this._notifyOutputChanged();\n  }\n  call(method, url, body) {\n    return __awaiter(this, void 0, void 0, function* () {\n      var _a, _b;\n      var shell = findShell();\n      if (!shell) {\n        this.finish(\"shell is missing\", \"shell is missing\");\n        return undefined;\n      }\n      try {\n        var token = yield shell.getTokenDeferred();\n        var headers = {\n          Accept: \"application/json\",\n          __RequestVerificationToken: token\n        };\n        if (body) headers[\"Content-Type\"] = \"application/json\";\n        var response = yield fetch(url, {\n          method,\n          headers,\n          body: body ? JSON.stringify(body) : undefined\n        });\n        var text = yield response.text();\n        var entityId = guid((_b = (_a = response.headers.get(\"entityid\")) !== null && _a !== void 0 ? _a : response.headers.get(\"odata-entityid\")) !== null && _b !== void 0 ? _b : \"\");\n        if (!response.ok) {\n          this.finish(text || String(response.status), \"Request failed\");\n          return undefined;\n        }\n        return {\n          ok: true,\n          text,\n          entityId\n        };\n      } catch (error) {\n        this.finish(error instanceof Error ? error.message : \"Request failed\", \"Request failed\");\n        return undefined;\n      }\n    });\n  }\n  createContact() {\n    return __awaiter(this, void 0, void 0, function* () {\n      var fullname = this.nameInput.value.trim() || \"Sample Contact\";\n      var result = yield this.call(\"POST\", \"/_api/contacts\", {\n        fullname\n      });\n      if (!result) return;\n      if (result.entityId) this.upsertContact(result.entityId, fullname);\n      this.finish(result.text || result.entityId || \"Created contact\", \"Created contact\");\n    });\n  }\n  retrieveContacts() {\n    return __awaiter(this, void 0, void 0, function* () {\n      var result = yield this.call(\"GET\", \"/_api/contacts?$select=fullname&$top=5\");\n      if (!result) return;\n      var rows = parseContacts(result.text);\n      this.setContacts(rows);\n      this.finish(result.text || \"Retrieved contacts\", \"Retrieved \".concat(rows.length, \" contacts\"));\n    });\n  }\n  updateContact() {\n    return __awaiter(this, void 0, void 0, function* () {\n      var id = this.contacts.value;\n      if (!id) {\n        this.finish(\"Select a contact.\", \"Select a contact\");\n        return;\n      }\n      var fullname = this.nameInput.value.trim();\n      if (!fullname) {\n        this.finish(\"Enter a full name.\", \"Enter a full name\");\n        return;\n      }\n      var result = yield this.call(\"PATCH\", \"/_api/contacts(\".concat(id, \")\"), {\n        fullname\n      });\n      if (!result) return;\n      this.upsertContact(id, fullname);\n      this.finish(result.text || \"Updated contact\", \"Updated contact\");\n    });\n  }\n  deleteContact() {\n    return __awaiter(this, void 0, void 0, function* () {\n      var _a;\n      var id = this.contacts.value;\n      if (!id) {\n        this.finish(\"Select a contact.\", \"Select a contact\");\n        return;\n      }\n      var result = yield this.call(\"DELETE\", \"/_api/contacts(\".concat(id, \")\"));\n      if (!result) return;\n      (_a = this.contacts.querySelector(\"option[value=\\\"\".concat(CSS.escape(id), \"\\\"]\"))) === null || _a === void 0 ? void 0 : _a.remove();\n      this.finish(result.text || \"Deleted contact\", \"Deleted contact\");\n    });\n  }\n  setContacts(rows) {\n    var selected = this.contacts.value;\n    this.contacts.replaceChildren();\n    var blank = document.createElement(\"option\");\n    blank.value = \"\";\n    blank.textContent = \"Select a contact\";\n    this.contacts.appendChild(blank);\n    for (var row of rows) this.upsertContact(row.id, row.fullname);\n    this.contacts.value = selected;\n  }\n  upsertContact(id, fullname) {\n    var found = this.contacts.querySelector(\"option[value=\\\"\".concat(CSS.escape(id), \"\\\"]\"));\n    var option = found instanceof HTMLOptionElement ? found : document.createElement(\"option\");\n    if (!(found instanceof HTMLOptionElement)) {\n      option.value = id;\n      this.contacts.appendChild(option);\n    }\n    option.textContent = fullname || id;\n  }\n}\n\n//# sourceURL=webpack://pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad/./ExamplePortalWebApi/index.ts?\n}");

/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The require scope
/******/ 	const __webpack_require__ = {};
/******/
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	// define getter/value functions for harmony exports
/******/ 	__webpack_require__.d = (exports, definition) => {
/******/ 		for(var key in definition) {
/******/ 			if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 				Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 			}
/******/ 		}
/******/ 	};
/******/
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop));
/******/
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	// define __esModule on exports
/******/ 	__webpack_require__.r = (exports) => {
/******/ 		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 		Object.defineProperty(exports, '__esModule', { value: true });
/******/ 	};
/******/
/************************************************************************/
/******/
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module can't be inlined because the eval devtool is used.
/******/ 	let __webpack_exports__ = {};
/******/ 	__webpack_modules__["./ExamplePortalWebApi/index.ts"](0,__webpack_exports__,__webpack_require__);
/******/ 	pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad = __webpack_exports__;
/******/
/******/ })()
;
if (window.ComponentFramework && window.ComponentFramework.registerControl) {
	ComponentFramework.registerControl('ExamplePages.ExamplePortalWebApi', pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad.ExamplePortalWebApi);
} else {
	var ExamplePages = ExamplePages || {};
	ExamplePages.ExamplePortalWebApi = pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad.ExamplePortalWebApi;
	pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad = undefined;
}