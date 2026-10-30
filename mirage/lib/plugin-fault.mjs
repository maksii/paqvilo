// Plug-in fault shape shared by the custom API and the plug-in pipeline. A leaf module: it imports nothing but DataError, so the
// core plug-in code (exported-plugins.mjs) can load it without pulling in the Dataverse modules.
import { DataError } from './data-error.mjs';

// Same URL as dataverse-odata.mjs cdsHelpLink (kept here so this module has no Dataverse import).
const cdsHelpLink = (code) =>
  `http://go.microsoft.com/fwlink/?LinkID=398563&error=Microsoft.Crm.CrmException%3a${code.slice(2)}&client=platform`;

// Generic CLR SubErrorCode native sends when the plug-in names no errorCode of its own.
const PLUGIN_SUBERROR = -2146233088;

// Native plug-in faults, with the annotations native sends (they appear only when Prefer asks for them). The plug-in's
// own InvalidPluginExecutionException is 0x80040265 with its message; an errorCode it names is not the top-level code but
// the signed SubErrorCode. Any other throw is unhandled (0x80040224), and so is a timeout, whose message names the type.
// Assumed: the assembly is the type's namespace, and the trace block is the one-line
// layout native sends; the timeout annotations are the unhandled ones. `plugin.label` names a step's own handler in the
// trace block (a custom API names its implementation).
export function pluginFailure(error, plugin, timeoutMs) {
  const { name, id, type, traces, label = `CustomApi '${name}' implementation` } = plugin;
  const fault = error?.pluginFault === 'InvalidPluginExecutionException';
  const code = fault ? '0x80040265' : '0x80040224';
  const limit = timeoutMs % 60000 === 0 ? `${timeoutMs / 60000}-minute` : `${timeoutMs / 1000}-second`;
  const message = fault
    ? String(error.message)
    : error?.timedOut
      ? `An unexpected error occurred from ISV code. (ErrorType = ClientError) Unexpected exception from plug-in (Execute):  ${type}: System.TimeoutException: Couldn’t complete execution of the ${type} plug-in within the ${limit} limit. Please refer https://go.microsoft.com/fwlink/?linkid=2255411 for more details`
      : (error?.message ?? String(error));
  const trace = traces.join('\n');
  const assembly = type.includes('.') ? type.slice(0, type.lastIndexOf('.')) : type;
  const cds = {
    ...(fault
      ? {
          'Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus': '0',
          'Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode': String(
            error.errorCode == null ? PLUGIN_SUBERROR : Number(error.errorCode) | 0,
          ),
          'Microsoft.PowerApps.CDS.ErrorDetails.Plugin.ExceptionFromPluginExecute': type,
          'Microsoft.PowerApps.CDS.ErrorDetails.Plugin.ExceptionRetriable': 'False',
          'Microsoft.PowerApps.CDS.ErrorDetails.Plugin.ExceptionSource': 'PluginExecution',
          'Microsoft.PowerApps.CDS.ErrorDetails.Plugin.OriginalException': 'PluginExecution',
          'Microsoft.PowerApps.CDS.ErrorDetails.Plugin.PluginTrace': trace,
        }
      : {}),
    'Microsoft.PowerApps.CDS.HelpLink': cdsHelpLink(code),
    'Microsoft.PowerApps.CDS.TraceText': `\r\n[${assembly}: ${type}]\r\n[${id}: ${label}]\r\n\r\n\t\r\n\t${trace}\r\n\t\r\n`,
    'Microsoft.PowerApps.CDS.InnerError.Message': message,
  };
  return new DataError(message, 400, 'InvalidRequest', { innerCode: code, cdsAnnotations: cds });
}
