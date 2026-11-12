/**
 * In-page script that stamps interactive / text-bearing elements with data-dbg-ref and
 * returns a compact digest. Runs in the page context (string so it needs no bundling).
 * Password values are never read.
 */
export const MAX_ELEMENTS = 300;
export const MAX_TEXT = 200;

export const DIGEST_SCRIPT = `(({max, maxText}) => {
  document.querySelectorAll('[data-dbg-ref]').forEach((e) => e.removeAttribute('data-dbg-ref'));
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[onclick],[contenteditable=""],[contenteditable="true"],h1,h2,h3,label';
  const vh = window.innerHeight;
  const all = Array.from(document.querySelectorAll(sel));
  const vis = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    vis.push({ el, r });
  }
  // viewport-first, then document order
  vis.sort((a, b) => (Math.abs(a.r.top) < vh ? 0 : 1) - (Math.abs(b.r.top) < vh ? 0 : 1));
  const out = [];
  for (const { el, r } of vis.slice(0, max)) {
    const ref = out.length;
    el.setAttribute('data-dbg-ref', String(ref));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, maxText);
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (el.labels && el.labels[0] && el.labels[0].innerText) || text || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, maxText);
    const o = { ref, tag: type ? tag + '[' + type + ']' : tag, role: el.getAttribute('role') || '', name, text: (tag === 'input' || tag === 'textarea' || tag === 'select') ? '' : text, box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (type !== 'password' && type !== 'hidden') o.value = String(el.value || '').slice(0, maxText);
      if (type === 'checkbox' || type === 'radio') o.checked = !!el.checked;
    }
    if (el.disabled) o.disabled = true;
    out.push(o);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 4000);
  return { elements: out, text };
})`;
