import { z } from 'zod';
import { requireSecureUrl } from '../../protocol/src/index.js';

export function runtimeBase(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid runtime URL');
  return url.href.replace(/\/$/, '');
}
const destinationSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(200).refine(value => !value.startsWith('profile:'), 'Model names cannot start with profile:'),
  runtimeUrl: z.string().transform((value, context) => {
    try { return runtimeBase(value); } catch { context.addIssue({ code: 'custom', message: 'Invalid runtime URL' }); return z.NEVER; }
  }),
  runtimeKey: z.string().max(8192).optional(),
  kind: z.enum(['local', 'cloud']),
  cloudApproved: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.kind === 'cloud') {
    try { requireSecureUrl(value.runtimeUrl); } catch { context.addIssue({ code: 'custom', message: 'Cloud endpoints require HTTPS (except localhost)' }); }
  }
});
export const routingSchema = z.object({
  destinations: z.array(destinationSchema).min(1).max(32),
  profiles: z.object({ fast: z.string().optional(), quality: z.string().optional(), vision: z.string().optional(), cloud: z.string().optional() }).strict(),
}).superRefine((routing, context) => {
  const ids = new Set(routing.destinations.map(destination => destination.id));
  if (ids.size !== routing.destinations.length) context.addIssue({ code: 'custom', message: 'Destination ids must be unique' });
  for (const [profile, id] of Object.entries(routing.profiles)) {
    if (id === undefined) continue;
    if (!ids.has(id)) context.addIssue({ code: 'custom', message: `Unknown destination for profile ${profile}` });
    if (profile === 'cloud' && routing.destinations.find(destination => destination.id === id)?.kind !== 'cloud') context.addIssue({ code: 'custom', message: 'The cloud profile requires a cloud destination' });
  }
});
export type Routing = z.infer<typeof routingSchema>;
export type Destination = Routing['destinations'][number];
export class RoutingError extends Error {}
export function effectiveRouting(config: { runtimeUrl: string; models: string[]; runtimeKey?: string | undefined; routing?: Routing | undefined }): Routing {
  if (config.routing) return config.routing;
  return routingSchema.parse({
    destinations: config.models.map((model, index) => ({ id: `primary-${index}`, name: model, model, runtimeUrl: config.runtimeUrl, kind: 'local', ...(config.runtimeKey ? { runtimeKey: config.runtimeKey } : {}) })),
    profiles: { fast: 'primary-0', quality: 'primary-0' },
  });
}
export function resolveDestination(model: string, routing: Routing): Destination {
  let destination: Destination | undefined;
  if (model.startsWith('profile:')) {
    const profile = model.slice('profile:'.length);
    const id = Object.entries(routing.profiles).find(([name]) => name === profile)?.[1];
    destination = routing.destinations.find(value => value.id === id);
    if (!destination) throw new RoutingError('Profile is not configured on this device');
  } else {
    const matches = routing.destinations.filter(value => value.model === model);
    if (matches.length > 1) throw new RoutingError('Model matches multiple destinations; use a profile');
    destination = matches[0];
    if (!destination) throw new RoutingError('Model is not allowed on this device');
  }
  if (destination.kind === 'cloud' && !destination.cloudApproved) throw new RoutingError('Cloud destination requires explicit approval on this device');
  return destination;
}
