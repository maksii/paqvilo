using System;
using Microsoft.Xrm.Sdk;

namespace Paqvilo.Demo.Plugins
{
    public sealed class ContactRules : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            if (context.PrimaryEntityName != "contact" || (context.MessageName != "Create" && context.MessageName != "Update") || !context.InputParameters.Contains("Target") || !(context.InputParameters["Target"] is Entity target)) return;
            var lastName = target.GetAttributeValue<string>("lastname");
            if (context.Stage == 10 && target.Contains("lastname") && (lastName == null || lastName.Trim().Length < 2))
                throw new InvalidPluginExecutionException("Contact last name must contain at least 2 characters.");
            if (context.Stage != 20) return;
            foreach (var field in new[] { "firstname", "lastname" })
                if (target.Contains(field)) target[field] = target.GetAttributeValue<string>(field)?.Trim();
            if (target.Contains("emailaddress1")) target["emailaddress1"] = target.GetAttributeValue<string>("emailaddress1")?.Trim().ToLowerInvariant();
        }
    }
}
