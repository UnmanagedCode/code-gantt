// The single DOM sink. Every node is built with createElement(NS) + setAttribute + createTextNode.
// Attributes that can carry script or load URLs are refused; there is no HTML-string path.

const SVG_NS = 'http://www.w3.org/2000/svg';
const REFUSED_ATTR = /^on/i;
// `src` as a prefix also covers the srcdoc and srcset variants.
const REFUSED_NAMES = /^(style|href|src|xlink:href)/i;
const REFUSED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'img', 'link', 'base']);

function build(node, attrs, children) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (REFUSED_ATTR.test(k) || REFUSED_NAMES.test(k)) throw new Error(`dom: attribute "${k}" is not allowed`);
    if (v == null || v === false) continue;
    node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function refuseTag(tag) {
  if (REFUSED_TAGS.has(tag.toLowerCase())) throw new Error(`dom: element "${tag}" is not allowed`);
}

export function el(tag, attrs, ...children) {
  refuseTag(tag);
  return build(document.createElement(tag), attrs, children);
}

export function svgEl(tag, attrs, ...children) {
  refuseTag(tag);
  return build(document.createElementNS(SVG_NS, tag), attrs, children);
}

export const text = (s) => document.createTextNode(String(s));

export function listen(node, type, fn) {
  node.addEventListener(type, fn);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
