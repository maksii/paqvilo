function estimate(input) {
  const units=Number(input.units),price=Number(input.price),discount=Number(input.discount),tax=Number(input.tax);
  if(!Number.isFinite(units)||units<1||units>1000||Math.floor(units)!==units||!Number.isFinite(price)||price<0||price>100000||!Number.isFinite(discount)||discount<0||discount>50||!Number.isFinite(tax)||tax<0||tax>30){return JSON.stringify({success:false,message:'Use 1 to 1000 whole units, a non-negative price, 0 to 50% discount and 0 to 30% tax.'});}
  const round=value=>Math.round((value+Number.EPSILON)*100)/100;
  const subtotal=round(units*price),discountAmount=round(subtotal*discount/100),net=round(subtotal-discountAmount),taxAmount=round(net*tax/100);
  return JSON.stringify({success:true,currency:'EUR',units,unitPrice:price,subtotal,discountAmount,net,taxAmount,total:round(net+taxAmount),calculatedBy:'Power Pages server logic'});
}
function post(){return estimate(JSON.parse(Server.Context.Body||'{}'));}
function calculate(){return estimate(JSON.parse(Server.Context.Input||'{}'));}
function get(){return estimate({units:3,price:120,discount:10,tax:20});}
