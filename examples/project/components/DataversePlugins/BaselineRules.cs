using System;
using System.Xml.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Paqvilo.Demo.Plugins
{
    // Baseline fixture plugin for pqvd_baselineitem. Sentinel steps throw when pqvd_text equals
    // "plugin-fail-<message>-<stage>" (Create/Update/Delete read Target or the "baseline" pre-image;
    // Retrieve reads OutputParameters["BusinessEntity"]). The RetrieveMultiple step removes rows whose
    // pqvd_text equals "plugin-hide-retrievemultiple". Unsecure configuration "mutate" normalizes
    // pqvd_ticker and pqvd_textarea; "noop" does nothing (steps that exist only for their registration
    // state: impersonation, async mode, disabled). The Update post-operation step carries a
    // "baselinepost" post-image that the code never requires.
    public sealed class BaselineRules : IPlugin
    {
        private const string Table = "pqvd_baselineitem";
        private readonly string configuration;

        public BaselineRules(string unsecureConfiguration, string secureConfiguration)
        {
            configuration = unsecureConfiguration?.Trim() ?? "";
        }

        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            if (configuration == "noop" || context.PrimaryEntityName != Table) return;
            var message = context.MessageName.ToLowerInvariant();

            if (message == "retrievemultiple")
            {
                if (context.Stage != 40 || !TargetsTable(context.InputParameters.Contains("Query") ? context.InputParameters["Query"] : null)) return;
                var rows = context.OutputParameters.Contains("BusinessEntityCollection") ? context.OutputParameters["BusinessEntityCollection"] as EntityCollection : null;
                if (rows == null) return;
                for (var i = rows.Entities.Count - 1; i >= 0; i--)
                    if (rows.Entities[i].Contains("pqvd_text") && rows.Entities[i].GetAttributeValue<string>("pqvd_text") == "plugin-hide-retrievemultiple") rows.Entities.RemoveAt(i);
                return;
            }
            if (message != "create" && message != "update" && message != "delete" && message != "retrieve") return;
            var target = context.InputParameters.Contains("Target") ? context.InputParameters["Target"] as Entity : null;

            if (configuration == "mutate")
            {
                if (target == null || message == "delete" || context.Stage != 20) return;
                if (target.Contains("pqvd_ticker")) target["pqvd_ticker"] = target.GetAttributeValue<string>("pqvd_ticker")?.Trim().ToUpperInvariant();
                if (target.Contains("pqvd_textarea") && target.GetAttributeValue<string>("pqvd_textarea") == "mutate-me") target["pqvd_textarea"] = "mutated by plugin";
                return;
            }

            var stage = context.Stage == 10 ? "prevalidation" : context.Stage == 20 ? "preoperation" : context.Stage == 40 ? "postoperation" : null;
            if (stage == null) return;
            var source = message == "delete"
                ? (context.PreEntityImages.Contains("baseline") ? context.PreEntityImages["baseline"] : null)
                : message == "retrieve"
                    ? (context.OutputParameters.Contains("BusinessEntity") ? context.OutputParameters["BusinessEntity"] as Entity : null)
                    : target;
            if (source == null || !source.Contains("pqvd_text")) return;
            if (source.GetAttributeValue<string>("pqvd_text") == "plugin-fail-" + message + "-" + stage)
                throw new InvalidPluginExecutionException("Baseline plugin rejected " + message + " at " + stage);
        }

        private static bool TargetsTable(object query)
        {
            if (query is QueryExpression expression) return expression.EntityName == Table;
            if (query is FetchExpression fetch)
            {
                try { return (string)XDocument.Parse(fetch.Query).Root?.Element("entity")?.Attribute("name") == Table; }
                catch (System.Xml.XmlException) { return false; }
            }
            return false;
        }
    }
}
