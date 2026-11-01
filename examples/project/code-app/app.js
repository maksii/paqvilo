import { configure, getContext, dataClient } from 'paqvilo/mirage/lib/code-apps-client.js';
configure({ app: 'invented-items' });
// This project-owned adapter has the same method names as a generated service; it is not one.
const Items = {
  getAll: () => dataClient.getAll('x_items'),
  create: (row) => dataClient.create('x_items', row),
  update: (id, changes) => dataClient.update('x_items', id, changes),
  delete: (id) => dataClient.delete('x_items', id),
};
const status = document.querySelector('#status');
const showError = (error) => {
  status.textContent = `${error.code || 'Error'}: ${error.message}`;
};
async function refresh() {
  const { data } = await Items.getAll();
  const list = document.querySelector('#items');
  list.replaceChildren();
  for (const item of data) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = item.x_name;
    const rename = document.createElement('button');
    rename.textContent = 'Rename';
    rename.onclick = async () => {
      try {
        await Items.update(item.x_itemid, { x_name: item.x_name + ' updated' });
        await refresh();
      } catch (error) {
        showError(error);
      }
    };
    const remove = document.createElement('button');
    remove.textContent = 'Delete';
    remove.onclick = async () => {
      try {
        await Items.delete(item.x_itemid);
        await refresh();
      } catch (error) {
        showError(error);
      }
    };
    li.append(label, ' ', rename, ' ', remove);
    list.append(li);
  }
}
document.querySelector('#create').onsubmit = async (event) => {
  event.preventDefault();
  try {
    await Items.create({ x_name: event.target.elements.name.value });
    event.target.reset();
    await refresh();
  } catch (error) {
    showError(error);
  }
};
document.querySelector('#connector').onclick = async () => {
  try {
    const result = await dataClient.execute('sample-connector', 'Example', {});
    status.textContent = `Simulated connector: ${JSON.stringify(result.data)}`;
  } catch (error) {
    showError(error);
  }
};
try {
  const context = await getContext();
  document.querySelector('#context').textContent = `Signed in locally as ${context.user.fullName}`;
  await refresh();
} catch (error) {
  showError(error);
}
