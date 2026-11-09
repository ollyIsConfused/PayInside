// Minimales, sicheres HTML-Templating: Alle eingesetzten Werte werden escaped,
// außer sie sind mit raw() bzw. als verschachteltes html`` markiert.

export class SafeHtml {
  constructor(public readonly value: string) {}
  toString() {
    return this.value;
  }
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

export interface LayoutOptions {
  title: string;
  body: SafeHtml;
  nav?: SafeHtml;
  head?: SafeHtml;
  bodyClass?: string;
  description?: string;
}

export function layout(o: LayoutOptions): string {
  return html`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${o.title}</title>
<meta name="description" content="${o.description ?? 'Pay Inside – einscannen, in der App bezahlen, rausgehen. Ohne Kasse.'}">
<meta name="theme-color" content="#0f766e">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/css/app.css">
${o.head ?? ''}
</head>
<body class="${o.bodyClass ?? ''}">
${o.nav ?? ''}
${o.body}
</body>
</html>`.value;
}

export function euro(cents: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

export function dateTime(d: Date | string | null | undefined): string {
  if (!d) return '–';
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(
    new Date(d),
  );
}
