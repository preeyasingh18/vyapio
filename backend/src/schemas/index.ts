/**
 * Barrel for the shared schema layer.
 *
 * The frontend imports from here through the `@shared` alias, so backend and
 * browser agree on one definition of every entity, request and AI contract.
 * Keep this directory free of runtime dependencies other than zod.
 */
export * from './common';
export * from './entities';
export * from './ai';
export * from './requests';
