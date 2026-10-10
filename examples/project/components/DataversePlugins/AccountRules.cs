using System;
using System.Linq;
using Microsoft.Xrm.Sdk;

namespace Paqvilo.Demo.Plugins
{
    public sealed class AccountRules : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            if (context.PrimaryEntityName != "account" || (context.MessageName != "Create" && context.MessageName != "Update") || !context.InputParameters.Contains("Target") || !(context.InputParameters["Target"] is Entity target)) return;
            var name = target.GetAttributeValue<string>("name");
            if (context.Stage == 10 && target.Contains("name") && (name == null || name.Trim().Length < 3))
                throw new InvalidPluginExecutionException("Account name must contain at least 3 characters.");
            if (context.Stage != 20) return;
            if (target.Contains("name"))
            {
                target["name"] = name == null ? null : name.Trim();
                target["tickersymbol"] = name == null ? null : new string(name.Trim().Where(c => c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9').Take(10).Select(char.ToUpperInvariant).ToArray());
            }
            if (target.Contains("emailaddress1")) target["emailaddress1"] = target.GetAttributeValue<string>("emailaddress1")?.Trim().ToLowerInvariant();
        }
    }
}
