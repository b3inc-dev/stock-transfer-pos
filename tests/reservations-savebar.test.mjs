/* global globalThis */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
test('shared save bar discards controlled state without submitting and saves exactly once', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reservation-savebar-'));
  const output = path.join(dir, 'test.mjs');
  await build({ stdin: { contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{SaveBar}from'${path.resolve('app/components/admin-ui.tsx')}';let root;function App(){const[value,setValue]=useState('saved');return <form><input name="layout" value={value} readOnly/><button type="button" onClick={()=>setValue('draft')}>変更</button><SaveBar onDiscard={()=>setValue('saved')}/></form>};export function mount(){root=createRoot(document.body);root.render(<App/>)}export function unmount(){root.unmount()}`, resolveDir: path.resolve('.'), loader: 'jsx' }, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', outfile: output, plugins: [{ name: 'bridge', setup(builder) { builder.onResolve({ filter: /^@shopify\/app-bridge-react$/ }, () => ({ path: 'bridge', namespace: 'mock' })); builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `import React from 'react';export const SaveBar=({children})=><div>{children}</div>;export const useAppBridge=()=>({toast:{show(){}}});`, loader: 'jsx', resolveDir: path.resolve('.') })); } }] });
  const { window } = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node });
  window.requestAnimationFrame = callback => setTimeout(callback, 0);
  const NativeFormData = globalThis.FormData;
  globalThis.FormData = class { constructor(form) { this.entries = [...form.querySelectorAll('input[name]')].map(input => [input.name, input.value]); } [Symbol.iterator]() { return this.entries[Symbol.iterator](); } };
  const ui = await import(pathToFileURL(output).href);
  const pause = () => new Promise(resolve => setTimeout(resolve, 60));
  try {
    ui.mount(); await pause();
    const form = document.querySelector('form'); let submitted = 0;
    form.reportValidity = () => true;
    form.requestSubmit = () => { submitted++; form.dispatchEvent(new window.Event('submit')); };
    form.reset = () => { form.dispatchEvent(new window.Event('reset')); };
    const click = async text => { const button = [...form.querySelectorAll('button')].find(item => item.textContent === text); assert.ok(button); if(text !== '変更') assert.equal(button.type, 'button'); const event = new window.Event('click', { bubbles: true, cancelable: true }); button.dispatchEvent(event); if(text !== '変更') assert.equal(event.defaultPrevented, true); await pause(); };
    await click('変更'); assert.equal(form.querySelector('input').value, 'draft');
    await click('破棄'); assert.equal(form.querySelector('input').value, 'saved'); assert.equal(submitted, 0);
    await click('変更'); await click('保存'); assert.equal(submitted, 1); assert.equal(form.querySelector('input').value, 'draft');
  } finally { ui.unmount(); globalThis.FormData = NativeFormData; }
});
