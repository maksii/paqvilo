(function(){
 'use strict';
 if(!document.querySelector('script[data-paqvilo-mirage-runtime]'))return;
 const demo=document.querySelector('main .demo,.demo');if(!demo)return;
 const intro=document.createElement('p');intro.className='demo-footnote demo-runtime-label';intro.innerHTML='Mirage · local simulation. Changes stay on this computer. <a href="/_sim/" target="_blank" rel="noopener">Manage data and personas</a>.';demo.prepend(intro);
 const home=document.querySelector('.demo-hero');
 if(home){home.querySelector('.demo-button').href='/approach/web-api/';const tips=home.querySelector('.demo-footnote');tips.innerHTML='Sign in with a local demo contact. Open Arcwell Services in the Web API workspace, edit a field, then add a contact. <a href="/SignIn?returnUrl=%2Fapproach%2Fweb-api%2F">Start with local sign-in</a>.';const online=[...demo.querySelectorAll('p')].find(p=>p.textContent.startsWith('On this online portal'));if(online)online.textContent='12 invented accounts, 24 related contacts and two notes are ready to explore. Restarting the demo restores this dataset; source edits remain in the project.';}
 if(document.querySelector('[data-demo-extended]')){
  const notice=document.createElement('div');notice.className='demo-status';notice.textContent='Server logic and cloud flows run in Power Pages. Mirage imports their source but does not execute these operations. The controls below document the online examples.';demo.querySelector('.demo-extended-grid').before(notice);demo.querySelectorAll('button[type="submit"],[data-load-overview]').forEach(b=>b.disabled=true);demo.querySelector('[data-liquid-result]').textContent='Execute this Liquid operation on the online Power Pages portal.';
 }
 if(demo.classList.contains('demo-native')&&new URLSearchParams(location.search).get('id')){
  const notice=document.createElement('div');notice.className='demo-status';notice.innerHTML='This export exercises native fields and contacts. Mirage currently omits the native notes control. <a href="/approach/web-api/account/'+location.search.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))+'">Open the same account in Web API</a> for notes and attachments.';demo.querySelector('.demo-actions').after(notice);
 }
})();
