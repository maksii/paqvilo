import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {observeHttpErrors} from '../lense/http-errors.mjs';

test('HTTP capture sets protocol byte bounds and stops reading oversized chunked responses without cancelling them',async()=>{
  const client=new EventEmitter(),calls=[],rows=[];client.send=async(method,args)=>{calls.push({method,args});if(method==='Network.getResponseBody')return {body:JSON.stringify({error:{message:'small'}})};};client.detach=async()=>{};
  const capture=observeHttpErrors({newCDPSession:async()=>client},{},{origin:'http://127.0.0.1:1234',response:entry=>body=>rows.push({entry,body})});await capture.ready;
  assert.deepEqual(calls[0],{method:'Network.enable',args:{maxTotalBufferSize:131072,maxResourceBufferSize:32768,maxPostDataSize:0}});
  const respond=(id,headers={})=>{client.emit('Network.requestWillBeSent',{requestId:id,request:{method:'POST'}});client.emit('Network.responseReceived',{requestId:id,response:{status:400,url:'http://127.0.0.1:1234/_api/items?private=excluded',mimeType:'application/json',headers}});};
  respond('large');client.emit('Network.dataReceived',{requestId:'large',dataLength:20000});client.emit('Network.dataReceived',{requestId:'large',dataLength:20000});client.emit('Network.loadingFinished',{requestId:'large'});
  assert.equal(calls.filter(call=>call.method==='Network.getResponseBody').length,0);assert.equal(rows[0].body,null);assert.equal(rows[0].entry.path,'/_api/items');
  respond('small');client.emit('Network.loadingFinished',{requestId:'small'});await new Promise(r=>setImmediate(r));assert.equal(rows[1].body.error.message,'small');
  respond('sized',{'Content-Length':'40000'});assert.equal(rows[2].body,null);
  respond('closed');await capture.close();client.emit('Network.loadingFinished',{requestId:'closed'});assert.equal(rows.length,3);
  assert.ok(calls.every(call=>['Network.enable','Network.getResponseBody'].includes(call.method)),'observing must never abort, replay or change a request');
});

test('stalled observer attach, enable and detach cannot hold startup or shutdown open',async()=>{
  const never=()=>new Promise(()=>{}),client=new EventEmitter();client.send=never;client.detach=never;
  const enabled=observeHttpErrors({newCDPSession:async()=>client},{},{origin:'http://127.0.0.1:1234',response:()=>()=>{},timeoutMs:25});
  await assert.rejects(enabled.ready,/timed out/);assert.equal(enabled.failed,true);await enabled.close();assert.equal(client.listenerCount('Network.responseReceived'),0);
  let attach;const detached=[];const late=observeHttpErrors({newCDPSession:()=>new Promise(resolve=>{attach=resolve;})},{},{origin:'http://127.0.0.1:1234',response:()=>()=>{},timeoutMs:25});
  await late.close();await assert.rejects(late.ready,/timed out/);attach({detach:async()=>detached.push(true)});await new Promise(r=>setImmediate(r));assert.equal(detached.length,1,'a late connection is still released');
});

test('unfinished small JSON errors still produce an HTTP row within the body deadline',async()=>{
  const client=new EventEmitter(),rows=[];client.send=async()=>({});client.detach=async()=>{};
  const capture=observeHttpErrors({newCDPSession:async()=>client},{},{origin:'http://127.0.0.1:1234',response:entry=>body=>rows.push({entry,body}),timeoutMs:25});await capture.ready;
  client.emit('Network.responseReceived',{requestId:'unfinished',response:{status:400,url:'http://127.0.0.1:1234/_api/items',mimeType:'application/json',headers:{}}});
  client.emit('Network.dataReceived',{requestId:'unfinished',dataLength:10});
  await new Promise(r=>setTimeout(r,40));assert.equal(rows.length,1);assert.equal(rows[0].entry.status,400);assert.equal(rows[0].body,null);
  client.emit('Network.loadingFinished',{requestId:'unfinished'});await new Promise(r=>setImmediate(r));assert.equal(rows.length,1,'late completion must not duplicate an expired row');await capture.close();
});
