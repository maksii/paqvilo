import { stringify } from 'yaml';

const control = (name, type, properties, children = []) => ({
  [name]: { Control: type, Properties: properties, ...(children.length ? { Children: children } : {}) },
});

// Invented source with the same bounded input/reset/navigation operations as the private native draft probe.
export const canvasDraftInputFiles = {
  'Src/App.pa.yaml': stringify({ App: { Properties: { StartScreen: '=Home' } }, DataSources: { Drafts: { Type: 'Table', Parameters: { TableLogicalName: 'fx_draft' } } } }),
  'Src/Home.pa.yaml': stringify({ Screens: { Home: { Properties: { OnVisible: '=Set(draftMode, FormMode.Edit)' }, Children: [
    control('OpenDraft', 'Classic/Button@2.2.0', { Text: '="Open draft"', OnSelect: '=Set(selectedDraft, Blank()); Set(draftMode, FormMode.New); ResetForm(DraftForm); Navigate(Draft)' }),
  ] } } }),
  'Src/Draft.pa.yaml': stringify({ Screens: { Draft: { Properties: { OnVisible: '=ResetForm(DraftForm)' }, Children: [
    control('DraftForm', 'Form@2.4.4', { DefaultMode: '=draftMode', DataSource: '=Drafts' }, [
      control('SingleCard', 'TypedDataCard@1.0.7', { DataField: '="fx_name"', Default: '=ThisItem.fx_name', Update: '=SingleInput.Text' }, [
        control('SingleContainer', 'GroupContainer@1.3.0', { Width: '=320', Height: '=50' }, [control('SingleInput', 'Classic/TextInput@2.3.2', { AccessibleLabel: '="Invented single"', Default: '=selectedDraft.fx_name', MaxLength: '=100', Width: '=300', Height: '=40' })]),
      ]),
      control('MultiCard', 'TypedDataCard@1.0.7', { DataField: '="fx_comment"', Default: '=ThisItem.fx_comment', Update: '=MultiInput.Text' }, [
        control('MultiContainer', 'GroupContainer@1.3.0', { Width: '=320', Height: '=120', Y: '=60' }, [control('MultiInput', 'Classic/TextInput@2.3.2', { AccessibleLabel: '="Invented multiline"', Default: '=selectedDraft.fx_comment', Mode: '=TextMode.MultiLine', MaxLength: '=2000', Width: '=300', Height: '=100' })]),
      ]),
    ]),
    control('CancelDraft', 'Classic/Button@2.2.0', { Text: '="Cancel draft"', OnSelect: '=If(IsBlank(SingleInput.Text) && IsBlank(MultiInput.Text), Back(), Navigate(Confirmation))', Y: '=200' }),
  ] } } }),
  'Src/Confirmation.pa.yaml': stringify({ Screens: { Confirmation: { Children: [
    control('ConfirmLabel', 'Label@2.5.1', { Text: '="Discard invented changes?"' }),
    control('KeepDraft', 'Classic/Button@2.2.0', { Text: '="Keep editing"', OnSelect: '=Back()', Y: '=50' }),
    control('DiscardDraft', 'Classic/Button@2.2.0', { Text: '="Discard draft"', OnSelect: '=Navigate(Home)', Y: '=100' }),
  ] } } }),
};

export const canvasDraftInputFixture = { single: 'Invented Łódź + & =', multi: 'Invented first line\nSecond line <tag> & café' };
