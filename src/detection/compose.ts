import { Collector, yaml, object } from './shared.js';

export function compose(c: Collector, text: string): void {
  const document = yaml(text, 'compose');
  if (document.services == null) return;
  for (const service of Object.values(object(document.services))) {
    if (service && typeof service === 'object' && typeof service.image === 'string') c.image(service.image, 'docker');
  }
}
