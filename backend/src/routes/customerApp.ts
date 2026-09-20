import { z } from 'zod';
import { Router, ok } from '../utils/router';
import { parseBody, parseParams } from '../middleware/validation';
import { assertCustomerAccess, requireCustomerLinks } from '../middleware/auth';
import {
  commitments as commitmentRepo,
  customers as customerRepo,
  orders as orderRepo,
  payments as paymentRepo,
  transactions as transactionRepo,
  vendors,
} from '../services/repository';
import { settlementByTransaction, settlementOf } from '../services/ledger';
import { answerQuestion } from '../services/knowledgeBase';
import { notFound } from '../utils/errors';
import { monthRange, withinRange } from '../utils/dates';
import { SearchRequestSchema } from '../schemas/requests';

/**
 * The customer application.
 *
 * A customer is a customer of several shops, so the tenancy question is
 * inverted: instead of "which shop is this user?", it is "which (shop,
 * customer) pairs has this user proved they own?". `requireCustomerLinks`
 * answers that from link rows, and every read below is confined to them.
 *
 * A customer can therefore never enumerate a shop's other customers, and a
 * customerId in a URL is worthless without a matching link.
 */

export const customerAppRoutes = new Router();

customerAppRoutes.get('/home', async (ctx) => {
  const { links } = await requireCustomerLinks(ctx);

  if (links.length === 0) {
    return ok({
      shops: [],
      summary: { shopCount: 0, transactionCount: 0, pending: 0, spentThisMonth: 0 },
      message: 'Scan your card at any Vyapio shop to link your first shop.',
    });
  }

  const month = monthRange();

  const shops = await Promise.all(
    links.map(async (link) => {
      const [vendor, customer, sales, customerOrders] = await Promise.all([
        vendors.get(link.vendorId),
        customerRepo.get(link.vendorId, link.customerId),
        transactionRepo.listForCustomer(link.customerId, 100),
        orderRepo.listForCustomer(link.customerId, 20),
      ]);

      // GSI2 is keyed by customer, so re-scope to this shop.
      const scopedSales = sales.filter((sale) => sale.vendorId === link.vendorId);
      const scopedOrders = customerOrders.filter((order) => order.vendorId === link.vendorId);

      return {
        vendorId: link.vendorId,
        customerId: link.customerId,
        shopName: vendor?.shopName ?? 'Shop',
        category: vendor?.category ?? 'other',
        city: vendor?.city ?? '',
        outstanding: customer?.outstanding ?? 0,
        transactionCount: scopedSales.length,
        spentThisMonth: scopedSales
          .filter((sale) => withinRange(sale.timestamp, month))
          .reduce((sum, sale) => sum + sale.total, 0),
        readyOrders: scopedOrders.filter((order) => order.status === 'ready').length,
        lastVisitAt: scopedSales[0]?.timestamp ?? null,
      };
    }),
  );

  return ok({
    shops,
    summary: {
      shopCount: shops.length,
      transactionCount: shops.reduce((sum, shop) => sum + shop.transactionCount, 0),
      pending: shops.reduce((sum, shop) => sum + Math.max(0, shop.outstanding), 0),
      spentThisMonth: shops.reduce((sum, shop) => sum + shop.spentThisMonth, 0),
      readyOrders: shops.reduce((sum, shop) => sum + shop.readyOrders, 0),
    },
  });
});

const ShopParams = z.object({
  vendorId: z.string().min(1),
  customerId: z.string().min(1),
});

