/** Drain all post-commit consumers to a common quiescent point. A consumer may
 * create work for another consumer, so a single sequential drain is insufficient. */
export async function settleCommittedWork(store,runners,{close=false}={}){
 const active=runners.filter(Boolean);
 if(close){const boundary=store.committedEventSequence??0;for(const runner of active)runner.beginClose(boundary);}
 do{for(const runner of active)await runner.drain();await store.flushCommittedEvents();}while(active.some(runner=>runner.status().pending));
 if(close)for(const runner of active)await runner.close();
}
