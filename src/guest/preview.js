// Rendered, sanitized view of the shared Markdown. Shared content is untrusted:
// marked passes raw HTML through, so everything goes through DOMPurify before it
// touches the DOM. CSP (script-src 'self', img-src 'self' data:) is the second layer;
// it also keeps remote images from pinging third parties.
import { Marked } from 'marked'
import DOMPurify from 'dompurify'

const marked = new Marked({ gfm: true, breaks: false })

const purify = DOMPurify(window)
purify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    // Navigating this tab away would drop the live session.
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
  if (node.tagName === 'INPUT') node.setAttribute('disabled', '') // GFM task-list checkboxes
})

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true }, // no SVG / MathML
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style'],
  RETURN_DOM_FRAGMENT: true
}

/** Markdown -> sanitized DocumentFragment. */
export function renderMarkdown (src) {
  return purify.sanitize(marked.parse(src, { async: false }), PURIFY_CONFIG)
}

/**
 * Keeps `el` in sync with `ytext` while visible. Re-renders at most once per frame.
 * @param {HTMLElement} el
 * @param {import('yjs').Text} ytext
 */
export function livePreview (el, ytext) {
  let visible = false
  let queued = false
  const render = () => {
    queued = false
    if (visible) el.replaceChildren(renderMarkdown(ytext.toString()))
  }
  const schedule = () => {
    if (visible && !queued) {
      queued = true
      requestAnimationFrame(render)
    }
  }
  ytext.observe(schedule)
  return {
    setVisible (v) {
      visible = v
      if (v) render() // show current content immediately, not one frame late
    },
    destroy () {
      ytext.unobserve(schedule)
      visible = false
    }
  }
}
