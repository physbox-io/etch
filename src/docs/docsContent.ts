/**
 * The Reference Guide's table of contents.
 *
 * Kept apart from the modal that renders it so the store can hold the open tab
 * without importing JSX, and so an (i) button anywhere in the app can deep-link
 * to a panel's explainer by id.
 */
export const DOCS_TABS = [
  {
    group: 'User Interface',
    items: [
      { id: 'selection', label: '🖱️ Selecting & Moving' },
      { id: 'shortcuts', label: '⌨️ Keyboard Shortcuts' },
    ],
  },
  {
    group: 'Design',
    items: [
      { id: 'workspace', label: '🖥️ Stock, Layers & Units' },
      { id: 'text', label: '🔤 Text & Vectorizing' },
      { id: 'fill', label: '🪡 Engrave Fill & Hatch' },
      { id: 'import', label: '📥 SVG Import' },
    ],
  },
  {
    group: 'Fabrication',
    items: [
      { id: 'toolpaths', label: '🛠️ Toolpaths & G-Code' },
      { id: 'zeroing', label: '🎯 Machine Setup & Zeroing' },
      { id: 'levelling', label: '📐 Bed Levelling' },
    ],
  },
  {
    group: 'Automation',
    items: [{ id: 'mcp', label: '🤖 AI & MCP Bridge' }],
  },
  {
    group: 'Legal & Terms',
    items: [{ id: 'license', label: '⚖️ License & Disclaimers' }],
  },
] as const;

export type DocsTabId = (typeof DOCS_TABS)[number]['items'][number]['id'];
