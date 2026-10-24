/** Model-driven tools attach to the canonical Lense panel; this module owns no alternate chrome. */
export function modelDrivenInspectorUi(data) {
  if (location.origin !== data.origin || window.__paqviloRetiredModelInspectors?.includes(data.token)) return;
  const host = document.getElementById('paqvilo-panel');
  if (!host?.shadowRoot || host.__pp?.token !== data.token) return;
  if (host.__paqModelInspector?.token === data.token) return;
  host.__paqModelInspector?.dispose();
  host.__paqModelInspector = {
    token: data.token,
    closePanel() {
      host.__pp?.collapse();
    },
    dispose() {
      host.__paqModelWatch?.dispose?.();
      host.__paqModelActions?.dispose?.();
      host.__paqModelCommands?.dispose?.();
      host.__pp?.dispose();
    },
  };
}
