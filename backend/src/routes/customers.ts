import { z } from 'zod';
import { Router, ok, created } from '../utils/router';
import { parseBody, parseParams, parseQuery } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { customers as customerRepo, commitments as commitmentRepo } from '../services/repository';
import { publish } from '../services/events';
import { conflict, notFound } from '../utils/errors';
import { findCustomerByName } from '../services/customerMatch';
import { nowIso } from '../utils/dates';
import { newCustomerId, newQrId } from '../utils/ids';
import {
  CreateCustomerRequestSchema,
  ResolveScanRequestSchema,
  UpdateCustomerRequestSchema,
} from '../schemas/requests';
import { CustomerSchema, type Customer } from '../schemas/entities';
import { extractQrToken } from './auth';

/**
 * Customers — the memory layer.
 *
 * Every read is scoped by the vendorId resolved from the session, so a
 * customerId from another shop simply does not exist from this caller's
 * perspective. That is a 404, not a 403: confirming that an id is real
 * elsewhere would itself leak information.
 */

export const customerRoutes = new Router();

const CustomerIdParams = z.object({ customerId: z.string().min(1) });

customerRoutes.get('/', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const query = parseQuery(
    ctx,
    z.object({
      search: z.string().trim().max(80).optional(),
      /** 'owing' filters to customers with a balance — the collections view. */
      filter: z.enum(['all', 'owing', 'recent']).default('all'),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  );

  let list = await customerRepo.list(vendorId, query.limit);

  if (query.search) {
    const needle = query.search.toLowerCase();
    list = list.filter(
      (customer) =>
        customer.name.toLowerCase().includes(needle) || customer.phone.includes(needle),
    );
  }

  if (query.filter === 'owing') {
    list = list.filter((customer) => customer.outstanding > 0);
    list.sort((a, b) => b.outstanding - a.outstanding);
  } else if (query.filter === 'recent') {
    list.sort((a, b) => (b.lastInteractionAt ?? '').localeCompare(a.lastInteractionAt ?? ''));
  } else {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * How much of each balance is already late.
   *
   * `outstanding` alone does not tell a shopkeeper who to chase — ₹1,000 owed
   * on a bill due next week is not the same debt as ₹1,000 that went past its
   * date a fortnight ago. One pass over the open commitments gives the split,
   * and the list can then show overdue in red for the customers who need it.
   */
  const open = (await commitmentRepo.list(vendorId)).filter(
    (commitment) => commitment.status === 'open' || commitment.status === 'partly_paid',
  );

  const now = nowIso();
  const overdueByCustomer = new Map<string, { amount: number; count: number }>();
  for (const commitment of open) {
    if (commitment.dueDate >= now) continue;
    const remaining = commitment.amount - commitment.settledAmount;
    if (remaining <= 0) continue;

    const entry = overdueByCustomer.get(commitment.customerId) ?? { amount: 0, count: 0 };
    entry.amount += remaining;
    entry.count += 1;
    overdueByCustomer.set(commitment.customerId, entry);
  }

  const withOverdue = list.map((customer) => {
    const entry = overdueByCustomer.get(customer.customerId);
    return {
      ...customer,
      overdueAmount: entry?.amount ?? 0,
      overdueCount: entry?.count ?? 0,
    };
  });

  return ok({
    customers: withOverdue,
    totals: {
      count: list.length,
      outstanding: list.reduce((sum, customer) => sum + Math.max(0, customer.outstanding), 0),
      overdue: withOverdue.reduce((sum, customer) => sum + customer.overdueAmount, 0),
      overdueCount: withOverdue.filter((customer) => customer.overdueAmount > 0).length,
    },
  });
});

customerRoutes.post('/', async (ctx) => {
  const { vendorId, auth } = await requireVendor(ctx);
  const input = parseBody(ctx, CreateCustomerRequestSchema);

  // Phone is the shop's natural key for a person; a duplicate is almost always
  // a mistake, and silently creating a second profile splits their history.
  if (input.phone) {
    const existing = await customerRepo.findByPhone(vendorId, input.phone);
    if (existing) {
      throw conflict(
        `Customer with phone ${input.phone} already exists`,
        `${existing.name} is already saved with that number.`,
      );
    }
  }

  const customer: Customer = CustomerSchema.parse({
    customerId: newCustomerId(),
    vendorId,
    name: input.name,
    phone: input.phone,
    whatsappPhone: input.whatsappPhone,
    whatsappOptIn: input.whatsappOptIn,
    email: input.email,
    // Reuse the scanned token when creating from an unrecognised QR, so the
    // card the customer already holds keeps working.
    qrId: input.qrId ? extractQrToken(input.qrId) : newQrId(),
    outstanding: 0,
    totalSpent: 0,
    transactionCount: 0,
    notes: input.notes,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } satisfies Customer);

  await customerRepo.put(customer);

  await publish(
    'CustomerCreated',
    vendorId,
    { customerId: customer.customerId, name: customer.name },
    `CustomerCreated:${customer.customerId}`,
  );

  ctx.logger.info('customer created', {
    operation: 'customers.create',
    vendorId,
    userId: auth.userId,
  });

  return created({ customer, message: 'Memory created.' });
});

customerRoutes.get('/:customerId', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const { customerId } = parseParams(ctx, CustomerIdParams);
  const customer = await customerRepo.get(vendorId, customerId);
  if (!customer) throw notFound('customer');
  return ok({ customer });
});

customerRoutes.patch('/:customerId', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const { customerId } = parseParams(ctx, CustomerIdParams);
  const input = parseBody(ctx, UpdateCustomerRequestSchema);

  // Existence is confirmed inside this tenant before any write.
  await customerRepo.require(vendorId, customerId);
  const customer = await customerRepo.update(vendorId, customerId, input);
  return ok({ customer });
});

