import test from 'node:test';
import assert from 'node:assert/strict';
import {parseXmlDocument,planFetch} from '../lib/fetchxml-engine.mjs';
const source='<fetch useraworderby="true"><entity name="widget"><attribute name="widgetid"/><filter type="and"><filter type="and" anyallalias="widget_team1"><link-entity name="widget_team" from="widgetid" to="widgetid" link-type="any"><filter><condition attribute="teamid" operator="eq" value="person"/></filter></link-entity></filter></filter></entity></fetch>';
test('private OData annotations require exact generated filter sidecars in strict planning',()=>{
  assert.throws(()=>planFetch(parseXmlDocument(source),{profile:'webapi'}),/anyallalias/);
  const plan=planFetch(parseXmlDocument(source),{profile:'webapi',generatedAnyAllAliases:[{filterOrdinal:1,alias:'widget_team1'}]});
  assert.equal(plan.rawChoiceOrder,true);assert.equal(plan.links.length,1);assert.deepEqual(plan.diagnostics,[]);
  for(const annotations of [[{filterOrdinal:0,alias:'widget_team1'}],[{filterOrdinal:1,alias:'other'}],[{filterOrdinal:1,alias:'widget_team1'},{filterOrdinal:1,alias:'widget_team1'}],[{filterOrdinal:1,alias:'widget_team1',unexpected:true}]])
    assert.throws(()=>planFetch(parseXmlDocument(source),{profile:'webapi',generatedAnyAllAliases:annotations}),error=>error.code==='LocalPluginQueryUnsupported');
});
