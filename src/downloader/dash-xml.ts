export function dashChildren(element: Element, name: string): Element[] {
  return Array.from(element.children).filter((child) => child.localName === name);
}

export function dashChild(element: Element, name: string): Element | null {
  return dashChildren(element, name)[0] ?? null;
}

export function dashNumber(element: Element | null, name: string): number | undefined {
  const raw = element?.getAttribute(name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function dashBase(parent: string, element: Element): string {
  const text = dashChild(element, 'BaseURL')?.textContent?.trim();
  return text ? new URL(text, parent).href : parent;
}
