# Widget table reference

Invented fixture in the layout of a Dataverse table reference page. No Microsoft content.

## Messages

|Name|Web API Operation |
|---|---|
|Create|POST fx_widgets|

## Properties

The following table lists selected properties for the Widget table.

|Property|Value|
| --- | --- |
| **DisplayName** | **Widget** |
| **DisplayCollectionName** | **Widgets** |
| **SchemaName** | `FxWidget` |
| **CollectionSchemaName** | `FxWidgets` |
| **EntitySetName** | `fx_widgets`|
| **LogicalName** | `fx_widget` |
| **LogicalCollectionName** | `fx_widgets` |
| **PrimaryIdAttribute** | `fx_widgetid` |
| **PrimaryNameAttribute** |`fx_name` |
| **TableType** | `Standard` |
| **OwnershipType** | `UserOwned` |

## Writable columns/attributes

### <a name="BKMK_FxWidgetId"></a> FxWidgetId

|Property|Value|
|---|---|
|Description|**Unique identifier of the widget.**|
|DisplayName|**Widget**|
|IsValidForForm|False|
|IsValidForRead|True|
|LogicalName|`fx_widgetid`|
|RequiredLevel|SystemRequired|
|Type|Uniqueidentifier|

### <a name="BKMK_FxName"></a> FxName

|Property|Value|
|---|---|
|Description|**Invented name column.**|
|DisplayName|**Name**|
|IsValidForForm|True|
|IsValidForRead|True|
|LogicalName|`fx_name`|
|RequiredLevel|ApplicationRequired|
|Type|String|
|Format|Text|
|FormatName|Text|
|MaxLength|100|
|ImeMode|Auto|
|IsLocalizable|False|

### <a name="BKMK_FxActive"></a> FxActive

|Property|Value|
|---|---|
|Description|**Invented boolean with a default.**|
|DisplayName|**Active flag**|
|IsValidForForm|True|
|IsValidForRead|True|
|LogicalName|`fx_active`|
|RequiredLevel|None|
|Type|Boolean|
|GlobalChoiceName|`fx_widget_fx_active`|
|DefaultValue|False|
|True Label|Yes|
|False Label|No|

### <a name="BKMK_FxCategory"></a> FxCategory

|Property|Value|
|---|---|
|Description|**Invented picklist that uses a shared option set.**|
|DisplayName|**Category**|
|IsValidForForm|True|
|IsValidForRead|True|
|LogicalName|`fx_category`|
|RequiredLevel|None|
|Type|Picklist|
|DefaultFormValue|1|
|GlobalChoiceName|`fx_sharedcategory`|

#### FxCategory Choices/Options

|Value|Label|
|---|---|
|1|**Basic**|
|2|**Premium**|

### <a name="BKMK_StateCode"></a> StateCode

|Property|Value|
|---|---|
|Description|**Invented state column.**|
|DisplayName|**Status**|
|IsValidForForm|False|
|IsValidForRead|True|
|LogicalName|`statecode`|
|RequiredLevel|SystemRequired|
|Type|State|
|DefaultFormValue|0|
|GlobalChoiceName|`fx_widget_statecode`|

#### StateCode Choices/Options

|Value|Details|
|---|---|
|0|Label: **Active**<br />DefaultStatus: 1<br />InvariantName: `Active`|
|1|Label: **Inactive**<br />DefaultStatus: 2<br />InvariantName: `Inactive`|

### <a name="BKMK_StatusCode"></a> StatusCode

|Property|Value|
|---|---|
|Description|**Invented status column.**|
|DisplayName|**Status Reason**|
|IsValidForForm|False|
|IsValidForRead|True|
|LogicalName|`statuscode`|
|RequiredLevel|None|
|Type|Status|
|DefaultFormValue|-1|
|GlobalChoiceName|`fx_widget_statuscode`|

#### StatusCode Choices/Options

|Value|Details|
|---|---|
|1|Label: **Open**<br />State:0<br />TransitionData: null|
|2|Label: **Closed**<br />State:1<br />TransitionData: null|

### <a name="BKMK_FxParentId"></a> FxParentId

|Property|Value|
|---|---|
|Description|**Invented lookup to the same table.**|
|DisplayName|**Parent Widget**|
|IsValidForForm|True|
|IsValidForRead|True|
|LogicalName|`fx_parentid`|
|RequiredLevel|None|
|Type|Lookup|
|Targets|fx_widget|

### <a name="BKMK_FxLegacyFlag"></a> FxLegacyFlag

|Property|Value|
|---|---|
|Description|**Invented column with an excluded prefix.**|
|DisplayName|**Legacy**|
|IsValidForForm|True|
|IsValidForRead|True|
|LogicalName|`adx_legacyflag`|
|RequiredLevel|None|
|Type|String|
|MaxLength|50|

## Read-only columns/attributes

### <a name="BKMK_FxCreatedCalc"></a> FxCreatedCalc

|Property|Value|
|---|---|
|Description|**Invented read-only column.**|
|DisplayName|**Calculated Code**|
|IsValidForForm|False|
|IsValidForRead|True|
|LogicalName|`fx_createdcalc`|
|RequiredLevel|None|
|Type|String|
|Format|Text|
|FormatName|Text|
|MaxLength|20|
|ImeMode|Disabled|
|IsLocalizable|False|

## Many-to-One relationships

These relationships are many-to-one. Listed by **SchemaName**.

- [fx_widget_parent](#BKMK_fx_widget_parent-many-to-one)

### <a name="BKMK_fx_widget_parent-many-to-one"></a> fx_widget_parent

One-To-Many Relationship: [fx_widget fx_widget_parent](#BKMK_fx_widget_parent-one-to-many)

|Property|Value|
|---|---|
|ReferencedEntity|`fx_widget`|
|ReferencedAttribute|`fx_widgetid`|
|ReferencingAttribute|`fx_parentid`|
|ReferencingEntityNavigationPropertyName|`fx_parentid`|
|IsHierarchical||
|CascadeConfiguration|Archive: `NoCascade`<br />Assign: `Cascade`<br />Delete: `RemoveLink`<br />Merge: `NoCascade`<br />Reparent: `Cascade`<br />RollupView: `NoCascade`<br />Share: `NoCascade`<br />Unshare: `NoCascade`|

## One-to-Many relationships

These relationships are one-to-many. Listed by **SchemaName**.

- [fx_part_widget](#BKMK_fx_part_widget)
- [fx_widget_parent](#BKMK_fx_widget_parent-one-to-many)

### <a name="BKMK_fx_part_widget"></a> fx_part_widget

One-To-Many Relationship: [fx_part fx_part_widget](fx_part.md#BKMK_fx_part_widget)

|Property|Value|
|---|---|
|ReferencingEntity|`fx_part`|
|ReferencingAttribute|`fx_widgetid`|
|ReferencedEntityNavigationPropertyName|`fx_parts`|

### <a name="BKMK_fx_widget_parent-one-to-many"></a> fx_widget_parent

One-To-Many Relationship: [fx_widget fx_widget_parent](#BKMK_fx_widget_parent-many-to-one)

|Property|Value|
|---|---|
|ReferencingEntity|`fx_widget`|
|ReferencingAttribute|`fx_parentid`|
|ReferencedEntityNavigationPropertyName|`fx_children`|
