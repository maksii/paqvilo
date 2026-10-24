// Standard Dataverse metadata entity contracts for the implemented read routes.
// Declaration is separate from CRUD capability; only existing metadata read routes are advertised.
export const METADATA_ENTITY_SETS = Object.freeze([
  'EntityDefinitions',
  'GlobalOptionSetDefinitions',
  'RelationshipDefinitions',
]);
export const METADATA_ENTITY_TYPE_CSDL = `<EntityType Name="AttributeMetadata" BaseType="mscrm.MetadataBase">
  <Property Name="AttributeOf" Type="Edm.String" Unicode="false" />
  <Property Name="AttributeType" Type="mscrm.AttributeTypeCode" />
  <Property Name="AttributeTypeName" Type="mscrm.AttributeTypeDisplayName" />
  <Property Name="ColumnNumber" Type="Edm.Int32" />
  <Property Name="Description" Type="mscrm.Label" />
  <Property Name="DisplayName" Type="mscrm.Label" />
  <Property Name="DeprecatedVersion" Type="Edm.String" Unicode="false" />
  <Property Name="IntroducedVersion" Type="Edm.String" Unicode="false" />
  <Property Name="EntityLogicalName" Type="Edm.String" Unicode="false" />
  <Property Name="IsAuditEnabled" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsCustomAttribute" Type="Edm.Boolean" />
  <Property Name="IsPrimaryId" Type="Edm.Boolean" />
  <Property Name="IsValidODataAttribute" Type="Edm.Boolean" Nullable="false" />
  <Property Name="IsPrimaryName" Type="Edm.Boolean" />
  <Property Name="IsValidForCreate" Type="Edm.Boolean" />
  <Property Name="IsValidForRead" Type="Edm.Boolean" />
  <Property Name="IsValidForUpdate" Type="Edm.Boolean" />
  <Property Name="CanBeSecuredForRead" Type="Edm.Boolean" />
  <Property Name="CanBeSecuredForCreate" Type="Edm.Boolean" />
  <Property Name="CanBeSecuredForUpdate" Type="Edm.Boolean" />
  <Property Name="IsSecured" Type="Edm.Boolean" />
  <Property Name="IsRetrievable" Type="Edm.Boolean" />
  <Property Name="IsFilterable" Type="Edm.Boolean" />
  <Property Name="IsSearchable" Type="Edm.Boolean" />
  <Property Name="IsManaged" Type="Edm.Boolean" />
  <Property Name="IsGlobalFilterEnabled" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsSortableEnabled" Type="mscrm.BooleanManagedProperty" />
  <Property Name="LinkedAttributeId" Type="Edm.Guid" />
  <Property Name="LogicalName" Type="Edm.String" Unicode="false" />
  <Property Name="IsCustomizable" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsRenameable" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsValidForAdvancedFind" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsValidForForm" Type="Edm.Boolean" />
  <Property Name="IsRequiredForForm" Type="Edm.Boolean" />
  <Property Name="IsValidForGrid" Type="Edm.Boolean" />
  <Property Name="RequiredLevel" Type="mscrm.AttributeRequiredLevelManagedProperty" />
  <Property Name="CanModifyAdditionalSettings" Type="mscrm.BooleanManagedProperty" />
  <Property Name="SchemaName" Type="Edm.String" Unicode="false" />
  <Property Name="ExternalName" Type="Edm.String" Unicode="false" />
  <Property Name="IsLogical" Type="Edm.Boolean" />
  <Property Name="IsDataSourceSecret" Type="Edm.Boolean" />
  <Property Name="InheritsFrom" Type="Edm.String" Unicode="false" />
  <Property Name="CreatedOn" Type="Edm.DateTimeOffset" />
  <Property Name="ModifiedOn" Type="Edm.DateTimeOffset" />
  <Property Name="SourceType" Type="Edm.Int32" />
  <Property Name="AutoNumberFormat" Type="Edm.String" Unicode="false" />
  <Property Name="Settings" Type="Collection(mscrm.EntitySetting)" />
</EntityType>
<EntityType Name="BigIntAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="MaxValue" Type="Edm.Int64" />
  <Property Name="MinValue" Type="Edm.Int64" />
</EntityType>
<EntityType Name="BooleanAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="DefaultValue" Type="Edm.Boolean" />
  <Property Name="FormulaDefinition" Type="Edm.String" Unicode="false" />
  <Property Name="SourceTypeMask" Type="Edm.Int32" />
  <NavigationProperty Name="OptionSet" Type="mscrm.BooleanOptionSetMetadata" Nullable="false" ContainsTarget="true" />
  <NavigationProperty Name="GlobalOptionSet" Type="mscrm.BooleanOptionSetMetadata" Nullable="false" />
</EntityType>
<EntityType Name="BooleanOptionSetMetadata" BaseType="mscrm.OptionSetMetadataBase">
  <Property Name="TrueOption" Type="mscrm.OptionMetadata" />
  <Property Name="FalseOption" Type="mscrm.OptionMetadata" />
</EntityType>
<EntityType Name="DateTimeAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="MinSupportedValue" Type="Edm.DateTimeOffset" Nullable="false" />
  <Property Name="MaxSupportedValue" Type="Edm.DateTimeOffset" Nullable="false" />
  <Property Name="Format" Type="mscrm.DateTimeFormat" />
  <Property Name="ImeMode" Type="mscrm.ImeMode" />
  <Property Name="SourceTypeMask" Type="Edm.Int32" />
  <Property Name="FormulaDefinition" Type="Edm.String" Unicode="false" />
  <Property Name="DateTimeBehavior" Type="mscrm.DateTimeBehavior" />
  <Property Name="CanChangeDateTimeBehavior" Type="mscrm.BooleanManagedProperty" />
</EntityType>
<EntityType Name="DecimalAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="MaxValue" Type="Edm.Decimal" Scale="Variable" />
  <Property Name="MinValue" Type="Edm.Decimal" Scale="Variable" />
  <Property Name="Precision" Type="Edm.Int32" />
  <Property Name="ImeMode" Type="mscrm.ImeMode" />
  <Property Name="FormulaDefinition" Type="Edm.String" Unicode="false" />
  <Property Name="SourceTypeMask" Type="Edm.Int32" />
</EntityType>
<EntityType Name="DoubleAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="ImeMode" Type="mscrm.ImeMode" />
  <Property Name="MaxValue" Type="Edm.Double" />
  <Property Name="MinValue" Type="Edm.Double" />
  <Property Name="Precision" Type="Edm.Int32" />
  <Property Name="FormulaDefinition" Type="Edm.String" Unicode="false" />
  <Property Name="SourceTypeMask" Type="Edm.Int32" />
</EntityType>
<EntityType Name="EntityKeyMetadata" BaseType="mscrm.MetadataBase">
  <Property Name="DisplayName" Type="mscrm.Label" />
  <Property Name="LogicalName" Type="Edm.String" Unicode="false" />
  <Property Name="SchemaName" Type="Edm.String" Unicode="false" />
  <Property Name="EntityLogicalName" Type="Edm.String" Unicode="false" />
  <Property Name="KeyAttributes" Type="Collection(Edm.String)" Unicode="false" />
  <Property Name="IsCustomizable" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsManaged" Type="Edm.Boolean" />
  <Property Name="IntroducedVersion" Type="Edm.String" Unicode="false" />
  <Property Name="EntityKeyIndexStatus" Type="mscrm.EntityKeyIndexStatus" Nullable="false" />
  <Property Name="AsyncJob" Type="Edm.Guid" Nullable="false" />
  <Property Name="IsSynchronous" Type="Edm.Boolean" />
  <Property Name="IsExportKey" Type="Edm.Boolean" />
  <Property Name="IsSecondaryKey" Type="Edm.Boolean" />
</EntityType>
<EntityType Name="EntityMetadata" BaseType="mscrm.MetadataBase">
  <Property Name="ActivityTypeMask" Type="Edm.Int32" />
  <Property Name="AutoRouteToOwnerQueue" Type="Edm.Boolean" />
  <Property Name="CanTriggerWorkflow" Type="Edm.Boolean" />
  <Property Name="Description" Type="mscrm.Label" />
  <Property Name="DisplayCollectionName" Type="mscrm.Label" />
  <Property Name="DisplayName" Type="mscrm.Label" />
  <Property Name="EntityHelpUrlEnabled" Type="Edm.Boolean" />
  <Property Name="EntityHelpUrl" Type="Edm.String" Unicode="false" />
  <Property Name="IsDocumentManagementEnabled" Type="Edm.Boolean" />
  <Property Name="IsOneNoteIntegrationEnabled" Type="Edm.Boolean" />
  <Property Name="IsInteractionCentricEnabled" Type="Edm.Boolean" />
  <Property Name="IsKnowledgeManagementEnabled" Type="Edm.Boolean" />
  <Property Name="IsSLAEnabled" Type="Edm.Boolean" />
  <Property Name="IsBPFEntity" Type="Edm.Boolean" />
  <Property Name="IsDocumentRecommendationsEnabled" Type="Edm.Boolean" />
  <Property Name="IsMSTeamsIntegrationEnabled" Type="Edm.Boolean" />
  <Property Name="SettingOf" Type="Edm.String" Unicode="false" />
  <Property Name="DataProviderId" Type="Edm.Guid" />
  <Property Name="DataSourceId" Type="Edm.Guid" />
  <Property Name="AutoCreateAccessTeams" Type="Edm.Boolean" />
  <Property Name="IsActivity" Type="Edm.Boolean" />
  <Property Name="IsActivityParty" Type="Edm.Boolean" />
  <Property Name="IsAuditEnabled" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsRetrieveAuditEnabled" Type="Edm.Boolean" />
  <Property Name="IsRetrieveMultipleAuditEnabled" Type="Edm.Boolean" />
  <Property Name="IsArchivalEnabled" Type="Edm.Boolean" />
  <Property Name="IsRetentionEnabled" Type="Edm.Boolean" />
  <Property Name="ClusterMode" Type="mscrm.EntityClusterMode" />
  <Property Name="CanChangeClusterMode" Type="Edm.Boolean" />
  <Property Name="AutoReplicateClusterRecords" Type="Edm.Boolean" />
  <Property Name="DefaultToLocalPartition" Type="Edm.Boolean" />
  <Property Name="IsAvailableOffline" Type="Edm.Boolean" />
  <Property Name="IsChildEntity" Type="Edm.Boolean" />
  <Property Name="IsAIRUpdated" Type="Edm.Boolean" />
  <Property Name="IsValidForQueue" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsConnectionsEnabled" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IconLargeName" Type="Edm.String" Unicode="false" />
  <Property Name="IconMediumName" Type="Edm.String" Unicode="false" />
  <Property Name="IconSmallName" Type="Edm.String" Unicode="false" />
  <Property Name="IconVectorName" Type="Edm.String" Unicode="false" />
  <Property Name="IsCustomEntity" Type="Edm.Boolean" />
  <Property Name="IsBusinessProcessEnabled" Type="Edm.Boolean" />
  <Property Name="IsCustomizable" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsRenameable" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsMappable" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsDuplicateDetectionEnabled" Type="mscrm.BooleanManagedProperty" />
  <Property Name="CanCreateAttributes" Type="mscrm.BooleanManagedProperty" />
  <Property Name="CanCreateForms" Type="mscrm.BooleanManagedProperty" />
  <Property Name="CanCreateViews" Type="mscrm.BooleanManagedProperty" />
  <Property Name="CanCreateCharts" Type="mscrm.BooleanManagedProperty" />
  <Property Name="CanBeRelatedEntityInRelationship" Type="mscrm.BooleanManagedProperty" />
  <Property Name="CanBePrimaryEntityInRelationship" Type="mscrm.BooleanManagedProperty" />
  <Property Name="CanBeInManyToMany" Type="mscrm.BooleanManagedProperty" />
  <Property Name="CanBeInCustomEntityAssociation" Type="mscrm.BooleanManagedProperty" />
  <Property Name="CanEnableSyncToExternalSearchIndex" Type="mscrm.BooleanManagedProperty" />
  <Property Name="SyncToExternalSearchIndex" Type="Edm.Boolean" />
  <Property Name="CanModifyAdditionalSettings" Type="mscrm.BooleanManagedProperty" />
  <Property Name="CanChangeHierarchicalRelationship" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsOptimisticConcurrencyEnabled" Type="Edm.Boolean" />
  <Property Name="ChangeTrackingEnabled" Type="Edm.Boolean" />
  <Property Name="CanChangeTrackingBeEnabled" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsImportable" Type="Edm.Boolean" />
  <Property Name="IsIntersect" Type="Edm.Boolean" />
  <Property Name="IsMailMergeEnabled" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsManaged" Type="Edm.Boolean" />
  <Property Name="IsEnabledForCharts" Type="Edm.Boolean" />
  <Property Name="IsEnabledForTrace" Type="Edm.Boolean" />
  <Property Name="IsValidForAdvancedFind" Type="Edm.Boolean" />
  <Property Name="IsVisibleInMobile" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsVisibleInMobileClient" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsReadOnlyInMobileClient" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsOfflineInMobileClient" Type="mscrm.BooleanManagedProperty" />
  <Property Name="DaysSinceRecordLastModified" Type="Edm.Int32" />
  <Property Name="MobileOfflineFilters" Type="Edm.String" Unicode="false" />
  <Property Name="IsReadingPaneEnabled" Type="Edm.Boolean" />
  <Property Name="IsQuickCreateEnabled" Type="Edm.Boolean" />
  <Property Name="LogicalName" Type="Edm.String" Unicode="false" />
  <Property Name="ObjectTypeCode" Type="Edm.Int32" />
  <Property Name="OwnershipType" Type="mscrm.OwnershipTypes" />
  <Property Name="PrimaryNameAttribute" Type="Edm.String" Unicode="false" />
  <Property Name="PrimaryImageAttribute" Type="Edm.String" Unicode="false" />
  <Property Name="PrimaryIdAttribute" Type="Edm.String" Unicode="false" />
  <Property Name="Privileges" Type="Collection(mscrm.SecurityPrivilegeMetadata)" />
  <Property Name="RecurrenceBaseEntityLogicalName" Type="Edm.String" Unicode="false" />
  <Property Name="ReportViewName" Type="Edm.String" Unicode="false" />
  <Property Name="SchemaName" Type="Edm.String" Unicode="false" />
  <Property Name="IntroducedVersion" Type="Edm.String" Unicode="false" />
  <Property Name="IsStateModelAware" Type="Edm.Boolean" />
  <Property Name="EnforceStateTransitions" Type="Edm.Boolean" />
  <Property Name="ExternalName" Type="Edm.String" Unicode="false" />
  <Property Name="EntityColor" Type="Edm.String" Unicode="false" />
  <Property Name="PrimaryKey" Type="Collection(Edm.String)" Unicode="false" />
  <Property Name="LogicalCollectionName" Type="Edm.String" Unicode="false" />
  <Property Name="ExternalCollectionName" Type="Edm.String" Unicode="false" />
  <Property Name="CollectionSchemaName" Type="Edm.String" Unicode="false" />
  <Property Name="EntitySetName" Type="Edm.String" Unicode="false" />
  <Property Name="IsEnabledForExternalChannels" Type="Edm.Boolean" />
  <Property Name="IsPrivate" Type="Edm.Boolean" />
  <Property Name="UsesBusinessDataLabelTable" Type="Edm.Boolean" />
  <Property Name="IsLogicalEntity" Type="Edm.Boolean" />
  <Property Name="HasNotes" Type="Edm.Boolean" />
  <Property Name="HasActivities" Type="Edm.Boolean" />
  <Property Name="HasFeedback" Type="Edm.Boolean" />
  <Property Name="IsSolutionAware" Type="Edm.Boolean" />
  <Property Name="Settings" Type="Collection(mscrm.EntitySetting)" />
  <Property Name="CreatedOn" Type="Edm.DateTimeOffset" />
  <Property Name="ModifiedOn" Type="Edm.DateTimeOffset" />
  <Property Name="HasEmailAddresses" Type="Edm.Boolean" />
  <Property Name="OwnerId" Type="Edm.Guid" />
  <Property Name="OwnerIdType" Type="Edm.Int32" />
  <Property Name="OwningBusinessUnit" Type="Edm.Guid" />
  <Property Name="TableType" Type="Edm.String" Unicode="false" />
  <NavigationProperty Name="Attributes" Type="Collection(mscrm.AttributeMetadata)" ContainsTarget="true" />
  <NavigationProperty Name="ManyToManyRelationships" Type="Collection(mscrm.ManyToManyRelationshipMetadata)" />
  <NavigationProperty Name="ManyToOneRelationships" Type="Collection(mscrm.OneToManyRelationshipMetadata)" />
  <NavigationProperty Name="OneToManyRelationships" Type="Collection(mscrm.OneToManyRelationshipMetadata)" />
  <NavigationProperty Name="Keys" Type="Collection(mscrm.EntityKeyMetadata)" ContainsTarget="true" />
</EntityType>
<EntityType Name="EntityNameAttributeMetadata" BaseType="mscrm.EnumAttributeMetadata">
  <Property Name="IsEntityReferenceStored" Type="Edm.Boolean" Nullable="false" />
</EntityType>
<EntityType Name="EnumAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="DefaultFormValue" Type="Edm.Int32" />
  <NavigationProperty Name="OptionSet" Type="mscrm.OptionSetMetadata" Nullable="false" ContainsTarget="true" />
  <NavigationProperty Name="GlobalOptionSet" Type="mscrm.OptionSetMetadata" Nullable="false" />
</EntityType>
<EntityType Name="FileAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="MaxSizeInKB" Type="Edm.Int32" />
</EntityType>
<EntityType Name="ImageAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="IsPrimaryImage" Type="Edm.Boolean" />
  <Property Name="MaxHeight" Type="Edm.Int16" />
  <Property Name="MaxWidth" Type="Edm.Int16" />
  <Property Name="MaxSizeInKB" Type="Edm.Int32" />
  <Property Name="CanStoreFullImage" Type="Edm.Boolean" />
</EntityType>
<EntityType Name="IntegerAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="Format" Type="mscrm.IntegerFormat" />
  <Property Name="MaxValue" Type="Edm.Int32" />
  <Property Name="MinValue" Type="Edm.Int32" />
  <Property Name="FormulaDefinition" Type="Edm.String" Unicode="false" />
  <Property Name="SourceTypeMask" Type="Edm.Int32" />
</EntityType>
<EntityType Name="LookupAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="Targets" Type="Collection(Edm.String)" Unicode="false" />
  <Property Name="Format" Type="mscrm.LookupFormat" />
</EntityType>
<EntityType Name="ManagedPropertyAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="ManagedPropertyLogicalName" Type="Edm.String" Unicode="false" />
  <Property Name="ParentComponentType" Type="Edm.Int32" />
  <Property Name="ParentAttributeName" Type="Edm.String" Unicode="false" />
  <Property Name="ValueAttributeTypeCode" Type="mscrm.AttributeTypeCode" Nullable="false" />
</EntityType>
<EntityType Name="ManyToManyRelationshipMetadata" BaseType="mscrm.RelationshipMetadataBase">
  <Property Name="Entity1AssociatedMenuConfiguration" Type="mscrm.AssociatedMenuConfiguration" />
  <Property Name="Entity2AssociatedMenuConfiguration" Type="mscrm.AssociatedMenuConfiguration" />
  <Property Name="Entity1LogicalName" Type="Edm.String" Unicode="false" />
  <Property Name="Entity2LogicalName" Type="Edm.String" Unicode="false" />
  <Property Name="IntersectEntityName" Type="Edm.String" Unicode="false" />
  <Property Name="Entity1IntersectAttribute" Type="Edm.String" Unicode="false" />
  <Property Name="Entity2IntersectAttribute" Type="Edm.String" Unicode="false" />
  <Property Name="Entity1NavigationPropertyName" Type="Edm.String" Unicode="false" />
  <Property Name="Entity2NavigationPropertyName" Type="Edm.String" Unicode="false" />
</EntityType>
<EntityType Name="MemoAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="Format" Type="mscrm.StringFormat" />
  <Property Name="FormatName" Type="mscrm.MemoFormatName" />
  <Property Name="ImeMode" Type="mscrm.ImeMode" />
  <Property Name="MaxLength" Type="Edm.Int32" />
  <Property Name="IsLocalizable" Type="Edm.Boolean" />
</EntityType>
<EntityType Name="MetadataBase" BaseType="mscrm.crmmodelbaseentity" Abstract="true">
  <Key>
    <PropertyRef Name="MetadataId" />
  </Key>
  <Property Name="MetadataId" Type="Edm.Guid" Nullable="false" />
  <Property Name="HasChanged" Type="Edm.Boolean" />
</EntityType>
<EntityType Name="MoneyAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="ImeMode" Type="mscrm.ImeMode" />
  <Property Name="MaxValue" Type="Edm.Double" />
  <Property Name="MinValue" Type="Edm.Double" />
  <Property Name="Precision" Type="Edm.Int32" />
  <Property Name="PrecisionSource" Type="Edm.Int32" />
  <Property Name="CalculationOf" Type="Edm.String" Unicode="false" />
  <Property Name="FormulaDefinition" Type="Edm.String" Unicode="false" />
  <Property Name="SourceTypeMask" Type="Edm.Int32" />
  <Property Name="IsBaseCurrency" Type="Edm.Boolean" />
</EntityType>
<EntityType Name="MultiSelectPicklistAttributeMetadata" BaseType="mscrm.EnumAttributeMetadata">
  <Property Name="FormulaDefinition" Type="Edm.String" Unicode="false" />
  <Property Name="SourceTypeMask" Type="Edm.Int32" />
  <Property Name="ParentPicklistLogicalName" Type="Edm.String" Unicode="false" />
  <Property Name="ChildPicklistLogicalNames" Type="Collection(Edm.String)" Unicode="false" />
</EntityType>
<EntityType Name="OneToManyRelationshipMetadata" BaseType="mscrm.RelationshipMetadataBase">
  <Property Name="AssociatedMenuConfiguration" Type="mscrm.AssociatedMenuConfiguration" />
  <Property Name="CascadeConfiguration" Type="mscrm.CascadeConfiguration" />
  <Property Name="ReferencedAttribute" Type="Edm.String" Unicode="false" />
  <Property Name="ReferencedEntity" Type="Edm.String" Unicode="false" />
  <Property Name="ReferencingAttribute" Type="Edm.String" Unicode="false" />
  <Property Name="ReferencingEntity" Type="Edm.String" Unicode="false" />
  <Property Name="IsHierarchical" Type="Edm.Boolean" />
  <Property Name="EntityKey" Type="Edm.String" Unicode="false" />
  <Property Name="RelationshipAttributes" Type="Collection(mscrm.RelationshipAttribute)" />
  <Property Name="IsRelationshipAttributeDenormalized" Type="Edm.Boolean" />
  <Property Name="ReferencedEntityNavigationPropertyName" Type="Edm.String" Unicode="false" />
  <Property Name="ReferencingEntityNavigationPropertyName" Type="Edm.String" Unicode="false" />
  <Property Name="RelationshipBehavior" Type="Edm.Int32" />
  <Property Name="IsDenormalizedLookup" Type="Edm.Boolean" />
  <Property Name="DenormalizedAttributeName" Type="Edm.String" Unicode="false" />
  <NavigationProperty Name="Lookup" Type="mscrm.LookupAttributeMetadata" Nullable="false" ContainsTarget="true" />
</EntityType>
<EntityType Name="OptionSetMetadata" BaseType="mscrm.OptionSetMetadataBase">
  <Property Name="Options" Type="Collection(mscrm.OptionMetadata)" />
  <Property Name="ParentOptionSetName" Type="Edm.String" Unicode="false" />
</EntityType>
<EntityType Name="OptionSetMetadataBase" BaseType="mscrm.MetadataBase">
  <Property Name="Description" Type="mscrm.Label" />
  <Property Name="DisplayName" Type="mscrm.Label" />
  <Property Name="IsCustomOptionSet" Type="Edm.Boolean" />
  <Property Name="IsGlobal" Type="Edm.Boolean" />
  <Property Name="IsManaged" Type="Edm.Boolean" />
  <Property Name="IsCustomizable" Type="mscrm.BooleanManagedProperty" />
  <Property Name="Name" Type="Edm.String" Unicode="false" />
  <Property Name="ExternalTypeName" Type="Edm.String" Unicode="false" />
  <Property Name="OptionSetType" Type="mscrm.OptionSetType" />
  <Property Name="IntroducedVersion" Type="Edm.String" Unicode="false" />
</EntityType>
<EntityType Name="PicklistAttributeMetadata" BaseType="mscrm.EnumAttributeMetadata">
  <Property Name="FormulaDefinition" Type="Edm.String" Unicode="false" />
  <Property Name="SourceTypeMask" Type="Edm.Int32" />
  <Property Name="ParentPicklistLogicalName" Type="Edm.String" Unicode="false" />
  <Property Name="ChildPicklistLogicalNames" Type="Collection(Edm.String)" Unicode="false" />
</EntityType>
<EntityType Name="RelationshipMetadataBase" BaseType="mscrm.MetadataBase" Abstract="true">
  <Property Name="IsCustomRelationship" Type="Edm.Boolean" />
  <Property Name="IsCustomizable" Type="mscrm.BooleanManagedProperty" />
  <Property Name="IsValidForAdvancedFind" Type="Edm.Boolean" />
  <Property Name="SchemaName" Type="Edm.String" Unicode="false" />
  <Property Name="SecurityTypes" Type="mscrm.SecurityTypes" />
  <Property Name="IsManaged" Type="Edm.Boolean" />
  <Property Name="RelationshipType" Type="mscrm.RelationshipType" Nullable="false" />
  <Property Name="IntroducedVersion" Type="Edm.String" Unicode="false" />
</EntityType>
<EntityType Name="StateAttributeMetadata" BaseType="mscrm.EnumAttributeMetadata" />
<EntityType Name="StatusAttributeMetadata" BaseType="mscrm.EnumAttributeMetadata" />
<EntityType Name="StringAttributeMetadata" BaseType="mscrm.AttributeMetadata">
  <Property Name="Format" Type="mscrm.StringFormat" />
  <Property Name="FormatName" Type="mscrm.StringFormatName" />
  <Property Name="ImeMode" Type="mscrm.ImeMode" />
  <Property Name="MaxLength" Type="Edm.Int32" />
  <Property Name="YomiOf" Type="Edm.String" Unicode="false" />
  <Property Name="IsLocalizable" Type="Edm.Boolean" />
  <Property Name="DatabaseLength" Type="Edm.Int32" />
  <Property Name="FormulaDefinition" Type="Edm.String" Unicode="false" />
  <Property Name="SourceTypeMask" Type="Edm.Int32" />
</EntityType>
<EntityType Name="UniqueIdentifierAttributeMetadata" BaseType="mscrm.AttributeMetadata" />
<ComplexType Name="DateTimeBehavior">
  <Property Name="Value" Type="Edm.String" Unicode="false" />
</ComplexType>
<EnumType Name="DateTimeFormat">
  <Member Name="DateOnly" Value="0" />
  <Member Name="DateAndTime" Value="1" />
</EnumType>
<EnumType Name="ImeMode">
  <Member Name="Auto" Value="0" />
  <Member Name="Inactive" Value="1" />
  <Member Name="Active" Value="2" />
  <Member Name="Disabled" Value="3" />
</EnumType>
<EnumType Name="IntegerFormat">
  <Member Name="None" Value="0" />
  <Member Name="Duration" Value="1" />
  <Member Name="TimeZone" Value="2" />
  <Member Name="Language" Value="3" />
  <Member Name="Locale" Value="4" />
</EnumType>
<ComplexType Name="MemoFormatName">
  <Property Name="Value" Type="Edm.String" Unicode="false" />
</ComplexType>
<ComplexType Name="OptionMetadata">
  <Property Name="Value" Type="Edm.Int32" />
  <Property Name="Label" Type="mscrm.Label" />
  <Property Name="Description" Type="mscrm.Label" />
  <Property Name="Color" Type="Edm.String" Unicode="false" />
  <Property Name="IsManaged" Type="Edm.Boolean" />
  <Property Name="ExternalValue" Type="Edm.String" Unicode="false" />
  <Property Name="ParentValues" Type="Collection(Edm.Int32)" />
  <Property Name="Tag" Type="Edm.String" Unicode="false" />
  <Property Name="IsHidden" Type="Edm.Boolean" />
  <Property Name="MetadataId" Type="Edm.Guid" />
  <Property Name="HasChanged" Type="Edm.Boolean" />
</ComplexType>
<EnumType Name="OptionSetType">
  <Member Name="Picklist" Value="0" />
  <Member Name="State" Value="1" />
  <Member Name="Status" Value="2" />
  <Member Name="Boolean" Value="3" />
</EnumType>
<EnumType Name="StringFormat">
  <Member Name="Email" Value="0" />
  <Member Name="Text" Value="1" />
  <Member Name="TextArea" Value="2" />
  <Member Name="Url" Value="3" />
  <Member Name="TickerSymbol" Value="4" />
  <Member Name="PhoneticGuide" Value="5" />
  <Member Name="VersionNumber" Value="6" />
  <Member Name="Phone" Value="7" />
  <Member Name="Json" Value="8" />
  <Member Name="RichText" Value="9" />
</EnumType>
<ComplexType Name="StringFormatName">
  <Property Name="Value" Type="Edm.String" Unicode="false" />
</ComplexType>`;
export const METADATA_ENTITY_SET_CSDL = `<EntitySet Name="EntityDefinitions" EntityType="Microsoft.Dynamics.CRM.EntityMetadata">
  <NavigationPropertyBinding Path="ManyToManyRelationships" Target="RelationshipDefinitions" />
  <NavigationPropertyBinding Path="ManyToOneRelationships" Target="RelationshipDefinitions" />
  <NavigationPropertyBinding Path="Attributes/Microsoft.Dynamics.CRM.BooleanAttributeMetadata/GlobalOptionSet" Target="GlobalOptionSetDefinitions" />
  <NavigationPropertyBinding Path="Attributes/Microsoft.Dynamics.CRM.EnumAttributeMetadata/GlobalOptionSet" Target="GlobalOptionSetDefinitions" />
  <NavigationPropertyBinding Path="OneToManyRelationships" Target="RelationshipDefinitions" />
</EntitySet>
<EntitySet Name="GlobalOptionSetDefinitions" EntityType="Microsoft.Dynamics.CRM.OptionSetMetadataBase" />
<EntitySet Name="RelationshipDefinitions" EntityType="Microsoft.Dynamics.CRM.RelationshipMetadataBase" />`;
