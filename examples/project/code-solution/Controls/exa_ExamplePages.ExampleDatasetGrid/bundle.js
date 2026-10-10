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

/***/ "./ExampleDatasetGrid/index.ts"
/*!*************************************!*\
  !*** ./ExampleDatasetGrid/index.ts ***!
  \*************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

eval("{__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   ExampleDatasetGrid: () => (/* binding */ ExampleDatasetGrid)\n/* harmony export */ });\nclass ExampleDatasetGrid {\n  constructor() {\n    this._root = document.createElement(\"div\");\n    this._root.className = \"example-dataset-grid\";\n  }\n  init(_context, _notifyOutputChanged, _state, container) {\n    container.appendChild(this._root);\n  }\n  updateView(context) {\n    var dataset = context.parameters.sampleDataSet;\n    var columns = dataset.columns.filter(column => !column.isHidden && column.order >= 0);\n    var table = document.createElement(\"table\");\n    var head = document.createElement(\"tr\");\n    for (var column of columns) {\n      var cell = document.createElement(\"th\");\n      cell.textContent = column.displayName;\n      head.appendChild(cell);\n    }\n    table.appendChild(head);\n    for (var id of dataset.sortedRecordIds) {\n      var record = dataset.records[id];\n      var row = document.createElement(\"tr\");\n      for (var _column of columns) {\n        var _cell = document.createElement(\"td\");\n        _cell.textContent = record.getFormattedValue(_column.name);\n        row.appendChild(_cell);\n      }\n      table.appendChild(row);\n    }\n    var paging = document.createElement(\"p\");\n    if (dataset.paging.hasPreviousPage) {\n      var previous = document.createElement(\"button\");\n      previous.type = \"button\";\n      previous.textContent = \"Previous\";\n      previous.addEventListener(\"click\", () => {\n        void dataset.paging.loadPreviousPage();\n      });\n      paging.appendChild(previous);\n    }\n    if (dataset.paging.hasNextPage) {\n      var next = document.createElement(\"button\");\n      next.type = \"button\";\n      next.textContent = \"Next\";\n      next.addEventListener(\"click\", () => {\n        void dataset.paging.loadNextPage();\n      });\n      paging.appendChild(next);\n    }\n    this._root.replaceChildren(table, paging);\n  }\n  getOutputs() {\n    return {};\n  }\n  destroy() {\n    this._root.replaceChildren();\n  }\n}\n\n//# sourceURL=webpack://pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad/./ExampleDatasetGrid/index.ts?\n}");

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
/******/ 	__webpack_modules__["./ExampleDatasetGrid/index.ts"](0,__webpack_exports__,__webpack_require__);
/******/ 	pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad = __webpack_exports__;
/******/
/******/ })()
;
if (window.ComponentFramework && window.ComponentFramework.registerControl) {
	ComponentFramework.registerControl('ExamplePages.ExampleDatasetGrid', pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad.ExampleDatasetGrid);
} else {
	var ExamplePages = ExamplePages || {};
	ExamplePages.ExampleDatasetGrid = pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad.ExampleDatasetGrid;
	pcf_tools_652ac3f36e1e4bca82eb3c1dc44e6fad = undefined;
}