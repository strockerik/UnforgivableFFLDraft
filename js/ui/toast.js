// Transient "drafted X → Team" notice with an inline Undo.
//
// The safety net that makes a mis-click cheap. It exists whether or not the
// confirmation dialog is enabled: a confirm catches the wrong player before
// the fact, undo catches it after, and the two failure modes are different —
// you can confirm a pick and only then notice it went to the wrong team.

import { el, mount } from './dom.js';
import { undo, canUndo } from '../state.js';

let host = null;
let timer = null;

function ensureHost() {
  if (host && document.body.contains(host)) return host;
  host = document.createElement('div');
  host.className = 'toast-host';
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

export function toast(message, ms = 6000) {
  const node = ensureHost();
  clearTimeout(timer);
  mount(node,
    el('div', { class: 'toast' },
      el('span', { class: 'toast-msg' }, message),
      canUndo()
        ? el('button', {
            class: 'toast-undo',
            onclick: () => { undo(); dismiss(); },
          }, 'Undo')
        : null,
      el('button', { class: 'toast-x', title: 'Dismiss', onclick: dismiss }, '×'),
    ));
  timer = setTimeout(dismiss, ms);
}

export function dismiss() {
  clearTimeout(timer);
  if (host) mount(host);
}
