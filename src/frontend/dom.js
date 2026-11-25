// Minimal DOM helpers. The console is a handful of forms and tables, so plain
// elements keep the bundle tiny and the CSS an exact match for the original.

/**
 * @param {string} tag
 * @param {object} [props] class/text/html/attrs/on plus any direct property.
 * @param {Array}  [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'attrs') {
      for (const [name, attr] of Object.entries(value)) {
        if (attr !== null && attr !== undefined && attr !== false) {
          node.setAttribute(name, String(attr));
        }
      }
    } else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) {
        node.addEventListener(event, handler);
      }
    } else {
      node[key] = value;
    }
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }

  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function spinner(label = 'Loading…') {
  return el('div', { class: 'wrm-spinner-row' }, [el('span', { class: 'wrm-spinner' }), label]);
}

export function badge(text, tone) {
  return el('span', { class: `wrm-badge wrm-badge--${tone}`, text });
}

/** A <select> bound to `options` with the current value preselected. */
export function select({ value, options, onChange, invalid, id, ariaDescribedBy }) {
  const node = el('select', {
    class: 'wrm-select',
    id,
    attrs: {
      'aria-invalid': invalid ? 'true' : null,
      'aria-describedby': ariaDescribedBy,
    },
    on: { change: (event) => onChange(event.target.value) },
  });

  for (const option of options) {
    node.append(
      el('option', {
        value: String(option.value),
        text: option.label,
        selected: String(option.value) === String(value),
      }),
    );
  }

  // Safari/Firefox occasionally ignore `selected` on freshly built nodes.
  node.value = String(value ?? '');
  return node;
}

export function fieldError(message, id) {
  return message ? el('p', { class: 'wrm-error', text: message, id, attrs: { role: 'alert' } }) : null;
}

export function toggle({ checked, onChange, label, disabled }) {
  return el('span', { class: 'wrm-toggle' }, [
    el('input', {
      type: 'checkbox',
      checked,
      disabled,
      attrs: { 'aria-label': label },
      on: { change: (event) => onChange(event.target.checked) },
    }),
    el('span', { class: 'wrm-toggle__track' }),
  ]);
}

/**
 * Project avatar with an initials fallback.
 *
 * Several project avatar URLs on a real site return 404, which left the old
 * table showing broken-image glyphs.
 */
export function projectAvatar(project) {
  const initials = String(project.key ?? '?')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 2);

  const fallback = () =>
    el('span', {
      class: 'wrm-avatar wrm-avatar--fallback',
      text: initials || '?',
      attrs: { 'aria-hidden': 'true' },
    });

  if (!project.avatarUrl) return fallback();

  const img = el('img', {
    class: 'wrm-avatar',
    src: project.avatarUrl,
    alt: '',
    loading: 'lazy',
    attrs: { width: 20, height: 20 },
  });

  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

/** Inline confirm strip. Native confirm() is unreliable inside the Forge iframe. */
export function confirmBar({ message, confirmLabel, onConfirm, onCancel, tone = 'amber' }) {
  return el('div', { class: `wrm-banner wrm-banner--${tone}` }, [
    el('div', { class: 'wrm-banner__title' }, ['⚠', ' Confirm']),
    el('div', { text: message }),
    el('div', { class: 'wrm-actions' }, [
      el('button', {
        type: 'button',
        class: 'wrm-btn',
        text: confirmLabel,
        on: { click: onConfirm },
      }),
      el('button', {
        type: 'button',
        class: 'wrm-btn wrm-btn--subtle',
        text: 'Cancel',
        on: { click: onCancel },
      }),
    ]),
  ]);
}
