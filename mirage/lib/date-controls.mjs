/** Convert exported .NET display tokens to the captured Moment date-picker's tokens. */
export function datePickerFormat(format, dateOnly = true) {
  return String(
    format || (dateOnly ? "dd/MM/yyyy" : "dd/MM/yyyy HH:mm"),
  ).replace(/'[^']*'|yyyy|yyy|yy|dddd|ddd|dd|d|tt/g, (token) =>
    token.startsWith("'")
      ? "[" + token.slice(1, -1) + "]"
      : {
          yyyy: "YYYY",
          yyy: "YYYY",
          yy: "YY",
          dddd: "dddd",
          ddd: "ddd",
          dd: "DD",
          d: "D",
          tt: "A",
        }[token],
  );
}

/** Bind the actual captured native picker; no substitute DateTimePicker API is installed. */
export function clientDateControlsRuntime() {
  return `(() => {
    const initialize=()=>{
      const jq=window.jQuery;
      for(const group of document.querySelectorAll('[data-sim-date-target]')){
        if(group.dataset.simDateReady)continue;
        const input=document.getElementById(group.dataset.simDateTarget),display=group.querySelector('input');
        if(!input||!display)continue;
        if(typeof jq?.fn?.datetimepicker!=='function'||typeof window.moment!=='function'){
          const dateOnly=group.dataset.simDateOnly==='true';
          if(input.readOnly){
            display.value=input.value||'';display.readOnly=true;display.setAttribute?.('readonly','readonly');display.classList.add('readonly');
            const icon=group.querySelector('.input-group-addon');if(icon)icon.style.display='none';
          }else{
            display.type=dateOnly?'date':'datetime-local';display.value=(input.value||'').slice(0,dateOnly?10:16);
            display.addEventListener('change',()=>{input.value=display.value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
          }
          group.dataset.simDateReady='native-fallback';
          ((globalThis.__portalSimulation||={}).compatibility||={}).datePickerMode='browser-native-fallback';
          console.info('Browser-native date compatibility active for '+input.id+'; captured native picker dependencies are unavailable.');
          continue;
        }
        let syncing=false;
        const dateOnly=group.dataset.simDateOnly==='true',format=display.dataset?.dateFormat||group.dataset.dateFormat;
        const control=jq(group);control.datetimepicker({format,useCurrent:false});
        const picker=control.data('DateTimePicker');
        const parse=value=>value?window.moment(value,window.moment.ISO_8601,true):null;
        const initial=parse(input.value);
        if(initial?.isValid())picker.date(initial);
        // Native readonly forms keep the formatted textbox visible. Disabling
        // the picker disables that textbox and changes the source CSS contract.
        // The platform marks the box readonly="readonly" (page scripts test the attribute) and
        // drops the input group of a read-only picker.
        if(input.readOnly){display.readOnly=true;display.setAttribute?.('readonly','readonly');display.classList.add('readonly');group.classList?.remove('input-append','input-group');group.querySelector('.input-group-addon').style.display='none';}
        control.on('dp.change',event=>{
          if(syncing)return;syncing=true;
          try{input.value=event.date?event.date.format(dateOnly?'YYYY-MM-DD':'YYYY-MM-DDTHH:mm:ss'):'';jq(input).trigger('change');}
          finally{syncing=false;}
        });
        jq(input).on('change',()=>{
          if(syncing)return;syncing=true;
          try{const value=parse(input.value);if(!value||value.isValid())picker.date(value);}
          finally{syncing=false;}
        });
        group.dataset.simDateReady='true';
      }
    };
    // The platform's crmentityformview-datetime.js equivalent re-runs this (idempotent per control).
    (window.__portalSimulation ||= {}).initializeDateControls=initialize;
    if(['interactive','complete'].includes(document.readyState))initialize();else document.addEventListener('DOMContentLoaded',initialize);
  })();`;
}
