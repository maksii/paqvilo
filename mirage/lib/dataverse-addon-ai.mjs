// Simulated Dataverse AI Builder, AI function, Copilot and process-mining messages.
// MESSAGES holds the native signatures, copied by a script from the native $metadata (platform names and types only).
// Every message is registered through registerAddon (dataverse-addon-common.mjs), so a trusted pack's dataverseMessages
// handler replaces it. The defaults: a runtime call answers aiUnavailable() (403 0x80048d06; the code is known for Predict
// only and a guess for the others); AIModelPublish is internal-only (registerInternalMessage).
// Deterministic probes answer the capability flags with guessed values. AddToFeedbackLoop is store-backed.
// ponytail: AddToFeedbackLoop does not write the prediction input and output file columns (upgrade via dataverse-files).
// The probes ignore arguments when the corresponding cloud feature is unavailable.
import { parseDataverseRoute, parsePrefer } from './dataverse-odata.mjs';
import { aiUnavailable, argsOf, registerAddon, registerInternalMessage } from './dataverse-addon-common.mjs';

// Documented as "This public message is for internal use only."
const INTERNAL = new Set(['AIModelPublish']);

// Capability probes: guessed answers for an organization without AI Builder or process mining.
const PROBES = {
  IsPaiEnabled: async () => ({
    ispaienabled: false,
    templates: '[]',
    arePreviewScenarioEnabled: false,
    paigastatus: false,
    isdatamodelv2enabled: false,
  }),
  IsPmEnabled: async () => ({ response: 'false' }),
  IsCDS3Ready: async () => ({ IsReady: false }),
  copilottextdatastatus: async () => ({ response: null }),
};

// A feedback-loop row for the model, created through the record handlers as the caller, so plug-ins, audit and field security see it.
// The bound model's id comes from the route; the prediction input and output are not written.
function feedbackLoop(api) {
  return async (c) => {
    api.principals.authorize({
      user: c.user,
      entity: 'msdyn_aimodel',
      operation: 'appendto',
      row: c.target.row,
      mapping: c.target.mapping,
    });
    const mapping = api.store.resolveMapping('msdyn_aibfeedbackloop');
    api.principals.authorize({ user: c.user, entity: mapping.logicalName, operation: 'create', mapping });
    api.principals.authorize({ user: c.user, entity: mapping.logicalName, operation: 'append', mapping });
    const url = new URL(`${c.origin}/api/data/${c.version}/${mapping.entitySet}`);
    await api.records.handle({
      ...c,
      method: 'POST',
      url,
      route: parseDataverseRoute(url.pathname),
      body: {
        msdyn_name: argsOf(c).inputName ?? null,
        'msdyn_AIModelId@odata.bind': `/${c.target.mapping.entitySet}(${c.target.id})`,
      },
      headers: { 'content-type': 'application/json' },
      prefer: parsePrefer(undefined),
    });
    return undefined;
  };
}