/** One shop's history, gated by an explicit link check. */
customerAppRoutes.get('/shops/:vendorId/:customerId', async (ctx) => {
  const { vendorId, customerId } = parseParams(ctx, ShopParams);
  await assertCustomerAccess(ctx, vendorId, customerId);

  const [vendor, customer, sales, receipts, debts, customerOrders] = await Promise.all([
    vendors.get(vendorId),
    customerRepo.get(vendorId, customerId),
    transactionRepo.listForCustomer(customerId, 100),
    paymentRepo.listForCustomer(customerId, 50),
    commitmentRepo.listForCustomer(customerId, 50),
    orderRepo.listForCustomer(customerId, 30),
  ]);

  if (!vendor || !customer) throw notFound('shop');

  const scope = <T extends { vendorId: string }>(rows: T[]) =>
    rows.filter((row) => row.vendorId === vendorId);

  // Same live balance the shopkeeper sees. A customer being shown a bill they
  // have already cleared is the same lie from the other side of the counter.
  const settlement = settlementByTransaction(scope(debts));
  const scopedSales = scope(sales).map((transaction) => ({
    ...transaction,
    ...settlementOf(transaction, settlement),
  }));

  return ok({
    shop: {
      vendorId,
      shopName: vendor.shopName,
      category: vendor.category,
      city: vendor.city,
    },
    // Only this customer's own fields — never the shop's other customers.
    profile: {
      customerId: customer.customerId,
      name: customer.name,
      outstanding: customer.outstanding,
      totalSpent: customer.totalSpent,
      transactionCount: customer.transactionCount,
    },
    transactions: scopedSales,
    payments: scope(receipts),
    commitments: scope(debts).filter(
      (commitment) => commitment.status === 'open' || commitment.status === 'partly_paid',
    ),
    orders: scope(customerOrders).filter((order) => order.status !== 'cancelled'),
  });
});

/** A single receipt, rendered as a premium digital bill in the client. */
customerAppRoutes.get('/receipt/:vendorId/:customerId/:transactionId', async (ctx) => {
  const params = parseParams(
    ctx,
    ShopParams.extend({ transactionId: z.string().min(1) }),
  );
  await assertCustomerAccess(ctx, params.vendorId, params.customerId);

  const [vendor, transaction] = await Promise.all([
    vendors.get(params.vendorId),
    transactionRepo.findById(params.vendorId, params.transactionId),
  ]);

  // Belongs-to check: a transactionId from the same shop but another customer
  // is not readable here.
  if (!transaction || transaction.customerId !== params.customerId) {
    throw notFound('receipt');
  }

  return ok({
    shopName: vendor?.shopName ?? 'Shop',
    city: vendor?.city ?? '',
    transaction,
  });
});

/**
 * Customer-side memory search.
 *
 * Reuses the same grounded retrieval as the shopkeeper's Shop Memory, scoped to
 * one (shop, customer) pair. The question is answered across only the records
 * this user is allowed to see.
 */
customerAppRoutes.post('/ask', async (ctx) => {
  const { links } = await requireCustomerLinks(ctx);
  const input = parseBody(
    ctx,
    SearchRequestSchema.extend({ vendorId: z.string().optional() }),
  );

  if (links.length === 0) {
    return ok({
      result: {
        question: input.question,
        answer: 'Link a shop first, then I can answer questions about your purchases.',
        grounded: false,
        citations: [],
        engine: 'local-retrieval',
      },
    });
  }

  // Default to the shop with the largest balance — most questions are about it.
  const targets = input.vendorId
    ? links.filter((link) => link.vendorId === input.vendorId)
    : links;
  if (targets.length === 0) throw notFound('shop');

  const answers = await Promise.all(
    targets.slice(0, 5).map(async (link) => {
      const [vendor, answer] = await Promise.all([
        vendors.get(link.vendorId),
        answerQuestion({
          vendorId: link.vendorId,
          question: input.question,
          scopedCustomerId: link.customerId,
        }),
      ]);
      return { shopName: vendor?.shopName ?? 'Shop', answer };
    }),
  );

  const grounded = answers.filter((entry) => entry.answer.grounded);

  if (grounded.length === 0) {
    return ok({
      result: {
        question: input.question,
        answer: "I couldn't find enough information in your shop records.",
        grounded: false,
        citations: [],
        engine: answers[0]?.answer.engine ?? 'local-retrieval',
      },
    });
  }

  // Answers from several shops are labelled by shop rather than merged, so the
  // customer can see which balance belongs where.
  return ok({
    result: {
      question: input.question,
      answer:
        grounded.length === 1
          ? grounded[0]!.answer.answer
          : grounded.map((entry) => `${entry.shopName}: ${entry.answer.answer}`).join('\n'),
      grounded: true,
      citations: grounded.flatMap((entry) => entry.answer.citations).slice(0, 20),
      engine: grounded[0]!.answer.engine,
    },
  });
});
