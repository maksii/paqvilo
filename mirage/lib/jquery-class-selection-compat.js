// jQuery 3.7 fast paths must not use a form adapter's word-boundary class finder,
// including when the caller belongs to the parent window of a form iframe.
(function ($) {
  if (!$?.find || $.find.__ppNativeClassSelection) return;
  const find = $.find;
  const select = (selector, context) => (context || document).querySelectorAll(selector);
  const wrapped = function (selector, context, results, seed) {
    if (!seed && typeof selector === 'string' && /^\.[\w-]+$/.test(selector)) {
      const output = results || [];
      if(context&&![1,9,11].includes(context.nodeType))return output;
      Array.prototype.push.apply(output, select('.'+CSS.escape(selector.slice(1)), context));
      return output;
    }
    return find.apply(this, arguments);
  };
  Object.assign(wrapped, find);
  wrapped.__ppNativeClassSelection = true;
  $.find = wrapped;
  // setDocument() installs its fast finder again whenever the selector engine
  // switches iframe documents. Keep the guarded finder across those assignments.
  if ($.expr?.find) Object.defineProperty($.expr.find,'CLASS',{
    configurable:true,enumerable:true,
    get:()=> (name,context)=>select('.'+CSS.escape(name),context),
    set:()=>{},
  });
})(window.jQuery);
