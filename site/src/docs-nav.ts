// Docs navigation: groups in reading order. The slug is the path under /docs/.
export const DOCS_NAV = [
  { group: "Getting started", items: [
    { slug: "", label: "Introduction" },
    { slug: "quickstart", label: "Quickstart" },
    { slug: "authentication", label: "Authentication" },
  ]},
  { group: "Core resources", items: [
    { slug: "connections", label: "Connections" },
    { slug: "agents", label: "Agents" },
    { slug: "tools", label: "Tools" },
    { slug: "calls", label: "Calls" },
  ]},
  { group: "Events and logs", items: [
    { slug: "webhooks", label: "Webhooks" },
    { slug: "inbound", label: "Inbound calls" },
    { slug: "logs", label: "Logs and analytics" },
  ]},
  { group: "Self-hosting", items: [
    { slug: "self-hosting", label: "Overview" },
    { slug: "deploying", label: "Deploying" },
    { slug: "configuration", label: "Configuration" },
  ]},
  { group: "Reference", items: [
    { slug: "errors", label: "Errors and limits" },
  ]},
];

export const DOCS_FLAT = DOCS_NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));
export const docsHref = (slug: string) => (slug ? `/docs/${slug}/` : "/docs/");
