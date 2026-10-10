
// The native form is hosted in an iframe with its own document and theme.
(function(){
 document.body.classList.add('demo-native','demo-native-frame');
 if(!document.querySelector('link[data-demo-form-theme]')){const theme=document.createElement('link');theme.rel='stylesheet';theme.href='/demo.css';theme.dataset.demoFormTheme='true';document.head.appendChild(theme);}
})();
