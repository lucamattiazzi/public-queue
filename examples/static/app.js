// Copy dist/packages/sdk/index.js alongside this file as sdk.js.
// Host this SDK copy independently of the queue operator if that operator is in your threat model.
import { PublicQueue } from './sdk.js';
const $ = id => document.getElementById(id);
let queue;
const showError = error => { $('status').textContent = error.message; };
async function follow(id) {
  const result = await queue.wait(id, { onUpdate: job => { $('status').textContent = `${job.status} · ${job.id}`; } });
  $('output').textContent = result.text;
}
$('connect').onsubmit = async event => {
  event.preventDefault();
  try {
    queue = new PublicQueue({ ...JSON.parse($('connection').value), encrypted: true });
    await queue.list();
    $('send').disabled = false; $('resume').disabled = false;
    $('status').textContent = 'Connected. Encrypted jobs are ready.';
  } catch (error) { showError(error); }
};
$('chat').onsubmit = async event => {
  event.preventDefault(); $('send').disabled = true;
  try {
    const job = await queue.submit({ model: $('model').value, messages: [{ role: 'user', content: $('prompt').value }] });
    localStorage.setItem('last-job', job.id);
    await follow(job.id);
  } catch (error) { showError(error); }
  finally { $('send').disabled = false; }
};
$('resume').onclick = () => { const id = localStorage.getItem('last-job'); if (id) void follow(id).catch(showError); };
