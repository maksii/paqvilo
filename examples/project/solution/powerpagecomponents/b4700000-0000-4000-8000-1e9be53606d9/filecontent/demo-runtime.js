(function(){
 'use strict';
 if(!document.querySelector('script[data-paqvilo-mirage-runtime]'))return;
 const demo=document.querySelector('main .demo,.demo');if(!demo)return;
 const intro=document.createElement('p');intro.className='demo-footnote demo-runtime-label';intro.innerHTML='Mirage · local simulation. Changes stay on this computer. <a href="/_sim/" target="_blank" rel="noopener">Manage data and personas</a>.';demo.prepend(intro);
 const home=document.querySelector('.demo-hero');
 if(home){home.querySelector('.demo-button').href='/approach/web-api/';const tips=home.querySelector('.demo-footnote');tips.innerHTML='Sign in with a local demo contact. Open Arcwell Services in the Web API workspace, edit a field, then add a contact. <a href="/SignIn?returnUrl=%2Fapproach%2Fweb-api%2F">Start with local sign-in</a>.';const online=[...demo.querySelectorAll('p')].find(p=>p.textContent.startsWith('On this online portal'));if(online)online.textContent='12 invented accounts, 24 related contacts and two notes are ready to explore. Restarting the demo restores this dataset; source edits remain in the project.';}
 if(document.querySelector('[data-demo-extended]')){
  const notice=document.createElement('div');notice.className='demo-status';notice.textContent='These registered operations run locally. Server logic reads the simulated tables; Example Location evaluates its exported request and response. External services and unsupported flow actions require a project simulation.';demo.querySelector('.demo-extended-grid').before(notice);
 }
})();