// Each entry: name, kind, binding, entity (bound only), params, and response (the <Name>Response properties) or returns.
const MESSAGES = [
  {
    name: 'Predict',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aimodel',
    params: [
      ['version', 'Edm.String'],
      ['request', 'Edm.String'],
      ['requestv2', 'mscrm.crmbaseentity'],
      ['source', 'Edm.String'],
    ],
    response: [
      ['response', 'Edm.String'],
      ['responsev2', 'mscrm.crmbaseentity'],
      ['overrideHttpStatusCode', 'Edm.String'],
      ['overrideLocation', 'Edm.String'],
      ['overrideRetryAfter', 'Edm.String'],
    ],
  },
  {
    name: 'PredictByReference',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aimodel',
    params: [
      ['version', 'Edm.String'],
      ['targetRecordId', 'Edm.String'],
    ],
    response: [
      ['response', 'Edm.String'],
      ['responsev2', 'mscrm.crmbaseentity'],
    ],
  },
  {
    name: 'PredictionSchema',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aimodel',
    params: [
      ['version', 'Edm.String'],
      ['predictionMode', 'Edm.String'],
    ],
    response: [
      ['response', 'Edm.String'],
      ['responsev2', 'mscrm.crmbaseentity'],
    ],
  },
  {
    name: 'BatchPrediction',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aimodel',
    params: [['version', 'Edm.String']],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'Train',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aiconfiguration',
    params: [
      ['version', 'Edm.String'],
      ['source', 'Edm.String'],
    ],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'ScheduleTraining',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aiconfiguration',
    params: [['version', 'Edm.String']],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'UnscheduleTraining',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aiconfiguration',
    params: [['version', 'Edm.String']],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'CancelTraining',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aiconfiguration',
    params: [['version', 'Edm.String']],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'QuickTest',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aiconfiguration',
    params: [
      ['version', 'Edm.String'],
      ['request', 'Edm.String'],
      ['requestv2', 'mscrm.crmbaseentity'],
      ['source', 'Edm.String'],
    ],
    response: [
      ['response', 'Edm.String'],
      ['responsev2', 'mscrm.crmbaseentity'],
      ['overrideHttpStatusCode', 'Edm.String'],
      ['overrideLocation', 'Edm.String'],
      ['overrideRetryAfter', 'Edm.String'],
    ],
  },
  {
    name: 'PublishAIConfiguration',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aiconfiguration',
    params: [
      ['version', 'Edm.String'],
      ['source', 'Edm.String'],
    ],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'UnpublishAIConfiguration',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aiconfiguration',
    params: [['version', 'Edm.String']],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'SchedulePrediction',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aimodel',
    params: [
      ['version', 'Edm.String'],
      ['predictImmediately', 'Edm.Boolean'],
      ['cleanupRequired', 'Edm.Boolean'],
    ],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'ScheduleRetrain',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aimodel',
    params: [
      ['recurrence', 'Edm.String'],
      ['version', 'Edm.String'],
    ],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'UnschedulePrediction',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aimodel',
    params: [
      ['version', 'Edm.String'],
      ['skipStatusUpdate', 'Edm.Boolean'],
    ],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'AddToFeedbackLoop',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_aimodel',
    params: [
      ['inputName', 'Edm.String'],
      ['source', 'Edm.String'],
      ['predictionOutput', 'Edm.String'],
      ['predictionInput', 'mscrm.crmbaseentity'],
    ],
    returns: null,
  },
  {
    name: 'Analyze',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_pminferredtask',
    params: [['version', 'Edm.String']],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'Ingest',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_pmrecording',
    params: [['version', 'Edm.String']],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'Share',
    kind: 'action',
    binding: 'entity',
    entity: 'msdyn_pminferredtask',
    params: [
      ['version', 'Edm.String'],
      ['sharingrequest', 'Edm.String'],
    ],
    response: [['sharingresponse', 'Edm.String']],
  },
  {
    name: 'AIClassify',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['Categories', 'Collection(Edm.String)'],
      ['Text', 'Edm.String'],
    ],
    response: [['Classification', 'Edm.String']],
  },
  {
    name: 'AIExtract',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['Entity', 'Edm.String'],
      ['Text', 'Edm.String'],
    ],
    response: [['ExtractedData', 'Collection(Edm.String)']],
  },
  {
    name: 'AIModelPublish',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['ModelId', 'Edm.Guid'],
      ['RunConfigurationId', 'Edm.Guid'],
      ['ModelName', 'Edm.String'],
      ['RunConfiguration', 'Edm.String'],
      ['TemplateId', 'Edm.Guid'],
      ['Source', 'Edm.String'],
      ['CustomConfiguration', 'Edm.String'],
    ],
    returns: 'mscrm.crmbaseentity',
  },
  {
    name: 'AIReply',
    kind: 'action',
    binding: 'unbound',
    params: [['Text', 'Edm.String']],
    response: [['PreparedResponse', 'Edm.String']],
  },
  {
    name: 'AISentiment',
    kind: 'action',
    binding: 'unbound',
    params: [['Text', 'Edm.String']],
    response: [['AnalyzedSentiment', 'Edm.String']],
  },
  {
    name: 'AISummarize',
    kind: 'action',
    binding: 'unbound',
    params: [['Text', 'Edm.String']],
    response: [['SummarizedText', 'Edm.String']],
  },
  {
    name: 'AISummarizeRecord',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['Id', 'Edm.String'],
      ['RecordContext', 'Edm.String'],
      ['EntityLogicalName', 'Edm.String'],
      ['IsMergedCatchupAndSummary', 'Edm.Boolean'],
    ],
    response: [
      ['SummarizedText', 'Edm.String'],
      ['AdditionalInformation', 'mscrm.crmbaseentity'],
    ],
  },
  {
    name: 'AITranslate',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['Text', 'Edm.String'],
      ['TargetLanguage', 'Edm.String'],
    ],
    response: [['TranslatedText', 'Edm.String']],
  },
  {
    name: 'SummarizeRecord',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['RecordContext', 'Edm.String'],
      ['Id', 'Edm.String'],
      ['EntityLogicalName', 'Edm.String'],
      ['IsMergedCatchupAndSummary', 'Edm.Boolean'],
    ],
    response: [
      ['AdditionalInformation', 'mscrm.crmbaseentity'],
      ['SummarizedText', 'Edm.String'],
    ],
  },
  {
    name: 'AnalyzeSentiment',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['text', 'Edm.String'],
      ['modelId', 'Edm.String'],
      ['language', 'Edm.String'],
    ],
    response: [
      ['sentiment', 'Edm.String'],
      ['documentScores', 'mscrm.crmbaseentity'],
      ['sentences', 'Collection(mscrm.crmbaseentity)'],
    ],
  },
  {
    name: 'CategorizeText',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['text', 'Edm.String'],
      ['modelId', 'Edm.String'],
      ['language', 'Edm.String'],
    ],
    response: [
      ['originalText', 'Edm.String'],
      ['categories', 'Collection(mscrm.crmbaseentity)'],
    ],
  },
  {
    name: 'DetectLanguage',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['text', 'Edm.String'],
      ['modelId', 'Edm.String'],
      ['countryHint', 'Edm.String'],
    ],
    response: [
      ['language', 'Edm.String'],
      ['score', 'Edm.Decimal'],
    ],
  },
  {
    name: 'ExtractKeyPhrases',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['text', 'Edm.String'],
      ['modelId', 'Edm.String'],
      ['language', 'Edm.String'],
    ],
    response: [
      ['phrases', 'Collection(mscrm.crmbaseentity)'],
      ['countOfPhrases', 'Edm.Decimal'],
    ],
  },
  {
    name: 'ExtractTextEntities',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['text', 'Edm.String'],
      ['modelId', 'Edm.String'],
      ['language', 'Edm.String'],
    ],
    response: [
      ['entities', 'Collection(mscrm.crmbaseentity)'],
      ['originalText', 'Edm.String'],
      ['textScore', 'Edm.Decimal'],
    ],
  },
  {
    name: 'RecognizeText',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['modelId', 'Edm.String'],
      ['base64encoded', 'Edm.String'],
      ['source', 'Edm.String'],
    ],
    response: [
      ['pages', 'Collection(mscrm.crmbaseentity)'],
      ['countOfPages', 'Edm.Decimal'],
    ],
  },
  {
    name: 'FormPredict',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['recordValues', 'Edm.String'],
      ['requestedFields', 'Collection(Edm.String)'],
      ['context', 'Edm.String'],
      ['clientPartnerSource', 'Edm.String'],
      ['predictorFields', 'Collection(Edm.String)'],
      ['entityName', 'Edm.String'],
    ],
    returns: 'mscrm.crmbaseentity',
  },
  {
    name: 'GeneratePowerFxFormula',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['ParameterValues', 'mscrm.crmbaseentity'],
      ['ConnectionReference', 'mscrm.crmbaseentity'],
      ['OperationId', 'Edm.String'],
    ],
    returns: 'Collection(mscrm.crmbaseentity)',
  },
  {
    name: 'InferEntityDefinition',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['FileInfo', 'Edm.String'],
      ['RecordId', 'Edm.Guid'],
      ['LanguageCode', 'Edm.Int32'],
      ['EntitiesCollection', 'Edm.String'],
      ['SolutionPrefix', 'Edm.String'],
      ['UserContext', 'Edm.String'],
      ['UseUserSettings', 'Edm.Boolean'],
      ['EntityDefinition', 'Edm.String'],
      ['PreviewData', 'Edm.String'],
      ['ParseSampleData', 'Edm.Boolean'],
      ['SourceTimeZone', 'Edm.String'],
    ],
    response: [
      ['UsingFallbackLogic', 'Edm.Boolean'],
      ['FileInfo', 'Edm.String'],
      ['EntityDefinition', 'Edm.String'],
      ['EntitiesCollection', 'Edm.String'],
      ['SampleData', 'Edm.String'],
    ],
  },
  {
    name: 'QueryDvUnstructuredData',
    kind: 'action',
    binding: 'unbound',
    params: [['userQueryText', 'Edm.String']],
    response: [['knowledgePluginResponse', 'Edm.String']],
  },
  {
    name: 'copilotquerytextcontext',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['top', 'Edm.Int32'],
      ['orderBy', 'Edm.String'],
      ['entityParameters', 'Edm.String'],
      ['searchType', 'Edm.String'],
      ['searchMode', 'Edm.String'],
      ['totalResultCount', 'Edm.Boolean'],
      ['skip', 'Edm.Int32'],
      ['options', 'Edm.String'],
      ['searchText', 'Edm.String'],
    ],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'ValidateAIConfiguration',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['version', 'Edm.String'],
      ['aiconfigurationId', 'Edm.String'],
    ],
    response: [['result', 'Edm.String']],
  },
  {
    name: 'GetJobStatus',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['istrain', 'Edm.Boolean'],
      ['correlationid', 'Edm.String'],
      ['aimodelid', 'Edm.String'],
    ],
    response: [['response', 'Edm.String']],
  },
  {
    name: 'DiscoverFabricAISkills',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['fabricEnvironment', 'Edm.String'],
      ['workspaceId', 'Edm.String'],
    ],
    response: [['fabricAISkills', 'Edm.String']],
  },
  {
    name: 'DiscoverFabricWorkspaces',
    kind: 'action',
    binding: 'unbound',
    params: [['fabricEnvironment', 'Edm.String']],
    response: [['fabricWorkspaces', 'Edm.String']],
  },
  {
    name: 'ExecuteWorkIQTask',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['actionId', 'Edm.String'],
      ['workspaceFilesBase64', 'Edm.String'],
      ['skillNames', 'Collection(Edm.String)'],
      ['configJson', 'Edm.String'],
      ['sessionId', 'Edm.String'],
      ['workspaceId', 'Edm.String'],
      ['actionDecision', 'Edm.String'],
      ['actionReason', 'Edm.String'],
      ['partnerSource', 'Edm.String'],
      ['instructions', 'Edm.String'],
    ],
    returns: 'mscrm.crmbaseentity',
  },
  {
    name: 'GetWorkIQTaskStatus',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['sessionId', 'Edm.String'],
      ['workspaceId', 'Edm.String'],
    ],
    returns: 'mscrm.crmbaseentity',
  },
  {
    name: 'McpExecuteWorkIQTask',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['workspaceFilesBase64', 'Edm.String'],
      ['workspaceId', 'Edm.String'],
      ['skillNames', 'Collection(Edm.String)'],
      ['actionReason', 'Edm.String'],
      ['sessionId', 'Edm.String'],
      ['configJson', 'Edm.String'],
      ['actionId', 'Edm.String'],
      ['actionDecision', 'Edm.String'],
      ['instructions', 'Edm.String'],
      ['partnerSource', 'Edm.String'],
    ],
    response: [['results', 'Edm.String']],
  },
  {
    name: 'McpGetWorkIQTaskStatus',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['workspaceId', 'Edm.String'],
      ['sessionId', 'Edm.String'],
    ],
    response: [['results', 'Edm.String']],
  },
  {
    name: 'McpCreateTable',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['displayname', 'Edm.String'],
      ['item', 'Edm.String'],
      ['tablename', 'Edm.String'],
      ['description', 'Edm.String'],
    ],
    response: [['successMessage', 'Edm.String']],
  },
  {
    name: 'McpUpdateTable',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['item', 'Edm.String'],
      ['tablename', 'Edm.String'],
      ['description', 'Edm.String'],
      ['newDisplayName', 'Edm.String'],
    ],
    response: [['successMessage', 'Edm.String']],
  },
  {
    name: 'RunDataProcessingModule',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['JobArguments', 'Collection(Edm.String)'],
      ['UpstreamResults', 'Collection(Edm.String)'],
      ['EndPoints', 'Collection(Edm.String)'],
      ['ScalarInputs', 'Collection(Edm.String)'],
      ['CallbackUri', 'Edm.String'],
      ['DataProcessingConfigurationId', 'Edm.String'],
    ],
    response: [
      ['HttpResponseStatus', 'Edm.Int32'],
      ['OutputEntities', 'Edm.String'],
    ],
  },
  {
    name: 'SetupAiConnection',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['connectionName', 'Edm.String'],
      ['connectorName', 'Edm.String'],
    ],
    returns: 'mscrm.crmbaseentity',
  },
  {
    name: 'QuestionAnalytics',
    kind: 'action',
    binding: 'unbound',
    params: [
      ['startDateTime', 'Edm.String'],
      ['endDateTime', 'Edm.String'],
      ['count', 'Edm.Int32'],
      ['state', 'Edm.String'],
      ['page', 'Edm.Int32'],
      ['botId', 'Edm.String'],
    ],
    response: [
      ['pagingCookie', 'Edm.String'],
      ['value', 'Edm.String'],
      ['moreRecords', 'Edm.Boolean'],
      ['page', 'Edm.Int32'],
    ],
  },
  {
    name: 'IsPaiEnabled',
    kind: 'action',
    binding: 'unbound',
    params: [],
    response: [
      ['ispaienabled', 'Edm.Boolean'],
      ['templates', 'Edm.String'],
      ['arePreviewScenarioEnabled', 'Edm.Boolean'],
      ['paigastatus', 'Edm.Boolean'],
      ['isdatamodelv2enabled', 'Edm.Boolean'],
    ],
  },
  { name: 'IsPmEnabled', kind: 'action', binding: 'unbound', params: [], response: [['response', 'Edm.String']] },
  { name: 'IsCDS3Ready', kind: 'function', binding: 'unbound', params: [], response: [['IsReady', 'Edm.Boolean']] },
  {
    name: 'copilottextdatastatus',
    kind: 'function',
    binding: 'unbound',
    params: [],
    response: [['response', 'Edm.String']],
  },
];

export function install(api) {
  for (const { params, response, returns, ...spec } of MESSAGES) {
    const signature = response ? { params, response } : { params, returns };
    const base = { ...spec, signature, fallback: aiUnavailable };
    if (INTERNAL.has(spec.name)) registerInternalMessage(api, base);
    else if (spec.name === 'AddToFeedbackLoop') registerAddon(api, { ...base, handle: feedbackLoop(api) });
    else if (PROBES[spec.name]) registerAddon(api, { ...base, handle: PROBES[spec.name] });
    else registerAddon(api, base);
  }
}

export const EXTENSION = { name: 'dataverse-addon-ai', install };
