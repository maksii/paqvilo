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

/***/ "./ExampleLinearInput/index.ts"
/*!*************************************!*\
  !*** ./ExampleLinearInput/index.ts ***!
  \*************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

eval("{__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   ExampleLinearInput: () => (/* binding */ ExampleLinearInput)\n/* harmony export */ });\nclass ExampleLinearInput {\n  constructor() {\n    this._value = 0;\n  }\n  init(context, notifyOutputChanged, _state, container) {\n    var _a, _b, _c;\n    this._notifyOutputChanged = notifyOutputChanged;\n    this._refreshData = this.refreshData.bind(this);\n    this._container = document.createElement(\"div\");\n    this.input = document.createElement(\"input\");\n    this.input.setAttribute(\"type\", \"range\");\n    this.input.setAttribute(\"min\", \"1\");\n    this.input.setAttribute(\"max\", \"1000\");\n    this.input.className = \"linearslider\";\n    this.input.addEventListener(\"input\", this._refreshData);\n    this.label = document.createElement(\"label\");\n    this.label.className = \"linear-range-label\";\n    this._value = (_a = context.parameters.controlValue.raw) !== null && _a !== void 0 ? _a : 0;\n    this.input.value = (_b = context.parameters.controlValue.formatted) !== null && _b !== void 0 ? _b : \"0\";\n    this.label.innerHTML = (_c = context.parameters.controlValue.formatted) !== null && _c !== void 0 ? _c : \"0\";\n    this._container.appendChild(this.input);\n    this._container.appendChild(this.label);\n    container.appendChild(this._container);\n  }\n  refreshData() {\n    this._value = Number(this.input.value);\n    this.label.innerHTML = this.input.value;\n    this._notifyOutputChanged();\n  }\n  updateView(context) {\n    var _a, _b;\n    this._value = (_a = context.parameters.controlValue.raw) !== null && _a !== void 0 ? _a : 0;\n    var formatted = (_b = context.parameters.controlValue.formatted) !== null && _b !== void 0 ? _b : \"\";\n    this.input.value = formatted;\n    this.label.innerHTML = formatted;\n  }\n  getOutputs() {\n    return {\n      controlValue: this._value\n    };\n  }\n  destroy() {\n    this.input.removeEventListener(\"input\", this._refreshData);\n  }\n}\n\n//# sourceURL=webpack://pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad/./ExampleLinearInput/index.ts?\n}");

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
/******/ 	__webpack_modules__["./ExampleLinearInput/index.ts"](0,__webpack_exports__,__webpack_require__);
/******/ 	pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad = __webpack_exports__;
/******/
/******/ })()
;
if (window.ComponentFramework && window.ComponentFramework.registerControl) {
	ComponentFramework.registerControl('ExamplePages.ExampleLinearInput', pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad.ExampleLinearInput);
} else {
	var ExamplePages = ExamplePages || {};
	ExamplePages.ExampleLinearInput = pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad.ExampleLinearInput;
	pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad = undefined;
}