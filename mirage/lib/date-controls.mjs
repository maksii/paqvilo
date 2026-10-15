/** Convert exported .NET display tokens to the captured Moment date-picker's tokens. */
export function datePickerFormat(format, dateOnly = true) {
  return String(
    format || (dateOnly ? "M/d/yyyy" : "M/d/yyyy h:mm tt"),
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
    const convert=${datePickerFormat.toString()};
    // Bound controls are tracked in script state: the platform markup carries no local attributes.
    const ready=((window.__portalSimulation||={}).dateControlsReady||=new WeakSet());
    const initialize=()=>{
      const jq=window.jQuery;
      const bs5=Boolean(document.querySelector('link[href*=".BootstrapV5."]'));
      for(const input of document.querySelectorAll('input[data-ui="datetimepicker"]')){
        if(ready.has(input)||!input.id)continue;
        ready.add(input);
        // crmentityformview-datetime.js: the bound box is hidden, the picker group follows it
        // with the *_datepicker_description box and the calendar button, and the label targets
        // the visible box. A read-only picker keeps no input group and hides its button.
        const id=input.id,dateOnly=input.dataset.type==='date',required=Boolean(document.getElementById('RequiredFieldValidator'+id));
        input.style.display='none';
        const group=document.createElement('div');
        group.className=input.readOnly?'datetimepicker':'input-append input-group datetimepicker';
        group.setAttribute('role','none');
        group.innerHTML='<input type="text" aria-describedby="'+id+'_description" id="'+id+'_datepicker_description" aria-labelledby="'+id+'_label" onchange="setIsDirty(this.id);" class="form-control input-text-box'+(input.readOnly?' readonly" readonly="readonly"':'"')+(required?' aria-required="true"':'')+'><span tabindex="0" role="button" title="Choose a date" class="input-group-addon'+(bs5?' btn"':'" aria-label="Choose a date"')+(input.readOnly?' style="display: none;"':'')+'><span data-date-icon="icon-calendar fa fa-calendar" data-time-icon="icon-time fa fa-clock'+(bs5?'':'-o')+'" class="icon-calendar fa fa-calendar iconBorder"></span></span>';
        input.insertAdjacentElement('afterend',group);
        group.__simDateTarget=input;
        const label=document.querySelector('label[for="'+CSS.escape(id)+'"]');
        if(label)label.setAttribute('for',id+'_datepicker_description');
        const display=group.querySelector('input');
        const userLocal=input.dataset?.behavior==='UserLocal';
        if(typeof jq?.fn?.datetimepicker!=='function'||typeof window.moment!=='function'){
          if(input.readOnly){
            display.value=input.value||'';display.readOnly=true;display.setAttribute?.('readonly','readonly');display.classList.add('readonly');
            const icon=group.querySelector('.input-group-addon');if(icon)icon.style.display='none';
          }else{
            display.type=dateOnly?'date':'datetime-local';display.value=(input.value||'').slice(0,dateOnly?10:16);
            display.addEventListener('change',()=>{
              const value=display.value;
              if(!value)input.value='';
              else if(userLocal){const parts=value.split(/[-T:]/).map(Number),date=new Date(0);date.setFullYear(parts[0],parts[1]-1,parts[2]);date.setHours(parts[3]||0,parts[4]||0,0,0);input.value=date.toISOString().replace(/\\.\\d{3}Z$/,'.0000000Z');}
              else input.value=(dateOnly?value+'T00:00:00':value.length===16?value+':00':value)+'.0000000';
              input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
            });
          }
          ((globalThis.__portalSimulation||={}).compatibility||={}).datePickerMode='browser-native-fallback';
          console.info('Browser-native date compatibility active for '+input.id+'; captured native picker dependencies are unavailable.');
          continue;
        }
        let syncing=false;
        const sourceFormat=name=>input.closest?.('[data-'+name+']')?.getAttribute('data-'+name);
        const dateFormat=sourceFormat('dateformat'),timeFormat=sourceFormat('timeformat'),dateTimeFormat=sourceFormat('datetimeformat');
        const format=dateOnly?(dateFormat?convert(dateFormat,true):display.dataset?.dateFormat||convert(null,true))
          :dateTimeFormat?convert(dateTimeFormat,false):(dateFormat||timeFormat)?convert(dateFormat||'M/d/yyyy',true)+' '+convert(timeFormat||'h:mm tt',false):display.dataset?.dateFormat||convert(null,false);
        display.dataset.dateFormat=format;
        if(!input.readOnly)display.setAttribute('placeholder',format);
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
        const changed=event=>{
          if(syncing)return;syncing=true;
          try{
            if(event.date){let date=event.date.clone();if(!/[sS]/.test(format))date.seconds(0);if(dateOnly)date.hours(0).minutes(0).seconds(0);input.value=(userLocal?date.utc():date).format('YYYY-MM-DDTHH:mm:ss[.0000000]'+(userLocal?'[Z]':''));}
            else input.value='';
            jq(input).trigger('change');
          }
          finally{syncing=false;}
        };
        if(jq.fn.datetimepicker.__ppSimCompat)group.addEventListener('sim:datechange',event=>changed(event.detail));
        else control.on('dp.change',changed);
        jq(input).on('change',()=>{
          if(syncing)return;syncing=true;
          try{const value=parse(input.value);if(!value||value.isValid())picker.date(value);}
          finally{syncing=false;}
        });
      }
    };
    // The platform's crmentityformview-datetime.js equivalent re-runs this (idempotent per control).
    (window.__portalSimulation ||= {}).initializeDateControls=initialize;
    if(['interactive','complete'].includes(document.readyState))initialize();else document.addEventListener('DOMContentLoaded',initialize);
  })();`;
}