/**
 * Scanner resolution.
 *
 * Returns one of three outcomes and lets the UI decide: found, not found (so
 * offer to create), or ambiguous. The token is looked up *within this vendor*,
 * so another shop's card resolves to "not found" rather than to their customer.
 */
customerRoutes.post('/resolve', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const input = parseBody(ctx, ResolveScanRequestSchema);

  if (input.qrId) {
    const token = extractQrToken(input.qrId);
    const customer = await customerRepo.findByQrId(vendorId, token);
    if (customer) {
      ctx.logger.info('scan resolved', { operation: 'customers.resolve', vendorId, via: 'qr' });
      return ok({ found: true, customer, greeting: 'Got them! 👋' });
    }
    return ok({
      found: false,
      // Handed back so "Create customer" can bind the card they already have.
      qrId: token,
      greeting: 'Looks like someone new 👋',
    });
  }

  /**
   * By name, for the voice flow's confirm step.
   *
   * Asked immediately before a customer would be created, so the decision is
   * made against the book as it stands right then rather than against whatever
   * was true when the draft was first prepared.
   *
   * Several people can share a name, so this never picks one. It hands the
   * candidates back and lets the shopkeeper choose — merging two customers is
   * not something they can undo from the till.
   */
  if (input.name) {
    const match = await findCustomerByName(vendorId, input.name);

    if (match.kind === 'one') {
      ctx.logger.info('scan resolved', { operation: 'customers.resolve', vendorId, via: 'name' });
      return ok({ found: true, customer: match.customer, greeting: 'Got them! 👋' });
    }

    if (match.kind === 'many') {
      return ok({
        found: false,
        candidates: match.candidates.map((customer) => ({
          customerId: customer.customerId,
          name: customer.name,
          phone: customer.phone,
        })),
        greeting: `More than one customer is called ${input.name}`,
      });
    }

    return ok({ found: false, name: input.name, greeting: 'Looks like someone new 👋' });
  }

  const phone = (input.phone ?? '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) {
    return ok({ found: false, greeting: 'Enter a full 10-digit number' });
  }

  const customer = await customerRepo.findByPhone(vendorId, phone);
  if (customer) {
    ctx.logger.info('scan resolved', { operation: 'customers.resolve', vendorId, via: 'phone' });
    return ok({ found: true, customer, greeting: 'Got them! 👋' });
  }
  return ok({ found: false, phone, greeting: 'Looks like someone new 👋' });
});

/**
 * The customer's QR payload.
 *
 * A URL containing only the opaque token — no name, no phone, no balance. The
 * card is a pointer, and everything behind it requires an authenticated
 * session to read.
 */
customerRoutes.get('/:customerId/qr', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const { customerId } = parseParams(ctx, CustomerIdParams);
  const customer = await customerRepo.require(vendorId, customerId);

  return ok({
    qrId: customer.qrId,
    payload: `vyapio://c/${customer.qrId}`,
    customerName: customer.name,
  });
});
